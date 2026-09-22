"""Hosted-only, fixed-visit reminder risk proxy; never reports actual rider misses."""
from __future__ import annotations

import argparse
import bisect
import collections
import gzip
import json
import math
import statistics
from pathlib import Path
from zoneinfo import ZoneInfo
import datetime as dt


WALKS = (60, 180, 300, 600)
RESPONSES = (0, 30)
POLICIES = ("point", "lower", "rendered_lower")
BUFFER_SEC = 30
MAX_SNAPSHOT_GAP_MS = 30_000
MAX_RAW_GAP_MS = 60_000
TZ = ZoneInfo("America/New_York")


def finite(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def stream(path):
    with gzip.open(path, "rt") as source:
        for line in source:
            if line.strip():
                yield json.loads(line)


def day(at):
    return dt.datetime.fromtimestamp(at / 1000, TZ).date().isoformat()


def forecast(row, arm):
    return row.get("deployed") if arm == "deployed" else row.get("candidates", {}).get(arm)


def valid_forecast(value):
    return (isinstance(value, dict) and all(finite(value.get(k)) for k in ("eta", "low", "high"))
            and 0 <= value["low"] <= value["eta"] <= value["high"])


def valid_point(value):
    return isinstance(value, dict) and finite(value.get("eta")) and value["eta"] >= 0


def rendered_pickup(value, elapsed=0):
    """Mirror arrivalDetails.predictionWindow, including its point-only fallback.

    This is the primary pickup table, not etaBand's legacy 3–15 minute filter.
    The low minute is floored, the high minute ceiled, and '<1' starts now.
    Bounds are aged afresh on each timer tick before formatting.
    """
    if not valid_point(value):
        raise ValueError("A rendered pickup requires a finite, nonnegative point ETA")
    elapsed = max(0, elapsed)
    low, high = value.get("low"), value.get("high")
    point = max(0, value["eta"] - elapsed)
    if not finite(low) or not finite(high) or high < low:
        return dict(sec=point, basis="point", text=None)
    low, high = max(0, low - elapsed), max(0, high - elapsed)
    if high <= 0:
        return dict(sec=point, basis="point", text=None)
    first = "<1" if low < 60 else str(math.floor(low / 60))
    last = max(1, math.ceil(high / 60))
    text = f"{last} min" if first == str(last) else f"{first}–{last} min"
    return dict(sec=0 if low < 60 else math.floor(low / 60) * 60, basis="window", text=text)


def causal(row):
    at, asof = row.get("at"), row.get("asof")
    if not finite(at) or not finite(asof) or not 0 <= at - asof <= 15_000:
        return False
    observed = row.get("observedAt")
    if finite(observed) and observed > 0 and observed > asof:
        return False
    for origin in row.get("origins", {}).values():
        if not isinstance(origin, dict):
            return False
        departed, known = origin.get("departed"), origin.get("knownAt")
        if not finite(departed) or not finite(known) or not departed <= known <= asof:
            return False
    return True


class Connectivity:
    """Keep assignment changes and conflicting duplicate fixes, not just the desired route."""
    def __init__(self, path, buses):
        grouped = collections.defaultdict(list)
        self.invalid = collections.Counter()
        for row in stream(path):
            bus = str(row.get("bus_name"))
            if bus not in buses:
                continue
            t, lat, lon, route = (row.get(k) for k in ("collected_at", "lat", "lon", "route_id"))
            if not all(finite(v) for v in (t, lat, lon, route)):
                self.invalid[bus] += 1
                continue
            grouped[bus].append((t, lat, lon, route, row.get("bus_id")))
        self.data = {}
        for bus, points in grouped.items():
            # Identical export overlap is harmless; conflicting positions at one instant are not.
            points = sorted(set(points), key=lambda p: p[0])
            bad = [0]
            for a, b in zip(points, points[1:]):
                elapsed = (b[0] - a[0]) / 1000
                metres = math.hypot((b[1] - a[1]) * 111195,
                                    (b[2] - a[2]) * 111195 * math.cos(math.radians(a[1])))
                identity_change = a[4] is not None and b[4] is not None and a[4] != b[4]
                broken = (elapsed <= 0 or elapsed * 1000 > MAX_RAW_GAP_MS
                          or metres / max(.001, elapsed) > 22 or a[3] != b[3] or identity_change)
                bad.append(bad[-1] + int(broken))
            self.data[bus] = ([p[0] for p in points], points, bad)

    def reason(self, bus, route, start, end):
        if not finite(start) or not finite(end) or end <= start:
            return "invalid-raw-interval"
        data = self.data.get(bus)
        if not data:
            return "no-raw-gps"
        times, points, bad = data
        left = bisect.bisect_right(times, start) - 1
        right = bisect.bisect_left(times, end)
        if left < 0 or right >= len(times):
            return "raw-does-not-bracket-arm-and-departure"
        # Include every contradictory fix at a boundary, not one arbitrarily selected twin.
        left = bisect.bisect_left(times, times[left])
        right = bisect.bisect_right(times, times[right]) - 1
        if start - times[left] > MAX_RAW_GAP_MS or times[right] - end > MAX_RAW_GAP_MS:
            return "raw-boundary-gap"
        if points[left][3] != route or points[right][3] != route:
            return "raw-route-mismatch"
        if bad[right] != bad[left]:
            return "raw-gap-identity-route-or-speed-break"
        return None


def canonical_row(row):
    # Surface duplicates are harmless only if every compared prediction and its causal clock agree.
    return json.dumps({k: row.get(k) for k in
                       ("asof", "label", "deployed", "candidates", "origins", "observedAt")}, sort_keys=True)


def unique_rows(rows):
    by_time = {}
    duplicates = 0
    for row in rows:
        at = row.get("at")
        if not finite(at):
            return [], "invalid-snapshot-time", duplicates
        if at in by_time:
            duplicates += 1
            if canonical_row(row) != canonical_row(by_time[at]):
                return [], "conflicting-same-time-snapshots", duplicates
        else:
            by_time[at] = row
    return [by_time[t] for t in sorted(by_time)], None, duplicates


def trigger(rows, arm, field, walk, response, departure):
    """Replay per-second leave checks while each observed forecast remains <=30s old.

    A new observation replaces the old one at its timestamp. No future observation
    influences a prior trigger. Stop once a decision is known; later snapshot loss
    cannot undo an already-emitted reminder. Otherwise censor missing guidance.
    """
    start = rows[0]["at"]
    latest_leave = departure - (walk + response) * 1000
    if latest_leave < start:
        return {"status": "already-too-late-at-arm", "latestLeaveAt": latest_leave}
    for i, row in enumerate(rows):
        at = row["at"]
        if at > latest_leave:
            # The previous iteration would already have scored or censored this deadline.
            break
        if not causal(row):
            return {"status": "censored", "reason": "noncausal-snapshot", "at": at}
        value = forecast(row, arm)
        if not (valid_forecast(value) if field == "low" else valid_point(value)):
            return {"status": "censored", "reason": "missing-or-invalid-arm-forecast", "at": at}
        following = rows[i + 1]["at"] if i + 1 < len(rows) else math.inf
        fresh_until = at + MAX_SNAPSHOT_GAP_MS
        # Timer ticks every second relative to arming, matching the app's countdown check.
        rendered = None
        if field == "rendered_lower":
            # Flooring is discontinuous, so reformat at each actual check. At most
            # 31 checks per observed row; never extrapolate past the freshness cap.
            fire = start + math.ceil((at - start) / 1000) * 1000
            while fire <= min(latest_leave, fresh_until) and fire < following:
                rendered = rendered_pickup(value, (fire - at) / 1000)
                if rendered["sec"] <= walk + BUFFER_SEC:
                    break
                fire += 1000
        else:
            threshold = at + max(0, value[field] - walk - BUFFER_SEC) * 1000
            fire = start + math.ceil(max(0, threshold - start) / 1000) * 1000
            fire = max(fire, start + math.ceil((at - start) / 1000) * 1000)
        if fire <= latest_leave and fire <= fresh_until and fire < following:
            return {"status": "triggered", "leaveNowAt": fire, "forecastAt": at,
                    "triggerForecast": value, "latestLeaveAt": latest_leave,
                    **({"renderedAtTrigger": rendered} if rendered is not None else {})}
        if latest_leave <= fresh_until and latest_leave < following:
            return {"status": "no-timely-reminder", "latestLeaveAt": latest_leave,
                    "forecastAt": at, "deadlineForecast": value}
        if following > fresh_until:
            return {"status": "censored", "reason": "snapshot-gap-before-decision",
                    "lastSnapshotAt": at, "nextSnapshotAt": None if not finite(following) else following,
                    "latestLeaveAt": latest_leave}
    return {"status": "censored", "reason": "snapshots-end-before-decision", "latestLeaveAt": latest_leave}


def evaluate_action(rows, arm, policy, walk, response, label):
    field = {"point": "eta", "lower": "low", "rendered_lower": "rendered_lower"}[policy]
    decision = trigger(rows, arm, field, walk, response, label["departure"])
    result = dict(decision, arm=arm, policy=policy, walkSec=walk, responseSec=response)
    initial = forecast(rows[0], arm)
    if valid_forecast(initial):
        actual = (label["arrival"] - rows[0]["at"]) / 1000
        result.update(armForecast=initial, earlyBelowLow=actual < initial["low"],
                      earlyBelowLowSec=max(0, initial["low"] - actual),
                      pointOverestimationSec=max(0, initial["eta"] - actual),
                      armWidthSec=initial["high"] - initial["low"])
    if policy == "rendered_lower" and valid_point(initial):
        rendered = rendered_pickup(initial)
        actual = (label["arrival"] - rows[0]["at"]) / 1000
        result.update(renderedAtArm=rendered,
                      earlyBeforeRendered=actual < rendered["sec"],
                      earlyBeforeRenderedSec=max(0, rendered["sec"] - actual))
    if decision["status"] == "triggered":
        reach = decision["leaveNowAt"] + (walk + response) * 1000
        result.update(reachStopAt=reach, hypotheticalMissedBoarding=reach > label["departure"],
                      lateToArrival=reach > label["arrival"],
                      lateToArrivalSec=max(0, (reach - label["arrival"]) / 1000),
                      waitAtStopSec=max(0, (label["arrival"] - reach) / 1000))
    elif decision["status"] == "no-timely-reminder":
        # A rider waiting for this reminder cannot arrive by the observed departure.
        result.update(hypotheticalMissedBoarding=True, lateToArrival=True,
                      lateToArrivalSec=None, waitAtStopSec=None)
    return result


def mean(values):
    values = [v for v in values if v is not None]
    return statistics.mean(values) if values else None


def summary(records):
    scored = [r for r in records if r["status"] in ("triggered", "no-timely-reminder")]
    early = [r for r in records if "earlyBelowLow" in r and r["status"] != "censored"]
    rendered = [r for r in records if "earlyBeforeRendered" in r and r["status"] != "censored"]
    return dict(records=len(records), statuses=dict(collections.Counter(r["status"] for r in records)),
                censorReasons=dict(collections.Counter(r.get("reason") for r in records if r["status"] == "censored")),
                scored=len(scored), visits=len({(r["route"], r["bus"], r["target"], r["visit"]) for r in scored}),
                dates=sorted({r["date"] for r in scored}),
                hypotheticalMissedBoardings=sum(r["hypotheticalMissedBoarding"] for r in scored),
                hypotheticalMissedBoardingRate=mean([int(r["hypotheticalMissedBoarding"]) for r in scored]),
                lateToArrivalRate=mean([int(r["lateToArrival"]) for r in scored]),
                meanWaitAtStopSec=mean([r.get("waitAtStopSec") for r in scored]),
                meanPositiveLatenessSec=mean([r.get("lateToArrivalSec") for r in scored]),
                earlyBelowLowRate=mean([int(r["earlyBelowLow"]) for r in early]),
                meanEarlyBelowLowSec=mean([r["earlyBelowLowSec"] for r in early]),
                earlyBeforeRenderedRate=mean([int(r["earlyBeforeRendered"]) for r in rendered]),
                meanEarlyBeforeRenderedSec=mean([r["earlyBeforeRenderedSec"] for r in rendered]),
                meanArmWindowWidthSec=mean([r["armWidthSec"] for r in early]))


def compare(records):
    indexed = {(r["route"], r["bus"], r["target"], r["visit"], r["walkSec"], r["responseSec"],
                r["arm"], r["policy"]): r for r in records}
    groups = collections.defaultdict(list)
    for key, candidate in indexed.items():
        if key[-2:] == ("deployed", "point"):
            continue
        baseline = indexed.get((*key[:-2], "deployed", "point"))
        if not baseline:
            continue
        groups[(candidate["route"], candidate["arm"], candidate["policy"],
                candidate["walkSec"], candidate["responseSec"])].append((baseline, candidate))
    output = []
    for key, pairs in sorted(groups.items()):
        paired = [(b, c) for b, c in pairs if b["status"] in ("triggered", "no-timely-reminder")
                  and c["status"] in ("triggered", "no-timely-reminder")]
        output.append(dict(route=key[0], arm=key[1], policy=key[2], walkSec=key[3], responseSec=key[4],
                           attemptedPairs=len(pairs), scoredPairs=len(paired),
                           newlyMissed=sum(not b["hypotheticalMissedBoarding"] and c["hypotheticalMissedBoarding"] for b, c in paired),
                           rescued=sum(b["hypotheticalMissedBoarding"] and not c["hypotheticalMissedBoarding"] for b, c in paired),
                           deployedPoint=summary([b for b, c in paired]), candidate=summary([c for b, c in paired])))
    return output


def compare_rendered_to_raw(records):
    """Measure display rounding on exactly the same arm, visit, walk and response."""
    indexed = {(r["route"], r["bus"], r["target"], r["visit"], r["walkSec"], r["responseSec"],
                r["arm"], r["policy"]): r for r in records}
    groups = collections.defaultdict(list)
    for key, rendered in indexed.items():
        if rendered["policy"] != "rendered_lower":
            continue
        raw = indexed.get((*key[:-1], "lower"))
        if raw:
            groups[(rendered["route"], rendered["arm"], rendered["walkSec"], rendered["responseSec"])].append((raw, rendered))
    output = []
    for key, pairs in sorted(groups.items()):
        paired = [(a, b) for a, b in pairs if a["status"] in ("triggered", "no-timely-reminder")
                  and b["status"] in ("triggered", "no-timely-reminder")]
        both_triggered = [(a, b) for a, b in paired if a["status"] == b["status"] == "triggered"]
        output.append(dict(route=key[0], arm=key[1], walkSec=key[2], responseSec=key[3],
                           attemptedPairs=len(pairs), scoredPairs=len(paired),
                           rawStatuses=dict(collections.Counter(a["status"] for a, b in pairs)),
                           renderedStatuses=dict(collections.Counter(b["status"] for a, b in pairs)),
                           newlyMissed=sum(not a["hypotheticalMissedBoarding"] and b["hypotheticalMissedBoarding"] for a, b in paired),
                           rescued=sum(a["hypotheticalMissedBoarding"] and not b["hypotheticalMissedBoarding"] for a, b in paired),
                           bothTriggered=len(both_triggered),
                           meanEarlierReminderSec=mean([(a["leaveNowAt"] - b["leaveNowAt"]) / 1000 for a, b in both_triggered]),
                           meanAddedWaitSec=mean([b["waitAtStopSec"] - a["waitAtStopSec"] for a, b in both_triggered]),
                           rawLower=summary([a for a, b in paired]), renderedLower=summary([b for a, b in paired])))
    return output


def run(directory, output):
    grouped = collections.defaultdict(list)
    invalid = collections.Counter()
    arms = {"deployed"}
    for row in stream(directory / "forecasts.jsonl.gz"):
        label = row.get("label")
        if not isinstance(label, dict) or label.get("id") is None:
            invalid["missing-physical-visit-label"] += 1
            continue
        if not all(k in row for k in ("route", "bus", "target")):
            invalid["missing-visit-key"] += 1
            continue
        arms.update(row.get("candidates", {}))
        grouped[(row["route"], str(row["bus"]), row["target"], label["id"])].append(row)
    if any("deployed" in r.get("candidates", {}) for rows in grouped.values() for r in rows):
        raise ValueError("Candidate name 'deployed' is reserved")
    connectivity = Connectivity(directory / "raw_positions.jsonl.gz", {k[1] for k in grouped})
    records, cohort = [], []
    for key, rows in sorted(grouped.items()):
        route, bus, target, visit = key
        base = dict(route=route, bus=bus, target=target, visit=visit)
        rows, problem, duplicates = unique_rows(rows)
        audit = dict(base, inputSnapshots=len(rows), duplicateSnapshots=duplicates)
        if problem:
            cohort.append(dict(audit, status="excluded", reason=problem))
            continue
        labels = {json.dumps(r["label"], sort_keys=True) for r in rows}
        if len(labels) != 1:
            cohort.append(dict(audit, status="excluded", reason="inconsistent-visit-label"))
            continue
        label = rows[0]["label"]
        arrival, departure = label.get("arrival"), label.get("departure")
        if (not finite(arrival) or not finite(departure) or departure < arrival
                or label.get("outcome") not in ("passed", "stopped")):
            cohort.append(dict(audit, status="excluded", reason="unresolved-departure-or-outcome"))
            continue
        # This arming rule depends on deployed information available then, never on candidate values.
        start = next((i for i, r in enumerate(rows) if valid_point(r.get("deployed"))
                      and 300 <= r["deployed"]["eta"] <= 1200 and r["at"] < arrival), None)
        if start is None:
            cohort.append(dict(audit, status="excluded", reason="no-common-deployed-5-to-20min-arm"))
            continue
        rows = rows[start:]
        at = rows[0]["at"]
        problem = connectivity.reason(bus, route, at, departure)
        if problem:
            cohort.append(dict(audit, status="excluded", reason=problem, armedAt=at))
            continue
        if not causal(rows[0]):
            cohort.append(dict(audit, status="excluded", reason="noncausal-arming-snapshot", armedAt=at))
            continue
        evidence = rows[0].get("deployedEvidence") or {}
        base.update(armedAt=at, date=day(at), arrivalAt=arrival, departureAt=departure,
                    outcome=label["outcome"], initialPhase=rows[0].get("phase"),
                    initialIndex=rows[0].get("index"), initialStopsAhead=rows[0].get("stopsAhead"),
                    sourceDepartureAt=(evidence.get("origin") or {}).get("departed"),
                    snapshotCount=len(rows), armAsOf=rows[0].get("asof"))
        cohort.append(dict(audit, status="included", armedAt=at, arrivalAt=arrival, departureAt=departure))
        for arm in sorted(arms):
            for policy in POLICIES:
                for walk in WALKS:
                    for response in RESPONSES:
                        records.append(dict(base, **evaluate_action(rows, arm, policy, walk, response, label)))
    by_cell = collections.defaultdict(list)
    for r in records:
        by_cell[(r["route"], r["arm"], r["policy"], r["walkSec"], r["responseSec"], r["outcome"])].append(r)
    result = dict(description="Fixed-visit hypothetical reminder risk; not observed rider misses or a full app journey simulation",
                  rules=dict(walkSec=WALKS, responseSec=RESPONSES, bufferSec=BUFFER_SEC, policies=POLICIES,
                             maxSnapshotGapMs=MAX_SNAPSHOT_GAP_MS, maxRawGapMs=MAX_RAW_GAP_MS,
                             arming="First deployed point ETA 5–20 min before observed arrival; one arm per physical visit"),
                  invalidInputRows=dict(invalid), invalidRawRowsByBus=dict(connectivity.invalid),
                  cohort=dict(visits=len(cohort), included=sum(r["status"] == "included" for r in cohort),
                              exclusions=dict(collections.Counter(r["reason"] for r in cohort if r["status"] == "excluded"))),
                  cells=[dict(route=k[0], arm=k[1], policy=k[2], walkSec=k[3], responseSec=k[4], outcome=k[5], **summary(rs))
                         for k, rs in sorted(by_cell.items())],
                  pairedAgainstDeployedPoint=compare(records),
                  pairedRenderedAgainstRawLower=compare_rendered_to_raw(records))
    output.mkdir(parents=True, exist_ok=True)
    for name, values in (("rider-risk-records", records), ("rider-risk-cohort", cohort)):
        with gzip.open(output / (name + ".jsonl.gz"), "wt") as dest:
            for value in values:
                dest.write(json.dumps(value, sort_keys=True, allow_nan=False) + "\n")
    (output / "rider-risk-summary.json").write_text(json.dumps(result, indent=2, allow_nan=False) + "\n")
    print(json.dumps(dict(output=str(output), cohort=result["cohort"], actionRecords=len(records), arms=sorted(arms))))


def self_test():
    def row(t, eta, low=None):
        return dict(at=t, asof=t, origins={}, deployed=dict(eta=eta, low=eta if low is None else low, high=eta + 100))
    # Trigger between polls, equality at boarding deadline, causal replacement, and gaps.
    assert trigger([row(0, 120)], "deployed", "eta", 60, 0, 90_000)["leaveNowAt"] == 30_000
    assert trigger([row(0, 120), row(15_000, 90)], "deployed", "eta", 60, 0, 90_000)["leaveNowAt"] == 15_000
    assert trigger([row(0, 300)], "deployed", "eta", 60, 0, 300_000)["status"] == "censored"
    assert trigger([row(0, 300)], "deployed", "eta", 60, 0, 90_000)["status"] == "no-timely-reminder"
    assert trigger([row(0, 300)], "deployed", "eta", 60, 0, 59_000)["status"] == "already-too-late-at-arm"
    label = dict(arrival=100_000, departure=110_000)
    point = evaluate_action([row(0, 300, 90)], "deployed", "point", 60, 0, label)
    lower = evaluate_action([row(0, 300, 90)], "deployed", "lower", 60, 0, label)
    assert point["status"] == "censored" and lower["status"] == "triggered" and lower["waitAtStopSec"] == 40
    assert not causal(dict(row(0, 100), asof=1000))
    assert unique_rows([row(0, 100), row(0, 101)])[1] == "conflicting-same-time-snapshots"
    assert len(unique_rows([row(0, 100), row(0, 100)])[0]) == 1
    # Primary pickup formatting: outward minutes, every valid width, and '<1'.
    assert rendered_pickup(dict(eta=300, low=239, high=481)) == dict(sec=180, basis="window", text="3–9 min")
    assert rendered_pickup(dict(eta=90, low=89, high=91))["text"] == "1–2 min"
    assert rendered_pickup(dict(eta=300, low=119, high=2401))["text"] == "1–41 min"
    assert rendered_pickup(dict(eta=60, low=60, high=60)) == dict(sec=60, basis="window", text="1 min")
    assert rendered_pickup(dict(eta=90, low=59, high=91))["sec"] == 0
    assert rendered_pickup(dict(eta=300, low=120, high=481), 1) == dict(sec=60, basis="window", text="1–8 min")
    # Missing, nonfinite, reversed, and expired windows use the aged point.
    for value in (dict(eta=300), dict(eta=300, low=None, high=600),
                  dict(eta=300, low=math.nan, high=600), dict(eta=300, low=500, high=100),
                  dict(eta=300, low=0, high=1)):
        assert rendered_pickup(value, 1) == dict(sec=299, basis="point", text=None)
    # Flooring must be recomputed, not subtracted as a fixed clock: at 120s
    # the printed lower minute is 2; one second later it is 1 and triggers.
    rounding = [row(0, 180, 120)]
    assert trigger(rounding, "deployed", "rendered_lower", 60, 0, 200_000)["leaveNowAt"] == 1000
    assert trigger(rounding, "deployed", "low", 60, 0, 200_000)["leaveNowAt"] == 30_000
    point_only = dict(at=0, asof=0, origins={}, deployed=dict(eta=120))
    assert trigger([point_only], "deployed", "rendered_lower", 60, 0, 200_000)["leaveNowAt"] == 30_000
    assert trigger([point_only], "deployed", "eta", 60, 0, 200_000)["leaveNowAt"] == 30_000
    print(json.dumps(dict(selfTest="passed", assertions=24)))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path, nargs="?")
    parser.add_argument("--output", type=Path)
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        self_test()
    if args.directory:
        run(args.directory, args.output or args.directory / "rider-risk")
    elif not args.self_test:
        parser.error("directory is required unless --self-test is used")
