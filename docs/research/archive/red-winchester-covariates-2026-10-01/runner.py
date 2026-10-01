#!/usr/bin/env python3
"""Repeatable runner for the Red Winchester covariate experiments.

  runner.py            daily: frozen screen over every archived day + rider extraction
  runner.py --rider    hourly: rider extraction only

The screen re-reads the nightly production archive (RED_EXP_ARCHIVE, default
/Users/grtwrn/shuttle-archive, read-only). Days after the frozen test period become
extension folds scored by the same frozen code; they are reported separately and never
change the frozen verdict. Before running, the PLAN and analysis code are checked
against FREEZE.json and the frozen run's weather files against WEATHER-INPUTS.json;
a mismatch is reported as "plan drift" in run.json.

Weather: each daily run saves Open-Meteo's completed past hours as
<weather>/forecast-YYYY-MM-DD.json, then requires 06:00-19:00 ET on every usable
archive day. Missing hours are reported as "weather_gaps" (W, ALL and ALL_R would
otherwise score those days without weather).

Outputs (outside the repo): <root>/results/runs/<stamp>/ (screen-full.json,
screen-summary.json, run.json), <root>/results/latest -> that run, <root>/rider/.
Exit status is non-zero if a step fails, on plan drift, or on weather gaps.
"""
import argparse, datetime, hashlib, json, os, subprocess, sys, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.environ.get("RED_EXP_ROOT", "/Users/grtwrn/.openclaw/yale-shuttle-team/red-experiments")
PY = os.environ.get("RED_EXP_PY", os.path.join(ROOT, "venv", "bin", "python"))
FROZEN = ("PLAN.json", "lib.py", "model.py", "screen.py")
WEATHER_REQUIRED_HOURS = range(6, 20)
# No __pycache__ inside the published archive folder (verify_archive.py lists every file).
sys.dont_write_bytecode = True
os.environ["PYTHONDONTWRITEBYTECODE"] = "1"
sys.path.insert(0, HERE)
import lib  # noqa: E402  (stdlib only; same ARCHIVE / WEATHER_DIR resolution as the screen)


def sha256(path):
    return hashlib.sha256(open(path, "rb").read()).hexdigest()


def weather_fetch(now):
    """Save Open-Meteo's completed past hours (never forecasts) for this run's date."""
    path = os.path.join(lib.WEATHER_DIR, f"forecast-{now:%Y-%m-%d}.json")
    if os.path.exists(path):  # keep the day's first fetch; later hours come from tomorrow's
        return None
    url = json.load(open(os.path.join(HERE, "WEATHER-INPUTS.json")))["fetch"]
    try:
        with urllib.request.urlopen(url, timeout=60) as r:
            d = json.load(r)
    except Exception as e:  # coverage check below decides whether this matters
        return f"{type(e).__name__}: {e}"
    h = d["hourly"]
    cut = now.strftime("%Y-%m-%dT%H:00")
    keep = [i for i, t in enumerate(h["time"]) if t <= cut]
    d["hourly"] = {k: [v[i] for i in keep] for k, v in h.items()}
    d["fetched_at"] = now.isoformat()
    os.makedirs(lib.WEATHER_DIR, exist_ok=True)
    with open(path + ".tmp", "w") as f:
        json.dump(d, f)
    os.replace(path + ".tmp", path)
    return None


def weather_check():
    """Frozen weather file hashes, hashes of every weather input, and per-day gaps."""
    rec = json.load(open(os.path.join(HERE, "WEATHER-INPUTS.json")))["sha256"]
    drift = []
    for n, want in rec.items():
        p = os.path.join(lib.WEATHER_DIR, n)
        if not os.path.exists(p) or sha256(p) != want:
            drift.append(f"weather:{n}")
    names = sorted(n for n in os.listdir(lib.WEATHER_DIR) if n.endswith(".json")) if os.path.isdir(lib.WEATHER_DIR) else []
    # forecast-recent.json (fetched 2026-10-01 11:53 ET) holds forecasts for that afternoon, so
    # only the archive file and the daily past-hours fetches count as coverage.
    seen = set()
    for n in names:
        if n == "forecast-recent.json":
            continue
        h = json.load(open(os.path.join(lib.WEATHER_DIR, n))).get("hourly") or {}
        seen.update(t for t, p, T in zip(h.get("time", []), h.get("precipitation", []), h.get("temperature_2m", []))
                    if p is not None and T is not None)
    gaps = {}
    for day in lib.usable_days():
        miss = [hr for hr in WEATHER_REQUIRED_HOURS if f"{day}T{hr:02d}:00" not in seen]
        if miss:
            gaps[day] = f"{len(miss)} of {len(WEATHER_REQUIRED_HOURS)} hours missing"
    return {"dir": lib.WEATHER_DIR, "sha256": {n: sha256(os.path.join(lib.WEATHER_DIR, n)) for n in names}}, drift, gaps


