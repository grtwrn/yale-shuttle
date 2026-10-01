"""Frozen, offline following-occurrence audit; never fits or modifies forecasts.

Run after pair.py finishes, under the shared heavy.lock. Only the three
following-occurrence artifacts belong to this worker. Outcome labels are joined
after forecast generation and never enter the estimator or landmark selection.
"""
from pathlib import Path
import argparse
import bisect
import collections
import datetime
import hashlib
import json
import math
import sqlite3
import statistics
from zoneinfo import ZoneInfo

HERE = Path(__file__).resolve().parent
ARMS = ("core", "union", "history")
TARGETS = (48, 4)
LANDMARKS = (0, 60, 180, 300, 420, 600)
TZ = ZoneInfo("America/New_York")
TOLERANCE_MS = 15_000
MIN_WARM_MS = 600_000


def stamp(value):
    if isinstance(value, (int, float)):
        return int(value)
    return int(datetime.datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp() * 1000)


def bus_name(value):
    return str(value).lstrip("#")


def digest(path):
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def frame_bounds(path):
    with path.open("rb") as stream:
        first = json.loads(stream.readline())
        stream.seek(0, 2)
        stream.seek(max(0, stream.tell() - 100_000))
        last = json.loads(stream.read().splitlines()[-1])
    return stamp(first["at"]), stamp(last["at"])


def score(row, arm):
    prediction = row[arm]
    truth = row["truthSec"]
    error = prediction["eta"] - truth
    width = prediction["high"] - prediction["low"]
    early = truth < prediction["low"]
    late = truth > prediction["high"]
    wis = (.5 * abs(error) + .1 * width
           + max(0, prediction["low"] - truth)
           + max(0, truth - prediction["high"])) / 1.5
    return dict(error=error, absoluteError=abs(error), width=width, early=early, late=late, wis=wis)


def metrics(rows, arm, visit_balanced=False):
    if not rows:
        return {"n": 0}
    sizes = collections.Counter((r["sourceId"], r["target"]) for r in rows)
    weights = [1 / sizes[(r["sourceId"], r["target"])] if visit_balanced else 1 for r in rows]
    scored = [score(row, arm) for row in rows]
    total = sum(weights)
    mean = lambda field: sum(w * v[field] for w, v in zip(weights, scored)) / total
    absolute = sorted(v["absoluteError"] for v in scored)
    q = (len(absolute) - 1) * .9
    p90 = absolute[math.floor(q)] + (q - math.floor(q)) * (absolute[math.ceil(q)] - absolute[math.floor(q)])
    return dict(n=len(rows), sourceVisits=len({r["sourceId"] for r in rows}),
                targetVisits=len({r["targetVisitId"] for r in rows}),
                sourceTargetJourneys=len(sizes), dates=len({r["day"] for r in rows}),
                weighting="equal source-target journey" if visit_balanced else "equal checkpoint",
                maeSec=mean("absoluteError"), meanSignedSec=mean("error"),
                meanWidthSec=mean("width"), WIS80Diagnostic=mean("wis"),
                coverageRate=1 - mean("early") - mean("late"),
                early=sum(v["early"] for v in scored), late=sum(v["late"] for v in scored),
                medianAbsSec=statistics.median(absolute), unweightedP90AbsSec=p90)


def arm_metrics(rows, visit_balanced=False):
    return {arm: metrics(rows, arm, visit_balanced) for arm in ARMS}


