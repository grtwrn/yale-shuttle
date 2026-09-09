#!/usr/bin/env python3
"""Prediction-blind, causal pairing of captured operator point ETAs.

Run --freeze before --score. This is a retrospective diagnostic on an already
frozen three-arm query cohort, never a fitting or model-selection operation.
"""
from __future__ import annotations
import argparse, bisect, collections, datetime, gzip, hashlib, json, math
import pathlib, platform, random, sqlite3, statistics
from served_targets import ServedTargets

HERE = pathlib.Path(__file__).resolve()
BASE = HERE.parents[2] / ".eta-replay/overnight-2026-09-08"
ARMS = ("baseline", "selected", "operator")
METRICS = ("maeSec", "biasSec", "over120", "under120")
SCENARIOS = (("strict30", 30, False), ("strict180", 180, False),
             ("sampleClockFallback180", 180, True))


def sha(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for b in iter(lambda: f.read(1024 * 1024), b""): h.update(b)
    return h.hexdigest()


def read(path):
    with gzip.open(path, "rt") as f: return [json.loads(s) for s in f if s.strip()]


def write(path, obj):
    with open(path, "x") as f: json.dump(obj, f, indent=2, sort_keys=True); f.write("\n")


def inputs(args):
    return {"database": args.db, "baseline": args.cohort / "baseline.matched.jsonl.gz",
            "selected": args.cohort / "candidate.matched.jsonl.gz",
            "cohortManifest": args.cohort / "combined.manifest.json",
            "physicalArrivals": args.arrivals, "episodes": args.arrivals.with_name("episodes.jsonl.gz"), "script": HERE,
            "causalTests": HERE.with_name("compare_operator_test.py"),
            "servedTargetSource": HERE.with_name("served_targets.py"), "servedTargetDependency": HERE.with_name("inventory.py"),
            "censusSamplerSource": HERE.parents[3] / "src/collector/upstreamEtaSampler.ts",
            "curatedSamplerSource": HERE.parents[3] / "src/collector/upstreamEta.ts"}


def spec(args):
    return {
        "kind": "retrospective-operator-diagnostic-v1", "day": "2026-09-08",
        "purpose": "Point comparison only; no fitting, blending, promotion, or new model selection.",
        "availability": "Request start sampled_at is not receipt. Single inFlight census sampler awaits response and synchronous transaction before next request. The next distinct globally recorded sampled_at conservatively bounds availability. Last request has unknown availability. Failed requests only lengthen this bound. Enforce monotonically ordered insertion/request clocks and one stop per batch.",
        "supersession": "At query time choose latest available complete census response for target stop; require one exact route_id and bus_name match in that response. A newer response omitting the bus invalidates older bus rows.",
        "clock": "Strict requires finite calc_at <= bounded availability <= issuedAt. Freshness is issuedAt - calc_at, inclusive [0,30s] primary or [0,180s] sensitivity. Null calc_at is excluded strictly; separately flagged sensitivity substitutes sampled_at only for null calc_at.",
        "point": "Operator remaining=max(0,eta_sec+(reference_at-issuedAt)/1000). Reject negative/nonfinite source eta_sec. App point is existing median(.5). No vendor prediction intervals inferred.",
        "target": "All arms use identical frozen query-target pairs. Reuse frozen ServedTargets corroboration (not incidental raw nearpasses), matching operator route, exact bus name, physical stop and first corroborated physical crossing strictly after reference_at to frozen targetArrivalId. Reject ambiguous simultaneous crossings, mismatched occurrences, or source reference before the target continuous track starts. Target labels only identify matching visits and do not enter inference.",
        "population": "Existing warm operational Sep8 matched cohort; baseline and selected sources/labels unchanged. Red11-to48 is routeId=3,currentStopId=11,stopId=48 reporting subgroup, never an eligibility or tuning exception.",
        "weighting": "Mean errors over matching queries within each targetArrivalId, then equal physical-arrival average. Same matched triples in every arm. Also report forecast-weighted diagnostics separately.",
        "uncertainty": "Paired metric-difference percentile bootstrap over whole (day,busKey) blocks, 2000 draws, seed 3701; sampled blocks retain all their physical arrivals and equal-arrival weighting. Confidence intervals describe metric differences, not vendor forecast uncertainty.",
        "coverage": "Report original query/target denominators, exclusive rejection reasons, per-route and Red11-to48 coverage. Latest response before null/stale validation; no substitution with older fresh row.",
        "curatedLog": "predictions_log surface=upstream excluded: predicted_at is vendor clock rounded to 15s; rows written after a multi-stop sweep, with no receipt/insertion clock. Cannot establish causal availability from these rows.",
        "scenarios": [dict(name=n, freshnessSec=s, nullCalcSampleFallback=f) for n,s,f in SCENARIOS],
        "bootstrap": 2000, "seed": 3701,
        "inputHashes": {k: {"path": str(p.resolve()), "sha256": sha(p)} for k,p in inputs(args).items()},
        "pythonVersion": platform.python_version(),
    }


def batches(rows):
    """Rows ordered by insertion id; validate causal single-sampler contract."""
    groups = []
    for r in rows:
        if not groups or r["sampled_at"] != groups[-1][0]["sampled_at"]:
            if groups and r["sampled_at"] <= groups[-1][0]["sampled_at"]:
                raise ValueError("Nonmonotonic census request clock; causal bound invalid")
            groups.append([])
        groups[-1].append(r)
    by_stop = collections.defaultdict(list)
    for i, g in enumerate(groups):
        stops = {r["stop_id"] for r in g}
        if len(stops) != 1: raise ValueError("Ambiguous multi-stop census batch")
        if i + 1 == len(groups): continue
        by_stop[next(iter(stops))].append({"availableAt": groups[i+1][0]["sampled_at"], "rows": g})
    return {s: ([g["availableAt"] for g in gs], gs) for s,gs in by_stop.items()}, len(groups)


def source_for(row, source, arrivals, freshness, fallback):
    clocks, gs = source.get(row["stopId"], ([], []))
    j = bisect.bisect_right(clocks, row["issuedAt"]) - 1
    if j < 0: return None, "noAvailableResponse"
    batch = gs[j]
    matches = [r for r in batch["rows"] if r["route_id"] == row["routeId"] and r["bus_name"] == row["busKey"]]
    if not matches: return None, "busAbsentLatestResponse"
    if len(matches) != 1: return None, "ambiguousBusLatestResponse"
    r = matches[0]; ref = r["calc_at"]; used_fallback = ref is None
    if ref is None:
        if not fallback: return None, "missingCalculationClock"
        ref = r["sampled_at"]
    if not isinstance(ref, (int, float)) or not math.isfinite(ref) or ref > batch["availableAt"]:
        return None, "invalidCalculationClock"
    age = (row["issuedAt"] - ref) / 1000
    if age < 0 or age > freshness: return None, "staleCalculation"
    eta = r["eta_sec"]
    if not isinstance(eta, (int, float)) or not math.isfinite(eta) or eta < 0: return None, "invalidSourceEta"
    ats, targets = arrivals.get((row["routeId"], row["busKey"], row["stopId"]), ([], []))
    i = bisect.bisect_right(ats, ref)
    if i >= len(targets): return None, "noSourceFutureTarget"
    if i+1 < len(targets) and ats[i+1] == ats[i]: return None, "ambiguousSourceFutureTarget"
    if targets[i]["id"] != row["targetArrivalId"]: return None, "differentPhysicalOccurrence"
    if ref < targets[i].get("trackStartAt", -math.inf): return None, "captureGapBeforeSource"
    return {"pointSec": max(0, eta-age), "rowId": r["id"], "sampledAt": r["sampled_at"],
            "calculatedAt": r["calc_at"], "referenceAt": ref, "availableAt": batch["availableAt"],
            "freshnessSec": age, "sampleClockFallback": used_fallback}, "matched"


def point_metrics(pred, actual):
    err = pred - actual
    return (abs(err), err, float(err > 120), float(err < -120))


def percentile(xs, p):
    xs = sorted(xs); z = (len(xs)-1)*p; lo = int(z); hi = math.ceil(z)
    return xs[lo] + (xs[hi]-xs[lo])*(z-lo)


def score(rows, draws=2000):
    if not rows: return {"queries": 0, "physicalArrivals": 0, "busDays": 0}
    grouped = collections.defaultdict(list)
    for r in rows: grouped[r["targetArrivalId"]].append(r)
    blocks = collections.defaultdict(list); visits = []
    for target, rs in sorted(grouped.items()):
        values = [statistics.mean(point_metrics(r["pointsSec"][a], r["actualSec"])[i] for r in rs) for a in ARMS for i in range(4)]
        blocks[(rs[0]["day"], rs[0]["busKey"])].append(values)
        visits.append(values)
    means = [statistics.mean(v[i] for v in visits) for i in range(12)]
    out = {"queries": len(rows), "physicalArrivals": len(visits), "busDays": len(blocks),
           "equalArrival": {a: dict(zip(METRICS, means[j*4:(j+1)*4])) for j,a in enumerate(ARMS)},
           "forecastWeighted": {a: {m: statistics.mean(point_metrics(r["pointsSec"][a],r["actualSec"])[i] for r in rows) for i,m in enumerate(METRICS)} for a in ARMS},
           "pairedDelta": {}, "pairedDelta95": {}}
    comparisons = (("selected-minus-baseline",1,0), ("operator-minus-baseline",2,0), ("operator-minus-selected",2,1))
    for name,a,b in comparisons: out["pairedDelta"][name] = {m: means[a*4+i]-means[b*4+i] for i,m in enumerate(METRICS)}
    if draws:
        compressed = [(len(vs), [sum(v[i] for v in vs) for i in range(12)]) for _,vs in sorted(blocks.items())]
        rng = random.Random(3701); boot = collections.defaultdict(list)
        for _ in range(draws):
            chosen = rng.choices(compressed, k=len(compressed)); n = sum(x[0] for x in chosen)
            sums = [sum(x[1][i] for x in chosen)/n for i in range(12)]
            for name,a,b in comparisons:
                for i,m in enumerate(METRICS): boot[(name,m)].append(sums[a*4+i]-sums[b*4+i])
        out["pairedDelta95"] = {name: {m: [percentile(boot[(name,m)],.025),percentile(boot[(name,m)],.975)] for m in METRICS} for name,_,_ in comparisons}
    return out


def is_red(row): return row["routeId"] == 3 and row.get("currentStopId") == 11 and row["stopId"] == 48


def coverage(all_rows, accepted, statuses):
    def part(original, subset):
        counts = collections.Counter(statuses[r["id"]] for r in original)
        return {"originalQueries": len(original), "matchedQueries": len(subset),
                "queryCoverage": len(subset)/len(original) if original else None,
                "originalPhysicalArrivals": len({r["targetArrivalId"] for r in original}),
                "matchedPhysicalArrivals": len({r["targetArrivalId"] for r in subset}),
                "reasons": dict(counts)}
    return {"overall": part(all_rows, accepted), "red11to48": part([r for r in all_rows if is_red(r)], [r for r in accepted if is_red(r)]),
            "byRoute": {str(route): part([r for r in all_rows if r["routeId"]==route], [r for r in accepted if r["routeId"]==route]) for route in sorted({r["routeId"] for r in all_rows})}}


def run(args):
    if any(p.name != "lock.json" for p in args.out.iterdir()): raise ValueError("Output exists; preserve completed diagnostic")
    frozen = json.loads((args.out / "lock.json").read_text())
    current = spec(args)
    if current != {k:v for k,v in frozen.items() if k != "frozenAt"}: raise ValueError("Frozen spec/input/source changed")
    original = read(args.cohort / "baseline.matched.jsonl.gz")
    candidate = {r["id"]: r for r in read(args.cohort / "candidate.matched.jsonl.gz")}
    if len(candidate) != len(original) or {r["id"] for r in original} != set(candidate): raise ValueError("Unpaired app inputs")
    served = ServedTargets(args.arrivals.parent.parent, args.arrivals.parent.name)
    arrival_rows = list(served.by_target.values()); arrival_groups = collections.defaultdict(list)
    for r in arrival_rows: arrival_groups[(r["routeId"], r["busKey"], r["stopId"])].append(r)
    arrival_index = {}
    for key, rs in arrival_groups.items():
        rs.sort(key=lambda r:(r["arrivedAt"],r["id"])); arrival_index[key] = ([r["arrivedAt"] for r in rs],rs)
    db = sqlite3.connect("file:"+str(args.db.resolve())+"?mode=ro", uri=True); db.row_factory=sqlite3.Row
    source_rows = [dict(r) for r in db.execute("select id,sampled_at,calc_at,stop_id,route_id,bus_name,eta_sec from upstream_etas order by id")]
    source, batch_n = batches(source_rows)
    source_summary = {"rows": len(source_rows), "requestBatches": batch_n,
                      "targetCohortPolicy": served.policy(),
                      "nullCalculationRows": sum(r["calc_at"] is None for r in source_rows),
                      "unknownLastRequestAvailability": True,
                      "curatedUpstreamRowsSep8Excluded": db.execute("select count(*) from predictions_log where surface='upstream' and predicted_at>=1788840000000 and predicted_at<1788926400000").fetchone()[0]}
    db.close(); results = {}
    for name, fresh, fallback in SCENARIOS:
        matched = []; statuses = {}
        for a in original:
            b = candidate[a["id"]]
            for field in ("targetArrivalId","issuedAt","actualSec","routeId","busKey","stopId"):
                if a[field] != b[field]: raise ValueError("Pair target mismatch: "+field)
            s, why = source_for(a, source, arrival_index, fresh, fallback); statuses[a["id"]] = why
            if s is None: continue
            matched.append({**{k:a[k] for k in ("id","day","busKey","routeId","stopId","targetArrivalId","issuedAt","actualSec","currentStopId")},
                            "pointsSec": {"baseline":a["quantilesSec"][a["quantileLevels"].index(.5)], "selected":b["quantilesSec"][b["quantileLevels"].index(.5)], "operator":s["pointSec"]}, "operatorSource":s})
        with gzip.open(args.out / (name+".matched.jsonl.gz"), "wt") as f:
            for r in matched: f.write(json.dumps(r,separators=(",",":"))+"\n")
        results[name] = {"coverage": coverage(original,matched,statuses), "score": score(matched),
                         "red11to48": score([r for r in matched if is_red(r)]),
                         "byRoute": {str(route):score([r for r in matched if r["routeId"]==route],0) for route in sorted({r["routeId"] for r in original})},
                         "nullClockFallbackQueries":sum(r["operatorSource"]["sampleClockFallback"] for r in matched),
                         "freshnessSec": {"median": statistics.median([r["operatorSource"]["freshnessSec"] for r in matched]) if matched else None,
                                          "max": max((r["operatorSource"]["freshnessSec"] for r in matched),default=None)}}
    write(args.out/"results.json", {"lockSha256":sha(args.out/"lock.json"),"completedAt":datetime.datetime.now(datetime.timezone.utc).isoformat(),"source":source_summary,"scenarios":results})
    write(args.out/"manifest.json", {p.name:sha(p) for p in sorted(args.out.iterdir()) if p.is_file()})
    print(json.dumps({n:{"coverage":v["coverage"]["overall"],"score":v["score"]["equalArrival"],"red":v["red11to48"]} for n,v in results.items()},indent=2))


if __name__ == "__main__":
    p = argparse.ArgumentParser(); action = p.add_mutually_exclusive_group(required=True)
    action.add_argument("--freeze",action="store_true"); action.add_argument("--score",action="store_true")
    p.add_argument("--db",type=pathlib.Path,default=BASE/"production-2026-09-09-0046.db")
    p.add_argument("--cohort",type=pathlib.Path,default=BASE/"client-operational-warm-paired")
    p.add_argument("--arrivals",type=pathlib.Path,default=BASE/"dataset-v2/2026-09-08/physical-arrivals.jsonl.gz")
    p.add_argument("--out",type=pathlib.Path,default=BASE/"operator-diagnostic-v1")
    args=p.parse_args(); args.out.mkdir(parents=True,exist_ok=True)
    if args.freeze:
        write(args.out/"lock.json", {**spec(args),"frozenAt":datetime.datetime.now(datetime.timezone.utc).isoformat()})
        print(str(args.out/"lock.json"),sha(args.out/"lock.json"))
    else: run(args)
