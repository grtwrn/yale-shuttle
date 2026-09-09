#!/usr/bin/env python3
"""Audit a frozen, prediction-blind label repair without changing its model.

Reports full reconstructed population, mutually matched physical visits, the
original first issues with only their labels repaired, and restored displays.
"""
import argparse, collections, gzip, json, math, pathlib, subprocess, sys
from inventory import lines
from score import file_hash, first_forecast_ids

HERE = pathlib.Path(__file__).resolve().parent

def load(path, arm): return {r["id"]: r for r in lines(path) if r.get("arm") == arm}

def write_rows(path, rows):
    with gzip.open(path, "wt") as out:
        for row in rows: out.write(json.dumps(row, separators=(",", ":")) + "\n")
    completion = pathlib.Path(str(path).replace(".stands.jsonl.gz", ".manifest.json"))
    completion.write_text(json.dumps({"scoringOnlySubset": True, "rows": len(rows)}) + "\n")

def same_value(a, b):
    if isinstance(a, (int, float)) and isinstance(b, (int, float)): return abs(a - b) <= 1e-7
    if isinstance(a, dict) and isinstance(b, dict): return a.keys() == b.keys() and all(same_value(a[k], b[k]) for k in a)
    return a == b

def has_display(row):
    shown = row.get("shown")
    return bool(shown and shown.get("remaining") is True and all(isinstance(shown.get(k), (int, float)) and math.isfinite(shown[k]) for k in ["sec", "typicalSec"]))

def associate_displays(rows, labels):
    """Truth association is unique in time; a wrong inferred index stays an error."""
    groups = collections.defaultdict(list)
    for label in labels.values():
        if label.get("labelStatus") == "complete" and label["outcome"] == "stopped":
            groups[label["routeId"], label["busKey"], label["stopId"]].append(label)
    associated = {}; counts = collections.Counter(); route_counts = collections.defaultdict(collections.Counter); mismatches = []
    for row in rows.values():
        choices = [e for e in groups[row["routeId"], row["busKey"], row["stopId"]] if e["pinnedAt"] <= row["issuedAt"] < e["departedAt"]]
        c = route_counts[str(row["routeId"])]
        if len(choices) != 1:
            reason = "ambiguousPhysicalVisit" if choices else "outsideCompletePhysicalStand"
            counts[reason] += 1; c[reason] += 1; continue
        label = choices[0]; index = row.get("stopIndex"); agreement = index == label["stopIndex"] if isinstance(index, int) and index >= 0 else None
        if agreement is None and label.get("canonicalStopIds", []).count(row["stopId"]) == 1:
            agreement = True; counts["occurrenceResolvedByUniquePhysicalMarker"] += 1
        status = "occurrenceAgrees" if agreement else "occurrenceMismatch" if agreement is False else "occurrenceUnresolved"
        counts[status] += 1; c[status] += 1
        joined = {**row, "episodeId": label["id"], "actualTotalSec": (label["departedAt"] - label["pinnedAt"]) / 1000,
                  "labelStopIndex": label["stopIndex"], "occurrenceAgreement": agreement}
        associated[row["id"]] = joined
        if agreement is not True: mismatches.append(joined)
    return associated, dict(counts), {k: dict(v) for k, v in route_counts.items()}, mismatches