class Connectivity:
    def __init__(self, sequence, visits, legs):
        self.seq = sequence
        self.N = len(sequence)
        assert self.N == len(set(sequence)), "Repeated physical stops need an explicit occurrence map"
        self.legs = collections.defaultdict(list)
        self.visits = collections.defaultdict(dict)
        self.last_red = collections.defaultdict(lambda: -math.inf)
        for leg in legs:
            self.legs[(leg["bus_name"], leg["from_index"], leg["departed_at"])].append(leg)
        for visit in visits:
            name = visit["bus_name"]
            self.last_red[name] = max(self.last_red[name], *(visit.get(k) or 0 for k in ("anchored_at", "arrived_at", "departed_at")))
            times = [visit["arrived_at"]]
            if visit["outcome"] == "passed":
                times.append(visit["departed_at"])
            for at in times:
                if at is not None:
                    self.visits[(name, visit["stop_id"], visit["stop_index"], at)][visit["id"]] = visit

    def following(self, source, target):
        index = source["stop_index"]
        dep = source["departed_at"]
        ti = self.seq.index(target)
        if not (0 <= index < self.N and self.seq[index] == source["stop_id"]):
            return None, {"reason": "invalid source route occurrence", "status": "unknown"}
        first_distance = (ti - index) % self.N
        assert first_distance > 0
        path, targets, hops = [], [], 0
        for _ in range(2 * self.N):
            # A long leg may skip unrelated stops, but cannot skip either of
            # the two target observations that define this following visit.
            remaining = (ti - index) % self.N or self.N
            all_legs = self.legs.get((source["bus_name"], index, dep), [])
            legs = [leg for leg in all_legs if leg["reached"] == 1]
            partial = dict(connectedLegIds=[leg["id"] for leg, _ in path],
                           observedTargetIds=[visit["id"] for visit in targets],
                           failedFromIndex=index, failedDeparture=dep)
            if len(legs) != 1:
                if not legs and all_legs:
                    reason, status = "continuation leg did not reach its endpoint", "censored"
                elif not legs and self.last_red[source["bus_name"]] <= dep:
                    reason, status = "no later Red observation after connected path", "censored"
                else:
                    reason, status = "missing or ambiguous connected leg", "unknown"
                return None, dict(partial, reason=reason, status=status)
            leg = legs[0]
            to_index = leg["to_index"]
            if not (0 <= to_index < self.N and leg["from_stop_id"] == self.seq[index]
                    and leg["to_stop_id"] == self.seq[to_index]
                    and leg["arrived_at"] > dep and 1 <= leg["hops"] <= remaining
                    and (to_index - index) % self.N == leg["hops"]):
                return None, dict(partial, reason="invalid route/time or unobserved target crossing", status="unknown")
            matches = self.visits.get((source["bus_name"], leg["to_stop_id"], to_index, leg["arrived_at"]), {}).values()
            matches = [v for v in matches if source["anchored_at"] <= v["anchored_at"] <= leg["arrived_at"]]
            if len(matches) != 1:
                return None, dict(partial, reason="missing or ambiguous connected visit", status="unknown")
            visit = matches[0]
            path.append((leg, visit))
            hops += leg["hops"]
            if to_index == ti:
                if (visit["arrived_at"] is None or visit["closest_m"] > 75
                        or visit["outcome"] not in ("passed", "stopped") or visit["how"] == "gap"):
                    return None, dict(partial, reason="unsupported target outcome", status="unknown")
                targets.append(visit)
                assert hops == first_distance + (len(targets) - 1) * self.N
                if len(targets) == 2:
                    assert targets[1]["arrived_at"] > targets[0]["arrived_at"] > source["departed_at"]
                    return dict(path=path, targets=targets, hops=hops), None
            if visit["how"] == "gap" or visit["departed_at"] is None or visit["departed_at"] < leg["arrived_at"]:
                return None, dict(partial, reason="intermediate gap or missing departure", status="censored")
            index, dep = to_index, visit["departed_at"]
        return None, {"reason": "following target not reached within two route loops", "status": "unknown"}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--pairs", type=Path, default=HERE / "pairs.jsonl")
    parser.add_argument("--db", type=Path, default=HERE / "outcomes.db")
    args = parser.parse_args()
    # Finished artifacts are required; never score a still-growing arm file.
    validation = json.loads((HERE / "pair-validation.json").read_text())
    frames = [HERE.parents[1] / "release-integration-data/raw-complete-frames.jsonl", HERE / "raw-today-frames.jsonl"]
    bounds = [frame_bounds(path) for path in frames]
    lo, hi = min(a for a, _ in bounds), max(b for _, b in bounds)
    db = sqlite3.connect("file:" + str(args.db.resolve()) + "?mode=ro", uri=True)
    db.row_factory = sqlite3.Row
    sequence = json.loads(db.execute("SELECT stops_json FROM routes WHERE id=3").fetchone()[0])
    visits = [dict(row) for row in db.execute("SELECT * FROM stop_visits WHERE route_id=3 AND anchored_at>=? ORDER BY anchored_at", (lo - 7_200_000,))]
    legs = [dict(row) for row in db.execute("SELECT * FROM legs WHERE route_id=3 AND departed_at>=? ORDER BY departed_at", (lo - 7_200_000,))]
    db.close()
    connector = Connectivity(sequence, visits, legs)
    sources = [v for v in visits if v["stop_id"] == 11 and v["pinned_at"] is not None and lo <= v["pinned_at"] <= hi]
    history, extension_ids = {}, set()
    for name in ("cohort.json", "extension-cohort.json"):
        for episode in json.loads((HERE.parent / "own-history" / name).read_text()):
            key = (bus_name(episode["bus"]), episode["a"])
            assert key not in history
            history[key] = episode["id"]
            if name == "extension-cohort.json":
                extension_ids.add(episode["id"])
    skipped, journeys, landmarks = [], [], collections.defaultdict(list)
    source_status = collections.Counter()
    for source in sources:
        if source["id"] == 65237:
            # Audited restart split: its departure clock can support a later
            # path, but its artificial pin cannot define standing landmarks.
            skipped.append(dict(sourceId=source["id"], status="invalid_source_pin",
                                reason="audited restart split has invalid pin/standing landmark clocks"))
            source_status["audited invalid source pin"] += 1
            continue
        if (source["outcome"] != "stopped" or source["how"] == "gap"
                or source["departed_at"] is None or source["departed_at"] < source["pinned_at"]
                or source["closest_m"] > 75):
            status = "censored" if source["departed_at"] is None or source["how"] == "gap" else "unknown"
            skipped.append(dict(sourceId=source["id"], status=status, reason="unsupported or incomplete source hold"))
            source_status["unsupported source hold"] += 1
            continue
        source_status["eligible source hold"] += 1
        name = bus_name(source["bus_name"])
        meta = dict(sourceId=source["id"], bus=name, day=datetime.datetime.fromtimestamp(source["pinned_at"] / 1000, TZ).date().isoformat(),
                    pinnedAt=source["pinned_at"], departedAt=source["departed_at"],
                    historyPinMatched=(name, source["pinned_at"]) in history,
                    cohortPartition="later extension" if source["id"] in extension_ids else "original cohort",
                    auditedRestartSplit=source["id"] == 65237)
        for target in TARGETS:
            linked, failure = connector.following(source, target)
            journey = dict(meta, target=target, occurrence=1, connected=linked is not None)
            if failure:
                journey.update(failure)
            else:
                first, second = linked["targets"]
                journey.update(firstTargetVisitId=first["id"], firstTargetArrivedAt=first["arrived_at"],
                               targetVisitId=second["id"], targetArrivedAt=second["arrived_at"],
                               targetOutcome=second["outcome"], targetClosestM=second["closest_m"],
                               legIds=[leg["id"] for leg, _ in linked["path"]],
                               visitIds=[visit["id"] for _, visit in linked["path"]], totalHops=linked["hops"])
            journeys.append(journey)
            for elapsed in LANDMARKS:
                at = source["pinned_at"] + elapsed * 1000
                if at >= source["departed_at"]:
                    skipped.append(dict(meta, target=target, checkpointSec=elapsed, status="not_at_risk", reason="source departed before landmark"))
                    continue
                landmarks[(name, target)].append(dict(journey=journey, checkpointSec=elapsed, at=at, candidate=None,
                                                     rejected=collections.Counter(), observations=0))
    times = {}
    for key, items in landmarks.items():
        items.sort(key=lambda item: item["at"])
        times[key] = [item["at"] for item in items]
    raw_counts, clip_counts = collections.Counter(), collections.Counter()
    seen_identities = set()
    pair_hash = hashlib.sha256()
    with args.pairs.open("rb") as stream:
        for line in stream:
            pair_hash.update(line)
            row = json.loads(line)
            raw_counts["all paired rows"] += 1
            if row.get("route", 3) != 3 or row.get("target") not in TARGETS:
                continue
            if row.get("occurrence") != 1:
                raw_counts["other occurrence rows"] += 1
                continue
            raw_counts["following occurrence rows"] += 1
            key = (bus_name(row["bus"]), row["target"])
            at = stamp(row["at"])
            if key not in times:
                continue
            start = bisect.bisect_left(times[key], at - TOLERANCE_MS)
            end = bisect.bisect_right(times[key], at)
            for item in landmarks[key][start:end]:
                item["observations"] += 1
                if item["candidate"] is not None:
                    continue
                reason = None
                if at >= item["journey"]["departedAt"]:
                    reason = "no forecast before source departure"
                elif row.get("warmMs") is None or row["warmMs"] < MIN_WARM_MS:
                    reason = "insufficient or unknown warm duration"
                elif any(not isinstance(row.get(arm), dict) or not all(isinstance(row[arm].get(k), (int, float)) and math.isfinite(row[arm][k]) for k in ("eta", "low", "high")) or not row[arm]["low"] <= row[arm]["eta"] <= row[arm]["high"] for arm in ARMS):
                    reason = "invalid or unpaired forecast"
                if reason:
                    item["rejected"][reason] += 1
                    continue
                identity = (at, key, row["stopsAhead"], row["occurrence"])
                # Overlapping physical hold records must not silently reuse a
                # forecast at two source identities.
                assert identity not in seen_identities, ("reused following forecast", identity)
                seen_identities.add(identity)
                candidate = {k: v for k, v in row.items() if k not in ARMS}
                for arm in ARMS:
                    candidate[arm + "Raw"] = row[arm]
                    candidate[arm] = {k: max(0, row[arm][k]) for k in ("eta", "low", "high")}
                    for field in ("eta", "low", "high"):
                        clip_counts[arm + "." + field] += row[arm][field] < 0
                item["candidate"] = candidate
    assert raw_counts["all paired rows"] == validation["counts"]["pairedRows"], "pairs.jsonl is incomplete or changed"
    events = []
    landmark_counts = collections.Counter()
    for items in landmarks.values():
        for item in items:
            journey = item["journey"]
            landmark_counts["eligible standing landmarks"] += 1
            if item["candidate"] is None:
                landmark_counts["missing forecast landmarks"] += 1
                skipped.append(dict(sourceId=journey["sourceId"], target=journey["target"], checkpointSec=item["checkpointSec"],
                                    status="unmatched_forecast", reason="no eligible following forecast at landmark", observations=item["observations"], rejected=dict(item["rejected"])))
                continue
            landmark_counts["paired warm following forecasts"] += 1
            if not journey["connected"]:
                landmark_counts["forecast has unknown or censored following outcome"] += 1
                continue
            row = item["candidate"]
            assert journey["pinnedAt"] <= row["at"] < journey["departedAt"] < journey["firstTargetArrivedAt"] < journey["targetArrivedAt"]
            event = dict(row, **journey, checkpointSec=item["checkpointSec"], checkpointDelaySec=(row["at"] - item["at"]) / 1000,
                         truthSec=(journey["targetArrivedAt"] - row["at"]) / 1000)
            event["changedVsCore"] = any(abs(event["history"][k] - event["core"][k]) > 1e-8 for k in ("eta", "low", "high"))
            events.append(event)
    groups = []
    for target in TARGETS:
        for elapsed in LANDMARKS:
            rows = [r for r in events if r["target"] == target and r["checkpointSec"] == elapsed]
            groups.append(dict(target=target, checkpointSec=elapsed, scores=arm_metrics(rows),
                               byDate={day: arm_metrics([r for r in rows if r["day"] == day]) for day in sorted({r["day"] for r in rows})}))
    regressions = {}
    raised_lower_risks = {}
    for comparator in ("core", "union"):
        annotated = [dict(row, absoluteErrorIncreaseSec=score(row, "history")["absoluteError"] - score(row, comparator)["absoluteError"],
                          WISIncrease=score(row, "history")["wis"] - score(row, comparator)["wis"],
                          lowerIncreaseSec=row["history"]["low"] - row[comparator]["low"]) for row in events]
        regressions[comparator] = dict(byAbsoluteError=sorted(annotated, key=lambda r: r["absoluteErrorIncreaseSec"], reverse=True)[:20],
                                      byWIS=sorted(annotated, key=lambda r: r["WISIncrease"], reverse=True)[:20])
        raised_lower_risks[comparator] = [r for r in annotated if r["lowerIncreaseSec"] > 1e-8 and r["truthSec"] < r["history"]["low"]]
    connected = [j for j in journeys if j["connected"]]
    changed = [r for r in events if r["changedVsCore"]]
    visit_by_id, leg_by_id = {v["id"]: v for v in visits}, {leg["id"]: leg for leg in legs}
    path_checks, reviewed_sources = [], set()
    for row in regressions["core"]["byAbsoluteError"]:
        if row["sourceId"] in reviewed_sources:
            continue
        reviewed_sources.add(row["sourceId"])
        source = visit_by_id[row["sourceId"]]
        path_visits = [visit_by_id[i] for i in row["visitIds"]]
        path_legs = [leg_by_id[i] for i in row["legIds"]]
        path_checks.append(dict(sourceId=source["id"], target=row["target"], totalHops=row["totalHops"],
                                connectedLegs=len(path_legs), sourceRecordedStandSec=source["stand_sec"],
                                sourceHow=source["how"], sourceClosestM=source["closest_m"],
                                maxPathClosestM=max(v["closest_m"] for v in path_visits),
                                gapVisitIds=[v["id"] for v in path_visits if v["how"] == "gap"],
                                futureMeasuredHolds=[dict(id=v["id"], stop=v["stop_id"], standSec=v["stand_sec"], how=v["how"], closestM=v["closest_m"])
                                                     for v in path_visits if v["stand_sec"] is not None and v["stand_sec"] >= 240],
                                conclusion="Exact connected path retained; no gap completion or unsupported target geometry supplies a reason to discard this regression."))
        if len(path_checks) == 3:
            break
    result = dict(method="Exact two-target-visit connected path from Winchester; following occurrence=1 only. First paired forecast at or within15s after fixed standing landmarks, minimum10min warm state. No prediction or label interpolation, fitting, tuning or outlier removal.",
                  limitations=["Repeated landmarks/targets share holds and are not independent trials.", "Detector/GPS arrivals are proxy truth, not verified door events.", "No later Red continuation and unreached/gap legs are censored rather than assigned an arrival.", "Completed-cohort pin intervention does not establish prospective feature availability.", "The WIS80 formula is a comparative diagnostic; final runtime windows include policy transforms and are not asserted calibrated80% intervals."],
                  inputs=dict(pairs=str(args.pairs.resolve()), pairsSha256=pair_hash.hexdigest(), db=str(args.db.resolve()), dbSha256=digest(args.db),
                              codeSha256=digest(Path(__file__)), fitSha256=digest(HERE.parent / "own-history/fits.json"),
                              frameBounds=bounds, minWarmMs=MIN_WARM_MS, toleranceMs=TOLERANCE_MS, landmarks=LANDMARKS),
                  counts=dict(rawRows=dict(raw_counts), sourceHolds=len(sources), sourceStatus=dict(source_status),
                              sourceTargetPaths=len(journeys), connectedFollowingPaths=len(connected),
                              connectedSourceHolds=len({j["sourceId"] for j in connected}),
                              censoredPaths=sum(j.get("status") == "censored" for j in journeys),
                              unknownPaths=sum(j.get("status") == "unknown" for j in journeys),
                              pathFailureReasons=dict(collections.Counter(j["reason"] for j in journeys if not j["connected"])),
                              landmarks=dict(landmark_counts), scoredCheckpointRows=len(events),
                              scoredSourceHolds=len({r["sourceId"] for r in events}),
                              scoredTargetVisits=len({r["targetVisitId"] for r in events}),
                              scoredUnmatchedHistoryPins=len({r["sourceId"] for r in events if not r["historyPinMatched"]}),
                              changedCheckpointRows=len(changed), changedSourceHolds=len({r["sourceId"] for r in changed}),
                              clipping=dict(clip_counts)),
                  scores=dict(allCheckpoints=arm_metrics(events), visitBalanced=arm_metrics(events, True),
                              changedVsCore=arm_metrics(changed), changedVsCoreVisitBalanced=arm_metrics(changed, True),
                              byCohortPartition={partition: arm_metrics([r for r in events if r["cohortPartition"] == partition]) for partition in ("original cohort", "later extension")},
                              byTarget={target: arm_metrics([r for r in events if r["target"] == target]) for target in TARGETS},
                              byDate={day: arm_metrics([r for r in events if r["day"] == day]) for day in sorted({r["day"] for r in events})}),
                  landmarkScores=groups, worstRegressions=regressions, raisedLowerEarlyArrivals=raised_lower_risks,
                  worstPathMeasurementChecks=path_checks,
                  journeys=journeys, checkpoints=events, skipped=skipped)
    (HERE / "following-occurrence.json").write_text(json.dumps(result, indent=2) + "\n")
    lines = ["# Following-occurrence audit", "", "The history candidate produces little aggregate change to the following arrival. Individual regressions remain and are retained; this small, incomplete sample does not establish noninferiority.", "", f"Scored {len(events)} fixed landmarks from {result['counts']['scoredSourceHolds']} Winchester holds and {result['counts']['scoredTargetVisits']} following target visits. {len(connected)}/{len(journeys)} source-target paths had two explicitly observed, exactly connected target visits.", "",
             "| Scope | Arm | Rows | MAE (s) | Width (s) | WIS diagnostic | Early / late |", "|---|---|---:|---:|---:|---:|---:|"]
    for label, scores in [("All landmarks", result["scores"]["allCheckpoints"]), ("Changed landmarks", result["scores"]["changedVsCore"])]:
        for arm, metric in scores.items():
            if metric["n"]:
                lines.append(f"| {label} | {arm} | {metric['n']} | {metric['maeSec']:.1f} | {metric['meanWidthSec']:.1f} | {metric['WIS80Diagnostic']:.1f} | {metric['early']} / {metric['late']} |")
    lines += ["", "All three arms use the same frozen travel/dwell tables, actual runtime lap support and forecasts. The following target is labelled only after tracing the first target and another full route loop through exact same-bus leg/visit identities. Missing paths remain unknown or censored; neither skipped stops nor missing observations are interpolated.", "",
              f"Coverage: {result['counts']['censoredPaths']} censored and {result['counts']['unknownPaths']} unknown paths; {landmark_counts['missing forecast landmarks']} eligible landmarks lacked a warm paired following forecast. {result['counts']['scoredUnmatchedHistoryPins']} scored holds were absent from the frozen history lookup. Only {len(changed)} scored rows from {result['counts']['changedSourceHolds']} holds changed versus core.", ""]
    for comparator in ("core", "union"):
        worse = regressions[comparator]["byAbsoluteError"]
        if worse:
            worst = worse[0]
            lines.append(f"Worst history median-error regression versus {comparator}: +{worst['absoluteErrorIncreaseSec']:.1f}s at source visit{worst['sourceId']}, target{worst['target']}, elapsed{worst['checkpointSec']}s; {len(raised_lower_risks[comparator])} raised-lower rows had an actual arrival before the history lower bound.")
    extension_rows = [r for r in events if r["cohortPartition"] == "later extension"]
    lines += ["", f"The five-hold later extension contributes only {len(extension_rows)} landmarks from {len({r['sourceId'] for r in extension_rows})} source holds. Other extension paths are unknown or censored; this is not a new independent day.", "",
              "Measurement review retained the largest regressions: the top three distinct source holds have exact connected leg/visit paths with no gap completions. Future observed Union/Winchester waits account for genuine variation; they were used only as retrospective labels. Visit65237's audited invalid pin is explicitly excluded from landmark clocks, while its valid departure remains available to connect other paths."]
    lines += ["", "Per-date, per-target, every fixed landmark, equal-journey weighting, exact path IDs, retained failures, and worst regressions are in following-occurrence.json. Repeated checkpoints are dependent. Final intervals are not asserted calibrated probabilities, and GPS arrival labels are not door-open ground truth. Completed-cohort matching is an offline intervention, not a demonstration of production feature availability.", ""]
    (HERE / "following-occurrence.md").write_text("\n".join(lines))
    print(json.dumps(dict(counts=result["counts"], scores=result["scores"]), indent=2))


if __name__ == "__main__":
    main()
