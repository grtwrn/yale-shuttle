#!/usr/bin/env python3
"""Red Winchester covariate screen (see PLAN.md).

  python screen.py --out results/          # frozen plan: dev cutoff, folds, arms
  python screen.py --dev-smoke --out tmp/  # debugging on already-inspected days only

Writes <out>/screen-full.json (per-row records, local only) and
<out>/screen-summary.json (compact aggregates suitable for the repository).
"""
import argparse, datetime, hashlib, itertools, json, math, os, sys, time
import numpy as np
import lib, model

HERE = os.path.dirname(os.path.abspath(__file__))
DAY_MS = 86_400_000
PICKUP_AGES = (60, 180, 300, 420)
U_GRID = [(i + 0.5) / 100 for i in range(100)]
BOOT = 2000
SEED = 20261001


def day_start(day):
    y, m, d = map(int, day.split("-"))
    return datetime.datetime(y, m, d, tzinfo=lib.ET).timestamp() * 1000


def load_plan():
    with open(os.path.join(HERE, "PLAN.json")) as f:
        return json.load(f)


def make_folds(service_days, plan, dev_smoke):
    """One fold per service day (production refits on a rolling 30-day window).
    Frozen test days are plan test_from..test_to; later days are extension folds,
    scored with the same frozen code and reported separately."""
    if dev_smoke:
        days = [d for d in service_days if plan["dev_smoke_from"] <= d <= plan["dev_to"]]
        return [{"name": d, "test": [d], "kind": "dev"} for d in days]
    out = []
    for d in service_days:
        if plan["test_from"] <= d <= plan["test_to"]:
            out.append({"name": d, "test": [d], "kind": "frozen"})
        elif d > plan["test_to"]:
            out.append({"name": d, "test": [d], "kind": "extension"})
    return out


def train_for(H, first_test_day):
    before = day_start(first_test_day)
    since = before - 30 * DAY_MS
    return [h for h in H if h["ready"] < before and h["pin"] >= since]


def q_dict(f):
    return {u: f(u) for u in model.QLEVELS}


def conv_quantiles(rem_q, drives):
    """Quantiles of remaining hold + drive (independent), from a 100-point hold grid."""
    rem = np.array([rem_q(u) for u in U_GRID])
    tot = np.sort((rem[:, None] + drives[None, :]).ravel())
    n = len(tot)
    return {u: float(tot[min(n - 1, max(0, int(math.floor(u * n))))]) for u in model.QLEVELS}