def main():
    p = argparse.ArgumentParser()
    for name in ["baseline", "candidate", "original-baseline", "original-candidate", "labels", "matches", "label-lock", "dataset", "out"]:
        p.add_argument(f"--{name}", required=True, type=pathlib.Path)
    p.add_argument("--day", required=True); p.add_argument("--arm", default="warm"); p.add_argument("--bootstrap", type=int, default=2000)
    args = p.parse_args()
    source_hashes = {str(path): file_hash(path) for path in [pathlib.Path(__file__), HERE / "compare_stands.py", HERE / "score.py"]}
    lock = json.loads(args.label_lock.read_text()); manifest = json.loads((args.labels.parent / "manifest.json").read_text())
    if lock.get("predictionInputsRead") is not False or lock.get("modelInputsRead") is not False:
        raise ValueError("Repair lock must declare no forecast/model inputs")
    if manifest["lockSha256"] != file_hash(args.label_lock): raise ValueError("Repair lock hash mismatch")
    for path in [args.labels, args.matches]:
        expected = next(row["sha256"] for row in manifest["outputs"] if row["name"] == path.name)
        if file_hash(path) != expected: raise ValueError(f"Changed repaired label artifact: {path}")
    old_labels = {r["id"]: r for r in lines(args.dataset / args.day / "episodes.jsonl.gz")}
    new_labels = {r["id"]: r for r in lines(args.labels)}
    matches = list(lines(args.matches)); matched = [r for r in matches if r["status"] == "matched"]
    old_to_new = {r["originalEpisodeId"]: r["reconstructedEpisodeId"] for r in matched}
    if len(set(old_to_new.values())) != len(old_to_new): raise ValueError("Repair matches are not mutual one-to-one")
    new_to_old = {v: k for k, v in old_to_new.items()}
    original = [load(args.original_baseline, args.arm), load(args.original_candidate, args.arm)]
    unlabelled_sources = [pathlib.Path(str(source).replace(".stands.jsonl.gz", ".unlabelled-stands.jsonl.gz")) for source in [args.baseline, args.candidate]]
    unlabelled_rows = [load(source, args.arm) for source in unlabelled_sources]
    associations = [associate_displays(rows, new_labels) for rows in unlabelled_rows]
    rebuilt = [a[0] for a in associations]
    args.out.mkdir(parents=True, exist_ok=True)
    coverage = collections.defaultdict(collections.Counter)
    for row in matches: coverage[str(old_labels[row["originalEpisodeId"]]["routeId"])]["original_" + row["status"]] += 1
    for row in new_labels.values():
        c = coverage[str(row["routeId"])]; c["rebuilt_" + row["labelStatus"]] += 1
        if row["labelStatus"] == "complete" and row["id"] not in new_to_old: c["rebuilt_complete_unmatched_original"] += 1
    diagnostics = {}; subsets = {"original-matched": [], "rebuilt-matched": [], "original-first-repaired-clock": []}
    for side, old, new, unlabelled in zip(["baseline", "candidate"], original, rebuilt, unlabelled_rows):
        shared = old.keys() & unlabelled.keys()
        changed = [key for key in shared if not same_value(old[key]["shown"], unlabelled[key]["shown"])
                   or not same_value(old[key]["elapsedSec"], unlabelled[key]["elapsedSec"])]
        if changed: raise ValueError(f"{side} forecasts changed on {len(changed)} original issued keys; first={changed[0]}")
        missing = old.keys() - unlabelled.keys()
        if missing: raise ValueError(f"{side} lost {len(missing)} original display keys despite label-only replay; first={next(iter(missing))}")
        old_first_ids = first_forecast_ids(r for r in old.values() if has_display(r))
        new_first_ids = first_forecast_ids(r for r in new.values() if has_display(r))
        old_first = {old[k]["episodeId"]: old[k] for k in old_first_ids}
        new_first = {new[k]["episodeId"]: new[k] for k in new_first_ids}
        earlier_first = 0; restored_moments = 0; clock_only = []; first_outside = 0
        first_without_old_display = 0; first_without_old_label = 0; earlier_seconds = []
        for row in new.values():
            if not has_display(row): continue
            original_id = new_to_old.get(row["episodeId"])
            if original_id and old_labels[original_id]["pinnedAt"] is not None and row["issuedAt"] < old_labels[original_id]["pinnedAt"]:
                restored_moments += 1; coverage[str(row["routeId"])][side + "_restored_early_display_moments"] += 1
        for old_id, new_id in old_to_new.items():
            a, b = old_first.get(old_id), new_first.get(new_id)
            if a and b and b["issuedAt"] < a["issuedAt"]:
                earlier_first += 1; coverage[str(b["routeId"])][side + "_earlier_first_display_visits"] += 1
                earlier_seconds.append((a["issuedAt"] - b["issuedAt"]) / 1000)
            if a:
                label = new_labels[new_id]
                if label["pinnedAt"] <= a["issuedAt"] < label["departedAt"]:
                    clock_only.append({**a, "episodeId": new_id, "actualTotalSec": (label["departedAt"] - label["pinnedAt"]) / 1000})
                else: first_outside += 1
        for new_id, row in new_first.items():
            old_id = new_to_old.get(new_id)
            if old_id is None:
                first_without_old_label += 1; coverage[str(row["routeId"])][side + "_first_display_without_matched_original_label"] += 1
            elif old_id not in old_first:
                first_without_old_display += 1; coverage[str(row["routeId"])][side + "_matched_first_without_original_display"] += 1
        diagnostics[side] = {"originalIssuedKeys": len(old), "reconstructedIssuedKeys": len(new),
                             "unchangedOriginalKeysVerifiedAgainstUnlabelledReplay": len(shared), "originalKeysMissingFromNewUnlabelledReplay": len(old.keys() - shared),
                             "restoredEarlyDisplayMomentsBeforeOriginalPin": restored_moments,
                             "matchedVisitsWithEarlierFirstDisplay": earlier_first,
                             "totalSecondsEarlierAcrossRestoredFirstDisplays": sum(earlier_seconds),
                             "maximumSecondsEarlierFirstDisplay": max(earlier_seconds, default=0),
                             "matchedVisitsWithNoOriginalDisplay": first_without_old_display,
                             "firstDisplaysWithoutMatchedOriginalLabel": first_without_old_label,
                             "originalFirstIssueOutsideRebuiltPhysicalStand": first_outside}
        data = {"original-matched": [r for r in old.values() if r["episodeId"] in old_to_new],
                "rebuilt-matched": [r for r in new.values() if r["episodeId"] in new_to_old],
                "original-first-repaired-clock": clock_only}
        for name, rows in data.items():
            path = args.out / f"{side}.{name}.stands.jsonl.gz"; write_rows(path, rows); subsets[name].append(path)
    full_paths = []; strict_paths = []
    strict_keys = {key for key in rebuilt[0].keys() & rebuilt[1].keys() if all(rows[key]["occurrenceAgreement"] is True for rows in rebuilt)}
    for side, rows, association in zip(["baseline", "candidate"], rebuilt, associations):
        full_path = args.out / f"{side}.all-associated.stands.jsonl.gz"; write_rows(full_path, list(rows.values())); full_paths.append(full_path)
        strict_path = args.out / f"{side}.occurrence-agreement.stands.jsonl.gz"; write_rows(strict_path, [rows[k] for k in sorted(strict_keys)]); strict_paths.append(strict_path)
        write_rows(args.out / f"{side}.occurrence-mismatches.stands.jsonl.gz", association[3])
    plan = {"full-rebuilt": (full_paths, args.labels),
            "occurrence-agreement-sensitivity": (strict_paths, args.labels),
            "original-matched": (subsets["original-matched"], None),
            "rebuilt-matched": (subsets["rebuilt-matched"], args.labels),
            "original-first-repaired-clock": (subsets["original-first-repaired-clock"], args.labels)}
    report = {"labelLock": {"path": str(args.label_lock), "sha256": file_hash(args.label_lock)},
              "sourceHashes": source_hashes,
              "inputHashes": {str(path): file_hash(path) for path in [args.original_baseline, args.original_candidate, args.baseline, args.candidate] + unlabelled_sources},
              "interpretation": "Keep original results, matched-visit comparison, clock-only correction at original first issue, and full reconstructed population separate. Model predictions are unchanged on verified original issued keys.",
              "byRouteCoverage": {k: dict(v) for k, v in sorted(coverage.items())}, "displayDiagnostics": diagnostics,
              "occurrenceAssociation": {side: {"counts": association[1], "byRoute": association[2]} for side, association in zip(["baseline", "candidate"], associations)},
              "occurrencePolicy": "Unique complete physical visit at bus/route/stop/time defines truth. Inferred occurrence disagreement remains in primary as tracking error; sensitivity retains agreement in both arms. Ambiguous physical visits are excluded without choosing the first.",
              "guard": {"minimumVisits": 30, "maeIncreaseGreaterThanSec": 10, "relativeIncreaseGreaterThan": .1},
              "materialRouteRegressions": {}, "scores": {}}
    for name, (paths, labels) in plan.items():
        output = args.out / f"{name}-score.json"
        command = [sys.executable, str(HERE / "compare_stands.py"), "--baseline", str(paths[0]), "--candidate", str(paths[1]),
                   "--baseline-arm", args.arm, "--candidate-arm", args.arm, "--dataset", str(args.dataset), "--day", args.day,
                   "--out", str(output), "--bootstrap", str(args.bootstrap)]
        if labels: command += ["--episode-labels", str(labels)]
        with (args.out / f"{name}.log").open("w") as log: subprocess.run(command, stdout=log, stderr=subprocess.STDOUT, check=True)
        report["scores"][name] = {"path": str(output), "sha256": file_hash(output)}
        scored = json.loads(output.read_text()); failures = []
        for metric in ["remaining", "pinnedTotal"]:
            for route, result in scored[metric]["byRoute"].items():
                baseline = result["baseline"]["mae"]; delta = result["delta"]["mae"]
                if result["episodes"] >= 30 and delta > 10 and delta > .1 * baseline:
                    failures.append({"routeId": int(route), "metric": metric, "visits": result["episodes"],
                                     "baselineMaeSec": baseline, "candidateMaeSec": result["candidate"]["mae"],
                                     "deltaSec": delta, "relativeIncrease": delta / baseline if baseline else None,
                                     "visitDelta95": result["delta95"]["mae"]})
        report["materialRouteRegressions"][name] = failures
    (args.out / "measurement-repair-report.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))

if __name__ == "__main__": main()
