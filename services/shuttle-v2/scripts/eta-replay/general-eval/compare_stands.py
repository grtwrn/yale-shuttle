#!/usr/bin/env python3
"""Compare actual rider standing displays against completed physical departures."""
import argparse, collections, json, math, pathlib
from inventory import lines
from score import file_hash, first_forecast_ids, score_pairs

def point_only(value):
    if isinstance(value, dict):
        return {k: point_only(v) for k, v in value.items() if k not in {"coverage80", "width80", "quantileCrps"}}
    if isinstance(value, list): return [point_only(v) for v in value]
    return value

def forecast(row, episode, mode):
    issued = row["issuedAt"]
    if mode == "remaining": prediction = row["shown"]["sec"]
    elif mode == "pinnedTotal": prediction = row["shown"]["typicalSec"]; issued = episode["pinnedAt"]
    else: prediction = row["shown"]["typicalSec"] - row["elapsedSec"]
    return {"id": row["id"], "episodeId": row["episodeId"], "issuedAt": issued,
            "day": episode["day"], "routeId": episode["routeId"], "routePatternId": episode["routePatternId"],
            "stopId": episode["stopId"], "busKey": episode["busKey"], "targetAt": episode["departedAt"],
            "actualSec": (episode["departedAt"] - issued) / 1000,
            "quantileLevels": [.1, .5, .9], "quantilesSec": [prediction] * 3}

def main():
    p = argparse.ArgumentParser(); p.add_argument("--baseline", required=True, type=pathlib.Path)
    p.add_argument("--candidate", required=True, type=pathlib.Path); p.add_argument("--dataset", required=True, type=pathlib.Path)
    p.add_argument("--day", required=True, action="append", help="Repeat to aggregate completed days"); p.add_argument("--out", required=True, type=pathlib.Path)
    p.add_argument("--episode-labels", type=pathlib.Path, action="append", help="Explicit separately frozen scoring-only episode files; original dataset remains the default")
    p.add_argument("--baseline-arm", default="warm"); p.add_argument("--candidate-arm", default="warm")
    p.add_argument("--bootstrap", type=int, default=2000); args = p.parse_args()
    label_paths = args.episode_labels or [args.dataset / day / "episodes.jsonl.gz" for day in args.day]
    episodes = {r["id"]: r for path in label_paths for r in lines(path)}
    maps = []; counts = {}; sources = [("baseline", args.baseline, args.baseline_arm), ("candidate", args.candidate, args.candidate_arm)]
    for name, source, arm in sources:
        completion = pathlib.Path(str(source).replace(".stands.jsonl.gz", ".manifest.json"))
        if not completion.exists(): raise ValueError(f"Incomplete client replay: missing {completion}")
        keyed = {}; c = collections.Counter()
        for row in lines(source):
            if row.get("arm") != arm: continue
            c["inputRows"] += 1; e = episodes.get(row["episodeId"]); shown = row.get("shown")
            if not e or e["pinnedAt"] is None or e["departedAt"] is None: c["missingPhysicalLabel"] += 1; continue
            if not e["pinnedAt"] <= row["issuedAt"] < e["departedAt"]: c["outsidePhysicalStand"] += 1; continue
            if not shown or shown.get("remaining") is not True or any(not isinstance(shown.get(k), (int, float)) or not math.isfinite(shown[k]) for k in ["sec", "typicalSec"]):
                c["missingDisplay"] += 1; continue
            if row["id"] in keyed: raise ValueError(f"Duplicate {name} key {row['id']}")
            keyed[row["id"]] = row
        c["eligibleRows"] = len(keyed); c["eligibleVisits"] = len({r["episodeId"] for r in keyed.values()})
        maps.append(keyed); counts[name] = dict(c)
    common = maps[0].keys() & maps[1].keys()
    for name, m in zip(["baseline", "candidate"], maps): counts[name]["unmatchedEligibleKeys"] = len(m.keys() - common)
    first = [first_forecast_ids(m.values()) for m in maps]; first_common = first[0] & first[1] & common
    result = {"inputs": {name: {"path": str(source), "sha256": file_hash(source)} for name, source, _ in sources},
              "episodeLabels": [{"path": str(path), "sha256": file_hash(path)} for path in label_paths],
              "coverage": {"arms": counts, "pairedMoments": len(common), "sameOriginalFirstDisplayVisits": len(first_common),
                           "firstDisplayNotPaired": {name: len(ids - first_common) for name, ids in zip(["baseline", "candidate"], first)}},
              "policy": {"metrics": "Point forecasts only: no interval or CRPS claim; equal visits and whole vehicle/day sensitivity",
                         "remaining": "Physical departedAt minus issuedAt; never subtract browser elapsed from stored pinned total",
                         "pinnedTotal": "First displayed typical total against physical departedAt minus pinnedAt",
                         "observedClockTotal": "First displayed typical total shifted by each arm's observed elapsed; compares the implied physical departure",
                         "first": "Only original first display at an identical issue key in both arms; first-display coverage differences remain explicit"}}
    for mode, keys in [("remaining", common), ("pinnedTotal", first_common), ("observedClockTotal", first_common)]:
        pairs = []
        for key in sorted(keys):
            a, b = maps[0][key], maps[1][key]
            for field in ["episodeId", "issuedAt", "routeId", "stopId", "busKey"]:
                if a[field] != b[field]: raise ValueError(f"Pair metadata mismatch {field}: {key}")
            e = episodes[a["episodeId"]]; pairs.append((forecast(a, e, mode), forecast(b, e, mode)))
        groups = {"all": pairs, "redStop11": [ps for ps in pairs if ps[0]["routeId"] == 3 and ps[0]["stopId"] == 11],
                  "totalAtLeast120Sec": [ps for ps in pairs if (episodes[ps[0]["episodeId"]]["departedAt"] - episodes[ps[0]["episodeId"]]["pinnedAt"]) >= 120000]}
        result[mode] = {name: point_only(score_pairs(ps, args.bootstrap, bus_day=True)) for name, ps in groups.items()}
        by_route = collections.defaultdict(list)
        for ps in pairs: by_route[str(ps[0]["routeId"])].append(ps)
        result[mode]["byRoute"] = {r: point_only(score_pairs(ps, min(args.bootstrap, 1000))) for r, ps in sorted(by_route.items())}
    args.out.parent.mkdir(parents=True, exist_ok=True); args.out.write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps({"out": str(args.out), "coverage": result["coverage"], "firstPinnedTotal": result["pinnedTotal"]["all"]}, indent=2))

if __name__ == "__main__": main()