def run(args):
    t0 = time.time()
    plan = load_plan()
    D = lib.RedData()
    H = D.holds()
    service_days = sorted({h["day"] for h in H})
    folds = make_folds(service_days, plan, args.dev_smoke)
    arms = list(model.ARMS)
    hold_rows, pick_rows, fold_meta = [], [], []
    for fold in folds:
        test_days = [d for d in fold["test"] if d in service_days]
        if not test_days:
            continue
        train = train_for(H, test_days[0])
        test = [h for h in H if h["day"] in test_days]
        ctx = model.Context(train)
        with np.errstate(all="ignore"):
            fits = {a: model.fit(ctx, train, a) for a in arms}
        for a, m in fits.items():
            if not np.all(np.isfinite(m["beta"])):
                raise RuntimeError(f"non-finite fit {fold['name']} {a}")
        drives = np.array([(h["div_arr"] - h["dep"]) / 1000 for h in train if h["div_arr"] is not None])
        drives = np.clip(drives, 0, 900)
        # Recalibration control for production pickup: training residuals on post-release builds.
        resid = {a: [] for a in PICKUP_AGES}
        for h in train:
            if h["day"] < plan["rcal_first_day"] or h["div_arr"] is None:
                continue
            for a in PICKUP_AGES:
                if h["y"] <= a:
                    continue
                cp = h["pin"] + a * 1000
                p = D.production_pickup(h["bus_id"], cp)
                if p:
                    resid[a].append((h["div_arr"] - p["point"]) / 1000)
        pooled = [r for v in resid.values() for r in v]
        rcal = {}
        for a in PICKUP_AGES:
            src = resid[a] if len(resid[a]) >= 30 else (pooled if len(pooled) >= 30 else None)
            rcal[a] = None if src is None else {u: float(np.quantile(src, u)) for u in model.QLEVELS}
        unsupported = {a: fits[a]["unsupported"] for a in arms if fits[a]["unsupported"]}
        fold_meta.append({
            "name": fold["name"], "kind": fold["kind"], "test_days": test_days,
            "train_days": sorted({h["day"] for h in train}), "n_train": len(train), "n_test": len(test),
            "ref_lap": ctx.ref, "dep_phase_s": ctx.dep_phase, "n_drive": int(len(drives)),
            "rcal_rows": {str(a): len(resid[a]) for a in PICKUP_AGES},
            "coef": {a: [round(float(b), 5) for b in fits[a]["beta"]] for a in arms},
            "unsupported_cols": unsupported,
        })
        for h in test:
            supported = ctx.lap_valid(h)
            dists = {a: model.Dist(ctx, fits[a], h) for a in arms}
            for age in model.AGES:
                if h["y"] <= age:
                    continue
                yrem = h["y"] - age
                for a in arms:
                    d = dists[a]
                    qs = q_dict(lambda u: d.residual_q(age, u))
                    r = model.score_row(qs, yrem)
                    r["logs"] = d.log_score(age, h["y"])
                    r.update(fold=fold["name"], kind=fold["kind"], day=h["day"], hold=h["id"], age=age, arm=a,
                             supported=supported, y=yrem, q50=qs[0.5], clu=h["day"] + "/" + h["bus"])
                    hold_rows.append(r)
            if h["div_arr"] is None:
                continue
            for age in PICKUP_AGES:
                if h["y"] <= age:
                    continue
                cp = h["pin"] + age * 1000
                truth = (h["div_arr"] - cp) / 1000
                base = dict(fold=fold["name"], kind=fold["kind"], day=h["day"], hold=h["id"], age=age,
                            supported=supported, y=truth, clu=h["day"] + "/" + h["bus"])
                p = D.production_pickup(h["bus_id"], cp)
                if p:
                    q10, q50, q90 = ((p["low"] - cp) / 1000, (p["point"] - cp) / 1000, (p["high"] - cp) / 1000)
                    pq = {0.1: q10, 0.5: q50, 0.9: q90}
                    pick_rows.append(dict(base, arm="P0", **score80(pq, truth), lag=(cp - p["at"]) / 1000))
                    if rcal[age]:
                        cq = {u: q50 + rcal[age][u] for u in (0.1, 0.5, 0.9)}
                        pick_rows.append(dict(base, arm="RCAL", **score80(cq, truth)))
                for a in arms:
                    d = dists[a]
                    qs = conv_quantiles(lambda u: d.residual_q(age, u), drives)
                    pick_rows.append(dict(base, arm="H_" + a, **score80(qs, truth), has_p0=bool(p)))
        print(f"fold {fold['name']}: train {len(train)} test {len(test)} ({time.time()-t0:.0f}s)", file=sys.stderr)
    full = {"plan_sha256": plan_hash(), "folds": fold_meta, "hold_rows": hold_rows, "pick_rows": pick_rows}
    summary = summarize(full, arms, args.dev_smoke)
    summary["decomposition"] = decomposition(D, H, service_days, args.dev_smoke)
    summary["data"] = data_manifest(D, H, service_days)
    summary["runtime_s"] = round(time.time() - t0, 1)
    summary["code_sha256"] = code_hashes()
    summary["generated_at"] = datetime.datetime.now(lib.ET).isoformat(timespec="seconds")
    os.makedirs(args.out, exist_ok=True)
    with open(os.path.join(args.out, "screen-full.json"), "w") as f:
        json.dump(full, f)
    with open(os.path.join(args.out, "screen-summary.json"), "w") as f:
        json.dump(summary, f, indent=1)
    print(json.dumps(summary["headline"], indent=1))


