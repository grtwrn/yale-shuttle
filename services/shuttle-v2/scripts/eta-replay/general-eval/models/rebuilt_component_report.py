#!/usr/bin/env python3
"""Render the frozen-arm repaired-development sensitivity report, without ranking."""
import argparse, json, pathlib


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--input", required=True, type=pathlib.Path)
    args = p.parse_args()
    folder = args.input / "descriptive-scores"
    registration = json.loads((folder / "registration.json").read_text())
    results = [(name.removesuffix(".gz").removesuffix(".jsonl"), json.loads((folder / (name.removesuffix(".gz").removesuffix(".jsonl") + ".json")).read_text())) for name in registration["arms"]]
    chosen = dict(results)["analytic-stacked"]
    manifest = json.loads((args.input / "query-manifest.json").read_text())
    f = lambda n: f"{n:.2f}"
    pct = lambda n: f"{100*n:.2f}%"
    pair = lambda a, b, k: f"{f(a[k])} → {f(b[k])}"
    def rows():
        yield "duration baseline", chosen, "baseline"
        for name, result in results: yield name, result, "candidate"
    lines = [
        "# Frozen model comparison after development label repair", "",
        "This is a descriptive sensitivity analysis of the already fitted models. It does not retrain, retune, change the selected family, or establish which model family would work best if trained on corrected labels. The selected analytic model remains `analytic-phase-stack-v2`.", "",
        "The query clock and current departure truth come from the prediction-blind reconstructed September 4 episodes. Training artifacts, feature profiles, and all prior-visit records retain their original labels and availability timestamps. Queries begin at the reconstructed causal pin and recur every 30 seconds while the completed visit is stopped. This is an idealized conditional-duration component test; its initial query is **not** the literal first rider display. The separate full-client replay is needed to assess the actual UI with unchanged online inputs.", "",
        f"The common cohort contains {manifest['coverage']['eligibleEpisodes']:,} complete stopped visits and {manifest['coverage']['points']:,} queries from {manifest['coverage']['sourceEpisodes']:,} reconstructed episodes. There are {manifest['coverage']['censored']:,} censored episodes and {manifest['coverage']['otherOutcome']:,} other outcomes outside this stopped cohort. Exact training patterns were seen for {manifest['coverage']['seenPatternEpisodes']:,} visits and were new for {manifest['coverage']['newPatternEpisodes']:,}; no occurrence is relabeled to force a match. The 30-minute horizon excludes {chosen['exclusions'].get('beyond_horizon',0):,} rows and {chosen['exclusions']['firstMomentsOutsideScoringHorizon']:,} original initial queries.", "",
        "All rows are paired by episode, issue time, physical target, and the same 19 midpoint quantiles. Scores weight visits equally, then issued moments equally within a visit. Lower MAE and quantile CRPS are better. Over/under mean errors exceeding 120 seconds in either direction. Coverage uses the interpolated 10th–90th percentile interval. The shared scorer supplies all arithmetic. Overall and initial-query intervals use 500 whole-visit and vehicle/day bootstrap replicates; route and other strata are descriptive estimates.", "",
        "## All remaining-time queries", "",
        "| Frozen arm | MAE, s | qCRPS, s | 80% coverage | Over >120s | Under >120s |",
        "|---|---:|---:|---:|---:|---:|",
    ]
    for name, result, arm in rows():
        m = result["all"][arm]
        lines.append(f"| {name} | {f(m['mae'])} | {f(m['quantileCrps'])} | {pct(m['coverage80'])} | {pct(m['over120'])} | {pct(m['under120'])} |")
    lines += ["", "`analytic-phase` is the unshrunk phase-only diagnostic. It was not the selected model. The stacked arm learns when to retain the duration prior.", "", "## Initial component query and long waits", "", "| Frozen arm | Initial MAE, s | Initial qCRPS, s | Over >120s | Under >120s | Initial MAE when total ≥120s, s |", "|---|---:|---:|---:|---:|---:|"]
    for name, result, arm in rows():
        m = result["cohorts"]["firstMoment"][arm]
        long = result["cohorts"]["totalAtLeast120Sec_firstMoment"][arm]
        lines.append(f"| {name} | {f(m['mae'])} | {f(m['quantileCrps'])} | {pct(m['over120'])} | {pct(m['under120'])} | {f(long['mae'])} |")
    lines += ["", "## Exact-pattern coverage sensitivity", "", "The new-pattern stratum has the same query coverage in every arm, but model fallback and extrapolation differ. Its pooled score is not evidence of occurrence-level generalization. The seen-pattern stratum is reported separately to expose that distinction.", "", "| Frozen arm | Seen-pattern MAE / qCRPS, s | New-pattern MAE / qCRPS, s | Seen initial MAE, s | New initial MAE, s |", "|---|---:|---:|---:|---:|"]
    for name, result, arm in rows():
        c = result["cohorts"]
        seen, new = c["seenPattern"][arm], c["newPattern"][arm]
        lines.append(f"| {name} | {f(seen['mae'])} / {f(seen['quantileCrps'])} | {f(new['mae'])} / {f(new['quantileCrps'])} | {f(c['seenPattern_firstMoment'][arm]['mae'])} | {f(c['newPattern_firstMoment'][arm]['mae'])} |")
    lines += ["", "## Selected model checks", ""]
    a = chosen["all"]
    lines.append(f"The selected stacked model changes overall MAE {pair(a['baseline'], a['candidate'], 'mae')} seconds and qCRPS {pair(a['baseline'], a['candidate'], 'quantileCrps')} seconds. The 95% vehicle/day bootstrap interval for the MAE difference is {a['delta95BusDay']['mae'][0]:.2f} to {a['delta95BusDay']['mae'][1]:.2f} seconds across {a['busDayBlocks']} blocks. These development sensitivity intervals do not replace prospective confirmation.")
    lines += ["", "| Initial component cohort | Visits | Baseline MAE, s | Selected MAE, s | Baseline over / under >120s | Selected over / under >120s |", "|---|---:|---:|---:|---:|---:|"]
    selected_groups = [("All", chosen["cohorts"]["firstMoment"]), ("Long ≥120s", chosen["cohorts"]["totalAtLeast120Sec_firstMoment"]), ("Red at Winchester", chosen["cohorts"]["route3_stop11_firstMoment"]), ("Gold route", chosen["byRouteFirstMoment"]["15"])]
    for name, v in selected_groups:
        a, b = v["baseline"], v["candidate"]
        lines.append(f"| {name} | {v['episodes']} | {f(a['mae'])} | {f(b['mae'])} | {pct(a['over120'])} / {pct(a['under120'])} | {pct(b['over120'])} / {pct(b['under120'])} |")
    lines += ["", "The prespecified route guard flags at least 30 visits with MAE worsening by both more than 10 seconds and more than 10%. It is applied separately to all moments and initial queries here. The selected stacked model has no material route regression in this repaired component cohort. Complete route and occurrence scores remain in each JSON.", "", "| Frozen arm | All-moment material route regressions | Initial-query material route regressions |", "|---|---|---|"]
    topology = json.loads((args.input.parent / "dataset-v2/topology.json").read_text())
    names = {str(r["id"]): r["name"] for r in topology["routes"]}
    for name, result in results:
        values = []
        for cohort in ("byRoute", "byRouteFirstMoment"):
            guards = result["materialRouteMaeRegressions"][cohort]
            values.append("; ".join(f"{names.get(k,k)} (+{v['candidate']-v['baseline']:.1f}s)" for k, v in guards.items()) or "None")
        lines.append(f"| {name} | {values[0]} | {values[1]} |")
    lines += ["", "## Interpretation and reproducibility", "",
        "The corrected labels can change comparisons because the old start timestamps sometimes omitted real waiting, and because requerying begins earlier. Thus the original legacy-label ranking cannot by itself establish that a library model is unsuitable. Conversely, these frozen models were trained on that same imperfect label process, and correcting query truth does not repair their training. A fair claim about the strongest library family requires correctly labeled training and a new predeclared prospective comparison. No such retraining or new selection is performed here.", "",
        "All nine sklearn artifacts were preserved. Before corrected queries, 64 deterministic original initial queries per arm reproduced their saved predictions exactly; the normalized arm's maximum discrepancy was floating-point dust (2.84e-14 seconds). Coherent duration arms retain their previously declared atom-preserving survival decoder. Direct remaining arms retain their original decoder. Source, model, profile, original-history, label, and prediction hashes are registered in the adjacent manifests.", "",
        "Run from `services/shuttle-v2`:", "", "```sh",
        "REBUILT_LABELS=scripts/.eta-replay/overnight-2026-09-08/label-rebuild-component-v2/2026-09-04 REBUILT_COMPONENT_OUT=scripts/.eta-replay/overnight-2026-09-08/rebuilt-component-development-v2 node --import tsx scripts/eta-replay/general-eval/models/analytic-rebuilt-components.ts",
        "python3 scripts/eta-replay/general-eval/models/learned_rebuilt_components.py --input scripts/.eta-replay/overnight-2026-09-08/rebuilt-component-development-v2",
        "python3 scripts/eta-replay/general-eval/models/rebuilt_component_score.py --input scripts/.eta-replay/overnight-2026-09-08/rebuilt-component-development-v2 --bootstrap 500",
        "python3 scripts/eta-replay/general-eval/models/rebuilt_component_report.py --input scripts/.eta-replay/overnight-2026-09-08/rebuilt-component-development-v2",
        "```", "", "Emission tools refuse to overwrite frozen forecasts; use a new output directory for independent reproduction. Original study results remain untouched.", "",
    ]
    (args.input / "README.md").write_text("\n".join(lines))
    print(args.input / "README.md")


if __name__ == "__main__": main()