def freeze_check():
    rec = json.load(open(os.path.join(HERE, "FREEZE.json")))
    now = {n: hashlib.sha256(open(os.path.join(HERE, n), "rb").read()).hexdigest() for n in FROZEN}
    drift = [n for n in FROZEN if now[n] != rec["code_sha256"].get(n)]
    return {"plan_sha256": rec["plan_sha256"], "frozen_at": rec["frozen_at"], "drift": drift}


def step(cmd, log):
    with open(log, "a") as f:
        f.write(f"$ {' '.join(cmd)}\n")
        f.flush()
        p = subprocess.run(cmd, stdout=f, stderr=subprocess.STDOUT, cwd=HERE)
    return p.returncode


def compact(summary):
    """Extension-period headline (days after the frozen test period)."""
    ext = summary.get("extension")
    if not ext:
        return None
    t, v = ext["hold_supported"], ext["verdict"]
    out = {"days": [f["name"] for f in summary["folds"] if f["kind"] == "extension"], "hold": {}, "pickup_vs_production": {}}
    for a, e in t.items():
        d = e.get("d_primary")
        out["hold"][a] = {"wis": round(e["wis"], 2), "n": e["n"],
                          "d": d and {k: round(d[k], 2) for k in ("diff", "lo", "hi")},
                          "days_better": v.get(a, {}).get("days_better"), "verdict": v.get(a, {}).get("verdict")}
    for a, e in ext["pickup_vs_production"].items():
        d = e.get("d_primary")
        out["pickup_vs_production"][a] = {"wis80": None if e["wis80"] is None else round(e["wis80"], 1), "n": e["n"],
                                          "d_vs_P0": d and {k: round(d[k], 1) for k in ("diff", "lo", "hi")}}
    out["pickup_coverage"] = ext["pickup_coverage"]
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--rider", action="store_true", help="rider extraction only")
    a = ap.parse_args()
    stamp = datetime.datetime.now().strftime("%Y%m%dT%H%M%S")
    rc = 0
    if a.rider:
        log = os.path.join(ROOT, "rider", "extract.log")
        os.makedirs(os.path.dirname(log), exist_ok=True)
        rc = step([PY, os.path.join(HERE, "rider_extract.py"), "--out", os.path.join(ROOT, "rider")], log)
        print(json.dumps({"rider_extract_exit": rc, "log": log}))
        sys.exit(rc)

    run_dir = os.path.join(ROOT, "results", "runs", stamp)
    os.makedirs(run_dir, exist_ok=True)
    log = os.path.join(run_dir, "run.log")
    fc = freeze_check()
    fetch_error = weather_fetch(datetime.datetime.now(lib.ET))
    weather, wdrift, gaps = weather_check()
    fc["drift"] += wdrift
    rc_screen = step([PY, os.path.join(HERE, "screen.py"), "--out", run_dir], log)
    rc_rider = step([PY, os.path.join(HERE, "rider_extract.py"), "--out", os.path.join(ROOT, "rider")], log)
    run = {"stamp": stamp, "freeze": fc, "weather": weather, "weather_fetch_error": fetch_error,
           "weather_gaps": gaps, "screen_exit": rc_screen, "rider_exit": rc_rider}
    if rc_screen == 0:
        s = json.load(open(os.path.join(run_dir, "screen-summary.json")))
        run["service_days"] = s["data"]["service_days"]
        run["frozen_headline"] = s.get("headline")
        run["extension"] = compact(s)
        latest = os.path.join(ROOT, "results", "latest")
        tmp = latest + ".tmp"
        if os.path.lexists(tmp):
            os.remove(tmp)
        os.symlink(os.path.join("runs", stamp), tmp)
        os.replace(tmp, latest)
    rs = os.path.join(ROOT, "rider", "rider-summary.json")
    if rc_rider == 0 and os.path.exists(rs):
        run["rider"] = json.load(open(rs))
    with open(os.path.join(run_dir, "run.json"), "w") as f:
        json.dump(run, f, indent=1)
    ext = run.get("extension") or {}
    print(json.dumps({"stamp": stamp, "screen_exit": rc_screen, "rider_exit": rc_rider, "drift": fc["drift"],
                      "weather_gaps": gaps, "weather_fetch_error": fetch_error,
                      "extension_days": ext.get("days", []), "run": os.path.join(run_dir, "run.json")}))
    sys.exit(rc_screen or rc_rider or (1 if fc["drift"] or gaps else 0))


if __name__ == "__main__":
    main()