def score80(q, y):
    return {"wis80": model.wis80(q[0.1], q[0.5], q[0.9], y), "ae": abs(y - q[0.5]), "signed": y - q[0.5],
            "pb10": model.pinball(q[0.1], y, 0.1), "pb50": model.pinball(q[0.5], y, 0.5),
            "pb90": model.pinball(q[0.9], y, 0.9), "cover": 1.0 if q[0.1] <= y <= q[0.9] else 0.0,
            "below": 1.0 if y < q[0.1] else 0.0, "above": 1.0 if y > q[0.9] else 0.0, "width": q[0.9] - q[0.1]}


def plan_hash():
    with open(os.path.join(HERE, "PLAN.json"), "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


def code_hashes():
    out = {}
    for name in ("PLAN.json", "lib.py", "model.py", "screen.py"):
        with open(os.path.join(HERE, name), "rb") as f:
            out[name] = hashlib.sha256(f.read()).hexdigest()
    return out


# ---------------- aggregation ----------------

def paired(rows, arm, ref, metric, key=("hold", "age")):
    a = {tuple(r[k] for k in key): r for r in rows if r["arm"] == arm}
    b = {tuple(r[k] for k in key): r for r in rows if r["arm"] == ref}
    common = sorted(set(a) & set(b))
    return [(a[k]["clu"], k[0], a[k][metric], b[k][metric]) for k in common]


def cluster_boot(pairs, level=0.95, seed=SEED):
    """Checkpoint-weighted mean difference (arm - ref) with a bus-day cluster
    bootstrap CI (holds of one bus on one day share a cluster)."""
    if not pairs:
        return None
    clus = sorted({c for c, _, _, _ in pairs})
    idx = {c: i for i, c in enumerate(clus)}
    sums = np.zeros(len(clus))
    cnt = np.zeros(len(clus))
    for c, _, x, y in pairs:
        sums[idx[c]] += x - y
        cnt[idx[c]] += 1
    rng = np.random.default_rng(seed)
    w = rng.multinomial(len(clus), np.full(len(clus), 1 / len(clus)), size=BOOT)
    boot = (w @ sums) / np.maximum(w @ cnt, 1)
    lo, hi = np.quantile(boot, [(1 - level) / 2, 1 - (1 - level) / 2])
    return {"diff": float(sums.sum() / cnt.sum()), "lo": float(lo), "hi": float(hi),
            "holds": len({h for _, h, _, _ in pairs}), "clusters": len(clus), "rows": int(cnt.sum())}


def mean_of(rows, arm, metric):
    v = [r[metric] for r in rows if r["arm"] == arm]
    return (float(np.mean(v)) if v else None), len(v)


def table(rows, arms, ref, metrics, n_arms_test):
    out = {}
    for a in arms:
        e = {}
        for m in metrics:
            e[m], e["n"] = mean_of(rows, a, m)
        if a != ref:
            e["d_primary"] = cluster_boot(paired(rows, a, ref, metrics[0]))
            e["d_primary_bonf"] = cluster_boot(paired(rows, a, ref, metrics[0]), level=1 - 0.05 / n_arms_test)
        out[a] = e
    return out


def by_group(rows, arms, ref, metric, group):
    out = {}
    for g in sorted({r[group] for r in rows}):
        sub = [r for r in rows if r[group] == g]
        out[str(g)] = {a: {"mean": mean_of(sub, a, metric)[0], "n": mean_of(sub, a, metric)[1],
                           "d": (None if a == ref else (cluster_boot(paired(sub, a, ref, metric)) or {}).get("diff"))}
                       for a in arms}
    return out


def summarize(full, arms, dev_smoke):
    hr, pr = full["hold_rows"], full["pick_rows"]
    hm = ["wis", "ae", "wis80", "pb10", "pb50", "pb90", "cover", "below", "above", "width", "logs"]
    pm = ["wis80", "ae", "pb10", "pb50", "pb90", "cover", "below", "above", "width"]
    n_cand = len(arms) - 1
    s = {"plan_sha256": full["plan_sha256"], "dev_smoke": dev_smoke, "folds": full["folds"]}
    for kind in ("frozen", "extension", "dev"):
        h = [r for r in hr if r["kind"] == kind]
        if not h:
            continue
        sup = [r for r in h if r["supported"]]
        blk = {
            "hold_supported": table(sup, arms, "B0", hm, n_cand),
            "hold_all": table(h, arms, "B0", hm, n_cand),
            "hold_supported_by_fold": by_group(sup, arms, "B0", "wis", "fold"),
            "hold_supported_by_day": by_group(sup, arms, "B0", "wis", "day"),
            "hold_supported_by_age": by_group(sup, arms, "B0", "wis", "age"),
            "hold_supported_by_age_ae": by_group(sup, arms, "B0", "ae", "age"),
            "hold_supported_by_fold_logs": by_group(sup, arms, "B0", "logs", "fold"),
        }
        p = [r for r in pr if r["kind"] == kind]
        hp = {r["hold"] for r in p if r["arm"] == "P0"}
        p_with = [r for r in p if (r["arm"] in ("P0", "RCAL")) or r.get("has_p0")]
        parms = ["P0", "RCAL"] + ["H_" + a for a in arms]
        blk["pickup_vs_production"] = table(p_with, parms, "P0", pm, len(parms) - 1)
        blk["pickup_vs_production_by_fold"] = by_group(p_with, parms, "P0", "wis80", "fold")
        blk["pickup_vs_production_by_age"] = by_group(p_with, parms, "P0", "wis80", "age")
        blk["pickup_vs_production_by_age_ae"] = by_group(p_with, parms, "P0", "ae", "age")
        hall = [r for r in p if r["arm"].startswith("H_")]
        blk["pickup_hazard_all"] = table(hall, ["H_" + a for a in arms], "H_B0", pm, n_cand)
        blk["pickup_hazard_all_by_fold"] = by_group(hall, ["H_" + a for a in arms], "H_B0", "wis80", "fold")
        blk["pickup_coverage"] = {"checkpoints": len([r for r in p if r["arm"] == "H_B0"]),
                                  "with_production": len([r for r in p if r["arm"] == "P0"]),
                                  "holds_with_production": len(hp),
                                  "by_day": {d: [len([r for r in p if r["arm"] == "H_B0" and r["day"] == d]),
                                                 len([r for r in p if r["arm"] == "P0" and r["day"] == d])]
                                             for d in sorted({r["day"] for r in p})}}
        s[kind] = blk
    plan = load_plan()
    for key in ("dev", "frozen", "extension"):
        if key in s:
            s[key]["verdict"] = verdict(s[key], arms, plan["decision"])
    main = "dev" if dev_smoke else "frozen"
    if main in s:
        t = s[main]["hold_supported"]
        v = s[main]["verdict"]
        s["headline"] = {a: {"wis": round(t[a]["wis"], 2), "n": t[a]["n"], "logs": round(t[a]["logs"], 4),
                             "d": None if a == "B0" else {k: round(x, 2) for k, x in t[a]["d_primary_bonf"].items()
                                                          if k in ("diff", "lo", "hi")},
                             "days_better": None if a == "B0" else v[a]["days_better"],
                             "cover": round(t[a]["cover"], 3), "below": round(t[a]["below"], 3),
                             "above": round(t[a]["above"], 3),
                             "verdict": None if a == "B0" else v[a]["verdict"]} for a in arms}
        pv = s[main]["pickup_vs_production"]
        s["headline_pickup"] = {a: {"wis80": None if pv[a]["wis80"] is None else round(pv[a]["wis80"], 1),
                                    "n": pv[a]["n"],
                                    "d_vs_P0": None if a == "P0" or not pv[a].get("d_primary_bonf") else
                                    {k: round(x, 1) for k, x in pv[a]["d_primary_bonf"].items() if k in ("diff", "lo", "hi")}}
                                for a in pv}
    return s


def verdict(blk, arms, rule):
    """Frozen decision rule (PLAN.json "decision"). A candidate is only worth a full
    production-estimator replay; it is not a deployment decision."""
    t = blk["hold_supported"]
    by_day = blk["hold_supported_by_day"]
    out = {}
    for a in arms:
        if a == "B0":
            continue
        d = t[a]["d_primary_bonf"]
        days = [g[a]["d"] for g in by_day.values() if g[a]["d"] is not None]
        better = sum(1 for x in days if x < 0)
        need = math.ceil(rule["min_day_fraction"] * len(days))
        checks = {
            "ci_below_zero": bool(d and d["hi"] < 0),
            "days": better >= need and len(days) >= rule["min_days"],
            "early_tail": t[a]["below"] - t["B0"]["below"] <= rule["max_tail_increase"],
            "late_tail": t[a]["above"] - t["B0"]["above"] <= rule["max_tail_increase"],
            "log_score": t[a]["logs"] <= t["B0"]["logs"],
        }
        out[a] = {"days_better": f"{better}/{len(days)}", "need": need, "checks": checks,
                  "verdict": "candidate" if all(checks.values()) else "not supported"}
    return out


# ---------------- descriptive variance decomposition ----------------

def decomp_matrix(H, groups):
    ctx = model.Context(H)  # descriptive: all-days constants
    cols, names = [], []
    for g in groups:
        for j, (nm, fn) in enumerate(DECOMP_GROUPS[g]):
            cols.append([fn(ctx, h) for h in H])
            names.append(f"{g}:{nm}")
    return np.array(cols).T, names


def _lap(ctx, h):
    return (h["lap"] - ctx.ref) / 600 if ctx.lap_valid(h) else 0.0


def _phase(h, fn):
    return fn(2 * math.pi * ((h["pin"] / 1000) % 900) / 900)


def _slot(ctx, h, side):
    s = ctx.own_slot(h)
    if s is None:
        return 0.0
    return max(0.0, (s - h["pin"]) / 600000) if side > 0 else max(0.0, (h["pin"] - s) / 600000)


DECOMP_GROUPS = {
    "LAP": [("lap", _lap), ("missing", lambda c, h: 0.0 if c.lap_valid(h) else 1.0)],
    "PHASE15": [("sin", lambda c, h: _phase(h, math.sin)), ("cos", lambda c, h: _phase(h, math.cos))],
    "LL": [("slack", lambda c, h: _slot(c, h, 1)), ("late", lambda c, h: _slot(c, h, -1))],
    "W": [("wet", lambda c, h: h["feat"]["wet"]), ("temp", lambda c, h: 0.0 if h["feat"]["temp"] is None else (h["feat"]["temp"] - 20) / 10)],
    "C": [("post_end", lambda c, h: lib.class_window(h["pin"])[0]), ("pre_start", lambda c, h: lib.class_window(h["pin"])[1])],
    "FS": [("fleet_le2", lambda c, h: 1.0 if h["feat"]["fleet"] <= 2 else 0.0)],
    "SH": [("early_loop", lambda c, h: 1.0 if h["feat"]["loops_today"] <= 1 else 0.0), ("tis", lambda c, h: h["feat"]["tis_h"] / 10),
           ("new_bus", lambda c, h: h["feat"]["new_bus_30"]), ("drop", lambda c, h: h["feat"]["fleet_drop_30"])],
    "DM": [("stand", lambda c, h: (h["feat"]["dm_stand"] - c.dm_mean) / 300 if h["feat"]["dm_ok"] else 0.0),
           ("n", lambda c, h: (h["feat"]["dm_n"] - c.dn_mean) / 3 if h["feat"]["dm_ok"] else 0.0)],
    "UE": [("long", lambda c, h: 1.0 if (h["feat"]["ue48"] or 0) >= 900 else 0.0), ("missing", lambda c, h: 1.0 if h["feat"]["ue48"] is None else 0.0)],
    "CP": [("co_win", lambda c, h: h["feat"]["co_win"]), ("co_union", lambda c, h: h["feat"]["co_union"]), ("dep10", lambda c, h: h["feat"]["win_dep_10"])],
}


def r2(X, y):
    if X.shape[1] == 0:
        return 0.0
    A = np.column_stack([np.ones(len(y)), X])
    beta, *_ = np.linalg.lstsq(A, y, rcond=None)
    res = y - A @ beta
    return 1 - float(res @ res) / float(((y - y.mean()) ** 2).sum())


def shapley(H, y):
    groups = list(DECOMP_GROUPS)
    X, names = decomp_matrix(H, groups)
    gcols = {g: [i for i, n in enumerate(names) if n.startswith(g + ":")] for g in groups}
    cache = {}

    def R(sub):
        key = tuple(sorted(sub))
        if key not in cache:
            cols = [c for g in key for c in gcols[g]]
            cache[key] = r2(X[:, cols], y) if cols else 0.0
        return cache[key]

    G = len(groups)
    phi = {}
    for g in groups:
        others = [o for o in groups if o != g]
        tot = 0.0
        for k in range(G):
            w = math.factorial(k) * math.factorial(G - k - 1) / math.factorial(G)
            for S in itertools.combinations(others, k):
                tot += w * (R(S + (g,)) - R(S))
        phi[g] = tot
    base = ("LAP", "PHASE15")
    return {
        "n": len(H), "r2_all": R(tuple(groups)), "shapley": phi,
        "univariate": {g: R((g,)) for g in groups},
        "incremental_over_lap_phase": {g: R(base + (g,)) - R(base) for g in groups if g not in base},
        "r2_lap_phase": R(base),
    }


def fe_r2(H, y, key):
    levels = sorted({key(h) for h in H})
    X = np.array([[1.0 if key(h) == l else 0.0 for l in levels[1:]] for h in H])
    return r2(X, y)


def decomposition(D, H, service_days, dev_smoke=False):
    out = {}
    plan = load_plan()
    cohorts = {"all": H, "dev": [h for h in H if h["day"] <= plan["dev_to"]],
               "test": [h for h in H if plan["test_from"] <= h["day"] <= plan["test_to"]],
               "extension": [h for h in H if h["day"] > plan["test_to"]]}
    if dev_smoke:  # never touch test-period outcomes in a development run
        cohorts = {"dev": cohorts["dev"]}
        H = cohorts["dev"]
    for name, hs in cohorts.items():
        if len(hs) < 30:
            continue
        y = np.array([h["y"] for h in hs])
        e = {"hold_sd": float(y.std()), "hold_mean": float(y.mean()),
             "hold_q": {str(q): float(np.quantile(y, q)) for q in (0.1, 0.25, 0.5, 0.75, 0.9)}}
        e["seconds"] = shapley(hs, y)
        e["log"] = shapley(hs, np.log(y + 15))
        e["day_fe_r2"] = fe_r2(hs, y, lambda h: h["day"])
        e["bus_fe_r2"] = fe_r2(hs, y, lambda h: h["bus"])
        out[name] = e
    pairs = [(h["y"], (h["div_arr"] - h["dep"]) / 1000) for h in H if h["div_arr"] is not None]
    hy = np.array([p[0] for p in pairs])
    dr = np.array([p[1] for p in pairs])
    tot = hy + dr
    out["pin_to_division"] = {"n": len(pairs), "var_total": float(tot.var()), "var_hold": float(hy.var()),
                              "var_drive": float(dr.var()), "cov2": float(2 * np.cov(hy, dr, bias=True)[0, 1]),
                              "drive_q": {str(q): float(np.quantile(dr, q)) for q in (0.1, 0.5, 0.9)}}
    return out


def data_manifest(D, H, service_days):
    tabs = {}
    for d in D.days:
        m = lib.manifest(d)
        tabs[d] = {t: v.get("sha256", "")[:16] for t, v in m["tables"].items() if v.get("complete")}
    return {"archive": lib.ARCHIVE, "service_days": service_days, "holds": len(H),
            "holds_by_day": {d: sum(1 for h in H if h["day"] == d) for d in service_days},
            "selected_sha256_prefix": tabs}


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--dev-smoke", action="store_true")
    run(ap.parse_args())
