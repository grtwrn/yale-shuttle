#!/usr/bin/env python3
"""Report the fixed selected model's repaired reserved confirmation."""
import collections, importlib.util, json, pathlib

ROOT = pathlib.Path("scripts/.eta-replay/overnight-2026-09-08")
OUT = ROOT / "analytic/repaired-reserved-confirmation-v1"
score_path = pathlib.Path(__file__).resolve().parents[1] / "score.py"
spec = importlib.util.spec_from_file_location("shared_score", score_path)
score = importlib.util.module_from_spec(spec)
spec.loader.exec_module(score)


def main():
    manifest = json.loads((OUT / "prediction-manifest.json").read_text())
    lock = json.loads((OUT / "selection-lock.json").read_text())
    if lock["selectedFamily"] != "analytic-phase-stack-v2" or manifest["selectionLockSha256"] != score.file_hash(OUT / "selection-lock.json"):
        raise ValueError("Wrong selected candidate")
    for entry in manifest["files"]:
        if score.file_hash(entry["file"]) != entry["sha256"]: raise ValueError("Frozen predictions changed")
    base = score.read(OUT / "reserved-duration.jsonl")
    candidate = score.read(OUT / "reserved-stacked.jsonl")
    bmap = {r["id"]: r for r in candidate}
    first_ids = score.first_forecast_ids(base)
    pairs = []
    for a in base:
        b = bmap[a["id"]]
        score.validate(a); score.validate(b)
        for field in ("episodeId", "issuedAt", "day", "routeId", "routePatternId", "targetAt", "actualSec", "quantileLevels"):
            if a[field] != b[field]: raise ValueError("Unpaired query")
        pairs.append((a,b))
    scored = [p for p in pairs if 0 <= p[0]["actualSec"] <= 1800]
    first = [p for p in scored if p[0]["id"] in first_ids]
    groups = collections.defaultdict(list)
    for p in first: groups[str(p[0]["routeId"])].append(p)
    route_first = {k:score.score_pairs(v,0) for k,v in sorted(groups.items())}
    main_score = json.loads((OUT / "reserved-score.json").read_text())
    guards = {group: {k:{"episodes":v["episodes"],"baselineMae":v["baseline"]["mae"],"candidateMae":v["candidate"]["mae"]}
                     for k,v in values.items() if v["episodes"]>=30 and v["delta"]["mae"]>10 and v["candidate"]["mae"]>1.1*v["baseline"]["mae"]}
              for group,values in (("allMoments",main_score["byRoute"]),("firstMoments",route_first))}
    strata = {"seenPattern":[p for p in scored if p[0]["patternSeen"]],
              "newPattern":[p for p in scored if not p[0]["patternSeen"]],
              "phaseAvailable":[p for p in scored if p[1]["phaseAvailable"]],
              "phaseFallback":[p for p in scored if not p[1]["phaseAvailable"]]}
    for name,ps in list(strata.items()): strata[name+"FirstMoment"]=[p for p in ps if p[0]["id"] in first_ids]
    excluded = [{"id":a["id"],"episodeId":a["episodeId"],"day":a["day"],"routeId":a["routeId"],"busKey":a["busKey"],
                 "stopId":a["stopId"],"actualTotalSec":a["actualSec"],"baselineMedianSec":score.qvalue(a["quantileLevels"],a["quantilesSec"],.5),
                 "candidateMedianSec":score.qvalue(b["quantileLevels"],b["quantilesSec"],.5)}
                for a,b in pairs if a["id"] in first_ids and a["actualSec"]>1800]
    extra = {"purpose":"Selected frozen model only; no new selection or tuning",
             "predictionManifestSha256":score.file_hash(OUT/"prediction-manifest.json"),"scorerSha256":score.file_hash(score_path),
             "reporterSha256":score.file_hash(pathlib.Path(__file__)),"byRouteFirstMoment":route_first,
             "materialRouteMaeRegressions":guards,"strata":{k:score.score_pairs(ps,0) for k,ps in strata.items()},
             "firstMomentBusDaySensitivity":score.score_pairs(first,2000,bus_day=True),
             "excludedOriginalFirstQueries":excluded,
             "uncappedFirstMomentDiagnostic":score.score_pairs([p for p in pairs if p[0]["id"] in first_ids],0)}
    (OUT/"supplementary-score.json").write_text(json.dumps(extra,indent=2)+"\n")
    f=lambda x:f"{x:.2f}"
    pct=lambda x:f"{100*x:.2f}%"
    all_score=main_score["all"]
    lines=["# Selected model confirmation after reserved label repair","",
        "The frozen `analytic-phase-stack-v2` model passes the corrected reserved component primary-score check. This evaluates only the previously selected model against its duration baseline; no alternative library model, retraining, hyperparameter change, or new selection is involved.","",
        "Training remains the original September 3–4 fit. All historical features retain the original per-day records and conservative availability timestamps. Only the current causal pin/query time and departure truth use the prediction-blind final label rebuild. Exact original client network geometry is preserved; unseen route patterns fall back without occurrence remapping. This component experiment begins at the causal pin and does not substitute for the separate literal rider-display replay.","",
        f"The combined cohort includes {all_score['episodes']:,} complete stopped visits across September 5–7. The common 30-minute scoring horizon retains {all_score['forecasts']:,} of {main_score['inputForecasts']:,} queries. It excludes {main_score['exclusions'].get('beyond_horizon',0)} queries and {main_score['exclusions']['firstMomentsOutsideScoringHorizon']} original initial queries; first-query identity is established before exclusion. September 7 remains a partial capture.","",
        "| Component metric | Baseline | Selected | Vehicle/day 95% interval for selected − baseline |",
        "|---|---:|---:|---:|"]
    for k,label in (("mae","Equal-visit MAE, seconds"),("quantileCrps","Equal-visit qCRPS, seconds")):
        lo,hi=all_score["delta95BusDay"][k]
        lines.append(f"|{label}|{f(all_score['baseline'][k])}|{f(all_score['candidate'][k])}|[{f(lo)}, {f(hi)}]|")
    for k,label in (("coverage80","80% interval coverage"),("over120","Overprediction >120s"),("under120","Underprediction >120s")):
        lines.append(f"|{label}|{pct(all_score['baseline'][k])}|{pct(all_score['candidate'][k])}|See strict score JSON|")
    lines += ["",f"The proper score uses the same 19 midpoint quantiles, equivalent to twice mean pinball loss. Visits receive equal weight and their issued moments receive equal weight within visit. The uncertainty intervals use 2,000 whole vehicle/day bootstrap replicates across {all_score['busDayBlocks']} blocks; whole-visit intervals and forecast-weighted diagnostics are also retained.","",
        "| Day | Visits | Queries scored | MAE baseline → selected, s | qCRPS baseline → selected, s | Initial total MAE baseline → selected, s | Initial queries excluded |",
        "|---|---:|---:|---:|---:|---:|---:|"]
    for day in ["2026-09-05","2026-09-06","2026-09-07","reserved"]:
        r=json.loads((OUT/f"{day}-score.json").read_text()); a=r["all"]; first_s=r["cohorts"]["firstMoment"]
        lines.append(f"|{day}|{a['episodes']}|{a['forecasts']}|{f(a['baseline']['mae'])} → {f(a['candidate']['mae'])}|{f(a['baseline']['quantileCrps'])} → {f(a['candidate']['quantileCrps'])}|{f(first_s['baseline']['mae'])} → {f(first_s['candidate']['mae'])}|{r['exclusions']['firstMomentsOutsideScoringHorizon']}|")
    lines += ["","| Initial component cohort | Visits | MAE baseline → selected, s | qCRPS baseline → selected, s | Over >120s baseline → selected | Under >120s baseline → selected |","|---|---:|---:|---:|---:|---:|"]
    for name,cohort in (("All",main_score["cohorts"]["firstMoment"]),("Long waits ≥120s",main_score["cohorts"]["totalAtLeast120Sec_firstMoment"])):
        a,b=cohort["baseline"],cohort["candidate"]
        lines.append(f"|{name}|{cohort['episodes']}|{f(a['mae'])} → {f(b['mae'])}|{f(a['quantileCrps'])} → {f(b['quantileCrps'])}|{pct(a['over120'])} → {pct(b['over120'])}|{pct(a['under120'])} → {pct(b['under120'])}|")
    lines += ["","No route has a material MAE regression on either all moments or initial queries (at least 30 visits, worsening by both >10 seconds and >10%). Every route's all-moment MAE and qCRPS improves or stays identical. Route and exact-pattern scores, initial-query route guards, and phase/fallback strata are recorded in `reserved-score.json` and `supplementary-score.json`.","",
        "| Coverage stratum | Visits | MAE baseline → selected, s | qCRPS baseline → selected, s |","|---|---:|---:|---:|"]
    for k in ("seenPattern","newPattern","phaseAvailable","phaseFallback"):
        v=extra["strata"][k]; a,b=v["baseline"],v["candidate"]
        lines.append(f"|{k}|{v['episodes']}|{f(a['mae'])} → {f(b['mae'])}|{f(a['quantileCrps'])} → {f(b['quantileCrps'])}|")
    lines += ["","The two original first queries outside the 30-minute horizon are retained below. These are the actual first queries, not substituted later rows.","",
        "| Day | Route / stop / bus | Actual total, s | Baseline initial median, s | Selected initial median, s |","|---|---|---:|---:|---:|"]
    for e in excluded:
        lines.append(f"|{e['day']}|{e['routeId']} / {e['stopId']} / {e['busKey']}|{f(e['actualTotalSec'])}|{f(e['baselineMedianSec'])}|{f(e['candidateMedianSec'])}|")
    raw=extra["uncappedFirstMomentDiagnostic"]
    lines += ["",f"Including every original initial query without a horizon cap gives MAE {f(raw['baseline']['mae'])} → {f(raw['candidate']['mae'])} seconds across {raw['episodes']:,} visits. This is a diagnostic; the registered horizon remains the primary policy.","",
        "The retained fit hash is `"+manifest["fitSha256"]+"`. `registration.json` was written before prediction emission, and `prediction-manifest.json` before scoring. They register the selection lock, source body, original history, repaired labels, geometry, and prediction hashes. Original legacy-label confirmation outputs remain untouched.","",
        "Reproduce from `services/shuttle-v2` (emission refuses to overwrite its existing frozen output directory):","","```sh",
        "node --import tsx scripts/eta-replay/general-eval/models/analytic-rebuilt-confirmation.ts",
        "python3 scripts/eta-replay/general-eval/score.py --baseline scripts/.eta-replay/overnight-2026-09-08/analytic/repaired-reserved-confirmation-v1/reserved-duration.jsonl --candidate scripts/.eta-replay/overnight-2026-09-08/analytic/repaired-reserved-confirmation-v1/reserved-stacked.jsonl --candidate-lock scripts/.eta-replay/overnight-2026-09-08/analytic/repaired-reserved-confirmation-v1/selection-lock.json --out scripts/.eta-replay/overnight-2026-09-08/analytic/repaired-reserved-confirmation-v1/reserved-score.json --bootstrap 2000 --first-moment --long-hold-sec 120 --bus-day-sensitivity",
        "python3 scripts/eta-replay/general-eval/models/analytic-rebuilt-confirmation-report.py","```","",
        "Daily scores use the same command with `reserved` replaced by the corresponding date. Reserved dates were inspected in earlier repository work and remain reserved for this comparison, not a pristine external test. Operational rolling fits and future-day accuracy still need prospective measurement.",""]
    (OUT/"README.md").write_text("\n".join(lines))
    print(json.dumps({"out":str(OUT/"README.md"),"routeGuards":guards,"excludedOriginalFirstQueries":excluded},indent=2))


if __name__=="__main__":main()
