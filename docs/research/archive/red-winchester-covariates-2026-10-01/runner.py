#!/usr/bin/env python3
"""Repeatable runner for the Red Winchester covariate experiments.

  runner.py            daily: frozen screen over every archived day + rider extraction
  runner.py --rider    hourly: rider extraction only

The screen re-reads the nightly production archive (RED_EXP_ARCHIVE, default
/Users/grtwrn/shuttle-archive, read-only). Days after the frozen test period become
extension folds scored by the same frozen code; they are reported separately and never
change the frozen verdict. Before running, the PLAN and analysis code are checked
against FREEZE.json; a mismatch is reported as "plan drift" in run.json.

Outputs (outside the repo): <root>/results/runs/<stamp>/ (screen-full.json,
screen-summary.json, run.json), <root>/results/latest -> that run, <root>/rider/.
Exit status is non-zero if a step fails.
"""
import argparse, datetime, hashlib, json, os, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.environ.get("RED_EXP_ROOT", "/Users/grtwrn/.openclaw/yale-shuttle-team/red-experiments")
PY = os.environ.get("RED_EXP_PY", os.path.join(ROOT, "venv", "bin", "python"))
FROZEN = ("PLAN.json", "lib.py", "model.py", "screen.py")


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
    rc_screen = step([PY, os.path.join(HERE, "screen.py"), "--out", run_dir], log)
    rc_rider = step([PY, os.path.join(HERE, "rider_extract.py"), "--out", os.path.join(ROOT, "rider")], log)
    run = {"stamp": stamp, "freeze": fc, "screen_exit": rc_screen, "rider_exit": rc_rider}
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
                      "extension_days": ext.get("days", []), "run": os.path.join(run_dir, "run.json")}))
    sys.exit(rc_screen or rc_rider)


if __name__ == "__main__":
    main()
