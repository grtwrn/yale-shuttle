#!/usr/bin/env python3
"""Apply identical physical cohorts to a completed multi-arm rider replay.

Only after coverage gaps are written explicitly are common-key files produced.
The full-ETA cluster is a destination physical arrival, not an origin dwell.
"""
import argparse, collections, gzip, json, pathlib
from build_dataset import distance
from inventory import lines
from served_targets import ServedTargets

def main():
    p = argparse.ArgumentParser(); p.add_argument("input", type=pathlib.Path); p.add_argument("--dataset", required=True, type=pathlib.Path)
    p.add_argument("--day", required=True); p.add_argument("--out", required=True, type=pathlib.Path)
    p.add_argument("--baseline-arm", default="warm"); p.add_argument("--candidate-arm", default="cold")
    p.add_argument("--served-cohort", action="store_true", help="Corroborate crossings with recorded visits and restrict to the next 1–5 served occurrences")
    args = p.parse_args()
    completion = pathlib.Path(str(args.input).replace(".jsonl.gz", ".manifest.json"))
    if not completion.exists(): raise SystemExit(f"Replay still incomplete: missing {completion}")
    arms = [args.baseline_arm, args.candidate_arm]; keyed = {a: {} for a in arms}; counts = {a: collections.Counter() for a in arms}
    topology = json.loads((args.dataset / "topology.json").read_text()); stops = {s["id"]: s for s in topology["stops"]}
    served = ServedTargets(args.dataset, args.day) if args.served_cohort else None
    positions = {}; ambiguous = set()
    for r in lines(args.dataset / args.day / "positions.jsonl.gz"):
        key = (r["route_id"], r["bus_name"], r["collected_at"])
        if key in positions: ambiguous.add(key)
        positions[key] = r
    for r in lines(args.input):
        arm = r.get("arm")
        if arm not in keyed: continue
        c = counts[arm]; c["inputRows"] += 1
        key = (r["routeId"], r["busKey"], r["issuedAt"]); pos = positions.get(key); stop = stops.get(r["stopId"])
        if key in ambiguous: c["ambiguousCurrentPosition"] += 1; continue
        if not pos or not stop: c["missingCurrentPositionOrStop"] += 1; continue
        d = distance(pos, stop)
        if d <= 50: c["alreadyWithin50m"] += 1; continue
        if r["actualSec"] < 0: c["alreadyArrivedClock"] += 1; continue
        if r["actualSec"] > 1800: c["beyond30min"] += 1; continue
        if served:
            label, reason = served.classify(r)
            if reason: c[reason] += 1; continue
            r["geographicStopIndex"] = r.get("stopIndex", -1)
            r["forecastRoutePatternId"] = r["routePatternId"]
            r["stopIndex"] = label["servedStopIndex"]
            r["routePatternId"] = label["servedRoutePatternId"]
            r["servedVisitId"] = label["servedVisitId"]
            r["servedOccurrencesAhead"] = label["servedOccurrencesAhead"]
            r["patternResolved"] = label["patternResolved"]
        if r.get("stopIndex", -1) < 0: c["ambiguousOccurrenceRetained"] += 1
        r["originEpisodeId"] = r["episodeId"]
        r["episodeId"] = r["targetArrivalId"]
        r["currentDistanceToTargetM"] = d
        if r["id"] in keyed[arm]: raise ValueError(f"Duplicate {arm} key {r['id']}")
        keyed[arm][r["id"]] = r; c["eligibleRows"] += 1
    ka, kb = set(keyed[arms[0]]), set(keyed[arms[1]]); common = ka & kb
    args.out.mkdir(parents=True, exist_ok=True)
    files = {}
    for arm in arms:
        file = args.out / f"{arm}.matched.jsonl.gz"; files[arm] = str(file)
        with gzip.open(file, "wt") as f:
            for key in sorted(common): f.write(json.dumps(keyed[arm][key], separators=(",", ":")) + "\n")
        orphan = set(keyed[arm]) - common
        with gzip.open(args.out / f"{arm}.unmatched.jsonl.gz", "wt") as f:
            for key in sorted(orphan): f.write(json.dumps(keyed[arm][key], separators=(",", ":")) + "\n")
        counts[arm]["unmatchedEligibleKeys"] = len(orphan)
    # Main paired files retain repeated geographic targets, labelled explicitly;
    # a sensitivity subset excludes unresolved sequence occurrences in both arms.
    unique = {k for k in common if all(keyed[a][k].get("stopIndex", -1) >= 0 for a in arms)}
    for arm in arms:
        with gzip.open(args.out / f"{arm}.unique-occurrences.jsonl.gz", "wt") as f:
            for key in sorted(unique): f.write(json.dumps(keyed[arm][key], separators=(",", ":")) + "\n")
    report = {"input": str(args.input), "sourceManifest": str(completion), "day": args.day, "arms": {k: dict(v) for k,v in counts.items()},
              "commonEligibleKeys": len(common), "commonUniqueOccurrenceKeys": len(unique), "outputs": files,
              "policy": {"alreadyArrived": "identical raw GPS distance<=50m exclusion for both arms",
                         "cluster": "targetArrivalId; preserve originEpisodeId and currentVisitId for diagnostics",
                         "unmatched": "explicit files/counts, never silently treated as paired or successful",
                         "repeatedStops": "served visit resolves the occurrence" if served else "retained geographic-target primary plus unique-occurrence sensitivity; no direction inference invented"}}
    if served: report["policy"]["servedCohort"] = served.policy()
    (args.out / "coverage.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))

if __name__ == "__main__": main()
