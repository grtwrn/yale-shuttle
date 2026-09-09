#!/usr/bin/env python3
"""Paired forecast scoring, equal episode weights, and whole-episode bootstrap.

Accepts ScoredForecast JSONL (optionally gzip). The same forecast keys, physical
targets and quantile levels must be present in both arms. No tuning is performed.
"""
from __future__ import annotations
import argparse, bisect, collections, gzip, hashlib, json, math, pathlib, random, statistics

METRICS = ("mae", "bias", "quantileCrps", "coverage80", "width80", "over120", "under120")

def read(path):
    opener = gzip.open if str(path).endswith(".gz") else open
    with opener(path, "rt") as f:
        if str(path).endswith(".json"):
            obj = json.load(f); return obj if isinstance(obj, list) else obj["rows"]
        return [json.loads(l) for l in f if l.strip()]

def file_hash(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for b in iter(lambda: f.read(1024 * 1024), b""): h.update(b)
    return h.hexdigest()

def percentile(xs, p):
    if not xs: return None
    a = sorted(xs); z = (len(a) - 1) * p; lo = int(z); hi = math.ceil(z)
    return a[lo] + (a[hi] - a[lo]) * (z - lo)

def qvalue(levels, qs, p):
    if p <= levels[0]: return qs[0]
    if p >= levels[-1]: return qs[-1]
    i = bisect.bisect_left(levels, p)
    return qs[i - 1] + (qs[i] - qs[i - 1]) * (p - levels[i - 1]) / (levels[i] - levels[i - 1])

def validate(r, displayed_intervals=False):
    for key in ("id", "episodeId", "issuedAt", "day", "routeId", "routePatternId", "targetAt", "actualSec", "quantileLevels", "quantilesSec"):
        if key not in r: raise ValueError(f"Missing {key} in forecast {r.get('id')}")
    ps, qs = r["quantileLevels"], r["quantilesSec"]
    if len(ps) != len(qs) or len(ps) < 3: raise ValueError(f"Invalid quantile vector: {r['id']}")
    if not all(isinstance(x, (int, float)) and math.isfinite(x) for x in ps + qs): raise ValueError("Nonfinite quantile")
    if not all(isinstance(r[k], (int, float)) and math.isfinite(r[k]) for k in ("targetAt", "issuedAt", "actualSec")): raise ValueError("Nonfinite clock/target")
    # The UI's conformal widening can put its lower displayed interval bound
    # below zero. This explicit mode preserves that bound and its raw width;
    # it does not make negative component-distribution quantiles admissible.
    displayed = displayed_intervals and r.get("target") == "physical_arrival" and ps == [.1, .5, .9]
    if any(q < 0 for q in (qs[1:] if displayed else qs)):
        raise ValueError("Negative remaining-time quantile")
    if not all(0 < p < 1 for p in ps) or any(a >= b for a, b in zip(ps, ps[1:])): raise ValueError("Unordered levels")
    if any(a > b for a, b in zip(qs, qs[1:])): raise ValueError("Crossing quantiles must be resolved before scoring")
    if ps[0] > .1 or ps[-1] < .9: raise ValueError("Need the 10th and 90th percentiles for common coverage")
    if abs((r["targetAt"] - r["issuedAt"]) / 1000 - r["actualSec"]) > .002: raise ValueError("Target/actual clock mismatch")

def row_metrics(r):
    y = r["actualSec"]; ps = r["quantileLevels"]; qs = r["quantilesSec"]
    med = qvalue(ps, qs, .5); lo = qvalue(ps, qs, .1); hi = qvalue(ps, qs, .9); e = med - y
    # Midpoint quadrature of proper quantile scores. On the shared 19 midpoint
    # levels this is exactly twice mean pinball loss, with no invented tails.
    crps = None
    if len(ps) >= 9:
        bounds = [0.] + [(a+b)/2 for a, b in zip(ps, ps[1:])] + [1.]
        crps = 2 * sum((bounds[i+1]-bounds[i]) * (p - (y < q)) * (y-q) for i, (p, q) in enumerate(zip(ps, qs)))
    return {"mae": abs(e), "bias": e, "quantileCrps": crps, "coverage80": float(lo <= y <= hi),
            "width80": hi-lo, "over120": float(e > 120), "under120": float(e < -120)}

def avg(rows, key):
    a = [r[key] for r in rows if r[key] is not None]
    return statistics.mean(a) if a else None

def first_forecast_ids(rows):
    """Choose issue zero before horizon exclusions can hide a long total wait."""
    first = {}
    for row in rows:
        key = row["episodeId"]
        if key not in first or row["issuedAt"] < first[key]["issuedAt"]: first[key] = row
    return {r["id"] for r in first.values()}

def score_pairs(pairs, bootstrap=2000, seed=908, bus_day=False):
    if not pairs: return {"forecasts": 0, "episodes": 0}
    groups = collections.defaultdict(list)
    for a, b in pairs: groups[a["episodeId"]].append((a, b))
    visits = []; forecast_metrics = {"baseline": [], "candidate": []}
    for key, ps in sorted(groups.items()):
        row = {"episodeId": key, "n": len(ps), "block": f'{ps[0][0]["day"]}|{ps[0][0].get("busKey", "missing")}' }
        for name, ix in [("baseline", 0), ("candidate", 1)]:
            ms = [row_metrics(p[ix]) for p in ps]
            forecast_metrics[name].extend(ms)
            row[name] = {m: avg(ms, m) for m in METRICS}
        visits.append(row)
    out = {"forecasts": len(pairs), "episodes": len(visits), "baseline": {}, "candidate": {}, "delta": {}, "delta95": {}}
    for arm in ("baseline", "candidate"):
        out[arm] = {m: avg([v[arm] for v in visits], m) for m in METRICS}
        out[arm]["anyOver120Episodes"] = sum(v[arm]["over120"] > 0 for v in visits)
        out[arm]["anyUnder120Episodes"] = sum(v[arm]["under120"] > 0 for v in visits)
    out["forecastWeighted"] = {arm: {**{m: avg(ms, m) for m in METRICS}, "p90AbsoluteError": percentile([r["mae"] for r in ms], .9)} for arm, ms in forecast_metrics.items()}
    rng = random.Random(seed); deltas = {}; sampled = {}
    for m in METRICS:
        ds = [v["candidate"][m] - v["baseline"][m] if v["candidate"][m] is not None and v["baseline"][m] is not None else None for v in visits]
        if any(d is None for d in ds): out["delta"][m] = out["delta95"][m] = None; continue
        out["delta"][m] = statistics.mean(ds); deltas[m] = ds; sampled[m] = []
    for _ in range(bootstrap):
        sample = rng.choices(range(len(visits)), k=len(visits))
        for m, ds in deltas.items(): sampled[m].append(sum(ds[i] for i in sample) / len(sample))
    for m, bs in sampled.items(): out["delta95"][m] = [percentile(bs, .025), percentile(bs, .975)] if bs else None
    if bus_day:
        if any("busKey" not in p[0] for p in pairs): raise ValueError("Bus/day sensitivity requires busKey")
        blocks = collections.defaultdict(list)
        for i, v in enumerate(visits): blocks[v["block"]].append(i)
        block_list = list(blocks.values()); block_samples = {m: [] for m in deltas}; rng_block = random.Random(seed + 1)
        for _ in range(bootstrap):
            selected = rng_block.choices(block_list, k=len(block_list)); count = sum(map(len, selected))
            for m, ds in deltas.items(): block_samples[m].append(sum(ds[i] for group in selected for i in group) / count)
        out["busDayBlocks"] = len(block_list)
        out["delta95BusDay"] = {m: [percentile(bs, .025), percentile(bs, .975)] if bs and len(block_list) >= 2 else None for m, bs in block_samples.items()}
        if len(block_list) < 2: out["busDayIntervalUnavailable"] = "A single vehicle/day cannot provide a clustered uncertainty interval"
    out["visitMaeChanges"] = {"improve": sum(v["candidate"]["mae"] < v["baseline"]["mae"] - 1e-9 for v in visits),
                              "unchanged": sum(abs(v["candidate"]["mae"] - v["baseline"]["mae"]) <= 1e-9 for v in visits),
                              "worsen": sum(v["candidate"]["mae"] > v["baseline"]["mae"] + 1e-9 for v in visits)}
    return out

def main():
    p = argparse.ArgumentParser(); p.add_argument("--baseline", required=True, type=pathlib.Path); p.add_argument("--candidate", required=True, type=pathlib.Path)
    p.add_argument("--out", required=True, type=pathlib.Path); p.add_argument("--bootstrap", type=int, default=2000)
    p.add_argument("--max-horizon-sec", type=float, default=1800); p.add_argument("--candidate-lock", type=pathlib.Path)
    p.add_argument("--route-stop", action="append", default=[], help="Diagnostic cohort routeId:stopId; repeatable")
    p.add_argument("--long-hold-sec", type=float, help="Diagnostic cohort by totalSec, never an input feature")
    p.add_argument("--first-moment", action="store_true", help="Also score the first shared moment per episode")
    p.add_argument("--bus-day-sensitivity", action="store_true", help="Additional whole-vehicle/day clustered interval across routes")
    p.add_argument("--displayed-intervals", action="store_true", help="Preserve a negative lower bound only for physical-arrival displayed [0.1,0.5,0.9] intervals; median and upper must be nonnegative")
    args = p.parse_args(); arms = [read(args.baseline), read(args.candidate)]
    maps = []
    for rows in arms:
        keyed = {}
        for r in rows:
            validate(r, displayed_intervals=args.displayed_intervals)
            # Integer epoch clocks are the common truth; subtraction of a
            # previously rounded total and elapsed can differ by floating dust.
            r["actualSec"] = (r["targetAt"] - r["issuedAt"]) / 1000
            if r["id"] in keyed: raise ValueError(f"Duplicate forecast key {r['id']}")
            keyed[r["id"]] = r
        maps.append(keyed)
    if maps[0].keys() != maps[1].keys():
        raise ValueError(f"Paired keys differ: baseline-only={len(maps[0].keys()-maps[1].keys())}, candidate-only={len(maps[1].keys()-maps[0].keys())}; fix cohorts before scoring")
    reserved = sorted({r["day"] for r in arms[0] if r["day"] in ("2026-09-05", "2026-09-06", "2026-09-07")})
    if reserved:
        if not args.candidate_lock: raise ValueError("Reserved outcomes require --candidate-lock with frozen candidateHashes and selectedAt")
        lock = json.loads(args.candidate_lock.read_text())
        if not lock.get("candidateHashes") or not lock.get("selectedAt"): raise ValueError("Incomplete candidate lock")
    pairs = []; exclusions = collections.Counter()
    for key in sorted(maps[0]):
        a, b = maps[0][key], maps[1][key]
        for field in ("episodeId", "issuedAt", "routeId", "routePatternId", "day", "targetAt", "actualSec", "quantileLevels"):
            if a[field] != b[field]: raise ValueError(f"Pair differs on {field}: {key}")
        if a["actualSec"] < 0: exclusions["already_arrived"] += 1; continue
        if a["actualSec"] > args.max_horizon_sec: exclusions["beyond_horizon"] += 1; continue
        pairs.append((a, b))
    result = {"inputs": {"baseline": {"path": str(args.baseline), "sha256": file_hash(args.baseline)},
                         "candidate": {"path": str(args.candidate), "sha256": file_hash(args.candidate)},
                         "scorerSha256": file_hash(pathlib.Path(__file__))},
              "policy": {"weighting": "equal episodes, equal issued moments within episode; forecastWeighted reported separately", "positiveError": "forecast gives too much time / actual arrival earlier than forecast",
                         "interval": "95% percentile bootstrap of whole episodes; adjacent visits/day may remain correlated",
                         "quantileCrps": "midpoint weighted pinball quadrature; exactly2*mean pinball on19 midpoint levels; null below9 levels",
                         "reservedDays": reserved, "bootstrapReplicates": args.bootstrap},
              "inputForecasts": len(arms[0]), "exclusions": dict(exclusions), "all": score_pairs(pairs, args.bootstrap, bus_day=args.bus_day_sensitivity)}
    result["policy"]["displayedIntervals"] = "raw displayed bounds preserved, including negative lower bounds; no clipping and no CRPS claim" if args.displayed_intervals else "strict nonnegative distribution quantiles"
    result["displayedIntervalDiagnostics"] = {
        name: {"negativeLowerInputRows": sum(r["quantilesSec"][0] < 0 for r in rows),
               "minimumInputLowerSec": min((r["quantilesSec"][0] for r in rows), default=None),
               "negativeLowerScoredRows": sum(pair[index]["quantilesSec"][0] < 0 for pair in pairs)}
        for index, (name, rows) in enumerate(zip(["baseline", "candidate"], arms))}
    for label, keyfn in [("byRoute", lambda r: str(r["routeId"])), ("byPattern", lambda r: r["routePatternId"]), ("byDay", lambda r: r["day"])]:
        groups = collections.defaultdict(list)
        for pair in pairs: groups[keyfn(pair[0])].append(pair)
        result[label] = {k: score_pairs(ps, min(args.bootstrap, 1000)) for k, ps in sorted(groups.items())}
    eligible_routes = {k: v for k, v in result["byRoute"].items() if v["episodes"] >= 10}
    macro = {"minimumEpisodesPerRoute": 10, "routes": sorted(eligible_routes), "baseline": {}, "candidate": {}, "delta": {}}
    for arm in ("baseline", "candidate"):
        macro[arm] = {m: avg([v[arm] for v in eligible_routes.values()], m) for m in METRICS}
    macro["delta"] = {m: macro["candidate"][m] - macro["baseline"][m] if macro["candidate"][m] is not None and macro["baseline"][m] is not None else None for m in METRICS}
    result["macroRoute"] = macro
    cohorts = {}
    for value in args.route_stop:
        route, stop = map(int, value.split(":"))
        cohorts[f"route{route}_stop{stop}"] = [p for p in pairs if p[0]["routeId"] == route and p[0].get("stopId") == stop]
    if args.long_hold_sec is not None:
        if not all("totalSec" in p[0] for p in pairs): raise ValueError("--long-hold-sec requires totalSec metadata")
        cohorts[f"totalAtLeast{args.long_hold_sec:g}Sec"] = [p for p in pairs if p[0]["totalSec"] >= args.long_hold_sec]
    if args.first_moment:
        first_ids = first_forecast_ids(arms[0])
        for name, ps in list(cohorts.items()): cohorts[f"{name}_firstMoment"] = [p for p in ps if p[0]["id"] in first_ids]
        cohorts["firstMoment"] = [p for p in pairs if p[0]["id"] in first_ids]
        result["policy"]["firstMoment"] = "original first issued moment per episode, selected before horizon exclusions"
        result["exclusions"]["firstMomentsOutsideScoringHorizon"] = len(first_ids) - len(cohorts["firstMoment"])
    result["cohorts"] = {name: score_pairs(ps, args.bootstrap) for name, ps in cohorts.items()}
    args.out.parent.mkdir(parents=True, exist_ok=True); args.out.write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps({"out": str(args.out), "all": result["all"], "exclusions": result["exclusions"]}, indent=2))

if __name__ == "__main__": main()
