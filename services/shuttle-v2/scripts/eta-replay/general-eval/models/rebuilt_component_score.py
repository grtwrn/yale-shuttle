#!/usr/bin/env python3
"""Descriptive, strictly paired rescore of already frozen repaired-label forecasts.

This never fits a model or changes the selected family. All arithmetic is the
shared scorer's; fixed geometry/label strata are chosen before reading scores.
"""
from __future__ import annotations
import argparse, collections, datetime, importlib.util, json, pathlib

SCORE_PATH = pathlib.Path(__file__).resolve().parents[1] / "score.py"
spec = importlib.util.spec_from_file_location("shared_score", SCORE_PATH)
score = importlib.util.module_from_spec(spec)
spec.loader.exec_module(score)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True, type=pathlib.Path)
    parser.add_argument("--bootstrap", type=int, default=500)
    args = parser.parse_args()
    out = args.input / "descriptive-scores"
    out.mkdir(exist_ok=True)
    paths = [args.input / "analytic-stacked.jsonl", args.input / "analytic-phase.jsonl"]
    paths += sorted(args.input.glob("library-*.jsonl.gz"))
    registration = {
        "registeredAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "purpose": "Descriptive label-repair sensitivity only; no model fitting or family reselection",
        "baseline": "analytic-duration.jsonl", "arms": [p.name for p in paths],
        "inputHashes": {p.name: score.file_hash(p) for p in paths + [args.input / "analytic-duration.jsonl"]},
        "scorerSha256": score.file_hash(SCORE_PATH),
        "wrapperSha256": score.file_hash(pathlib.Path(__file__)),
        "policy": {
            "maxHorizonSec": 1800,
            "firstMoment": "Original initial component query at causal repaired pin, selected before horizon exclusions; not literal first client display",
            "weighting": "Equal episodes, equal moments within episode; shared 19-level proper quantile score",
            "bootstrap": f"{args.bootstrap} whole-episode and bus/day replicates for overall and first-query; other strata are descriptive point estimates",
            "strata": "All/first, seen/new exact pattern, route/route first, physical stop, long >=120 sec, phase/history eligibility",
            "guard": "At least30episodes, MAE worsens by both>10sec and>10%; diagnostic development guard, not promotion decision",
            "trainingAndHistory": "Original frozen Sep3 artifacts and ORIGINAL Sep4 available history; repaired current causal pin/labels only",
        },
    }
    registration_path = out / "registration.json"
    if registration_path.exists():
        old = json.loads(registration_path.read_text())
        if old["inputHashes"] != registration["inputHashes"] or old["scorerSha256"] != registration["scorerSha256"]:
            raise ValueError("Refusing to overwrite scores with changed inputs/scorer")
    else:
        registration_path.write_text(json.dumps(registration, indent=2) + "\n")
    base_rows = score.read(args.input / "analytic-duration.jsonl")
    for r in base_rows:
        score.validate(r)
        r["actualSec"] = (r["targetAt"] - r["issuedAt"]) / 1000
    base = {r["id"]: r for r in base_rows}
    if len(base) != len(base_rows): raise ValueError("Duplicate baseline keys")
    phase_context = {r["id"]: r for r in score.read(args.input / "analytic-stacked.jsonl")}
    first_ids = score.first_forecast_ids(base_rows)
    summary = {}
    for path in paths:
        name = path.name.removesuffix(".gz").removesuffix(".jsonl")
        dest = out / f"{name}.json"
        if dest.exists():
            result = json.loads(dest.read_text())
        else:
            rows = score.read(path)
            for r in rows:
                score.validate(r)
                r["actualSec"] = (r["targetAt"] - r["issuedAt"]) / 1000
            candidate = {r["id"]: r for r in rows}
            if len(candidate) != len(rows) or candidate.keys() != base.keys(): raise ValueError(f"Unpaired keys: {name}")
            pairs = []
            exclusions = collections.Counter()
            for key in sorted(base):
                a, b = base[key], candidate[key]
                for f in ("episodeId", "issuedAt", "routeId", "routePatternId", "day", "targetAt", "actualSec", "quantileLevels", "patternSeen", "totalSec", "elapsedSec"):
                    if a[f] != b[f]: raise ValueError(f"Unpaired {f}: {name}/{key}")
                if a["day"] != "2026-09-04": raise ValueError("Development only")
                if a["actualSec"] < 0: exclusions["already_arrived"] += 1
                elif a["actualSec"] > 1800: exclusions["beyond_horizon"] += 1
                else: pairs.append((a, b))
            cohorts = {
                "firstMoment": [p for p in pairs if p[0]["id"] in first_ids],
                "seenPattern": [p for p in pairs if p[0]["patternSeen"]],
                "newPattern": [p for p in pairs if not p[0]["patternSeen"]],
                "totalAtLeast120Sec": [p for p in pairs if p[0]["totalSec"] >= 120],
                "route3_stop11": [p for p in pairs if p[0]["routeId"] == 3 and p[0]["stopId"] == 11],
                "route15_stop10": [p for p in pairs if p[0]["routeId"] == 15 and p[0]["stopId"] == 10],
                "phaseAvailable": [p for p in pairs if phase_context[p[0]["id"]]["phaseAvailable"]],
                "phaseFallback": [p for p in pairs if not phase_context[p[0]["id"]]["phaseAvailable"]],
            }
            for key, ps in list(cohorts.items()):
                if key != "firstMoment": cohorts[key + "_firstMoment"] = [p for p in ps if p[0]["id"] in first_ids]
            exclusions["firstMomentsOutsideScoringHorizon"] = len(first_ids) - len(cohorts["firstMoment"])
            result = {"model": name, "inputs": registration["inputHashes"], "inputForecasts": len(rows), "inputEpisodes": len(first_ids), "exclusions": dict(exclusions),
                      "all": score.score_pairs(pairs, args.bootstrap, bus_day=True),
                      "cohorts": {k: score.score_pairs(ps, args.bootstrap if k == "firstMoment" else 0, bus_day=k == "firstMoment") for k, ps in cohorts.items()}}
            for group_name, keyfn in (("byRoute", lambda r: str(r["routeId"])), ("byPattern", lambda r: r["routePatternId"]), ("byStop", lambda r: f'{r["routeId"]}:{r["stopId"]}')):
                groups = collections.defaultdict(list)
                for pair in pairs: groups[keyfn(pair[0])].append(pair)
                result[group_name] = {k: score.score_pairs(ps, 0) for k, ps in sorted(groups.items())}
                result[group_name + "FirstMoment"] = {k: score.score_pairs([p for p in ps if p[0]["id"] in first_ids], 0) for k, ps in sorted(groups.items())}
            result["materialRouteMaeRegressions"] = {
                group: {route: {"episodes": v["episodes"], "baseline": v["baseline"]["mae"], "candidate": v["candidate"]["mae"]}
                        for route, v in result[group].items() if v["episodes"] >= 30 and v["delta"]["mae"] > 10 and v["candidate"]["mae"] > v["baseline"]["mae"] * 1.1}
                for group in ("byRoute", "byRouteFirstMoment")}
            dest.write_text(json.dumps(result, indent=2) + "\n")
        summary[name] = {"overall": result["all"], "first": result["cohorts"]["firstMoment"], "exclusions": result["exclusions"], "routeGuards": result["materialRouteMaeRegressions"]}
        print(json.dumps({"arm": name, "episodes": result["all"]["episodes"], "allMae": result["all"]["candidate"]["mae"], "allCrps": result["all"]["candidate"]["quantileCrps"], "firstMae": result["cohorts"]["firstMoment"]["candidate"]["mae"], "routeGuards": result["materialRouteMaeRegressions"]}), flush=True)
    (out / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")


if __name__ == "__main__": main()
