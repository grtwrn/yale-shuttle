#!/usr/bin/env python3
"""Run the locked full-client confirmation in two-process, day-at-a-time batches."""
import argparse, datetime, json, os, pathlib, shutil, subprocess, sys, time

HERE = pathlib.Path(__file__).resolve().parent
SERVICE = HERE.parents[2]
ARTIFACTS = SERVICE / "scripts/.eta-replay/overnight-2026-09-08"
DAYS = ["2026-09-05", "2026-09-06", "2026-09-07"]

def run(command, log):
    with log.open("w") as out: subprocess.run(command, cwd=SERVICE, stdout=out, stderr=subprocess.STDOUT, check=True)

def main():
    parser = argparse.ArgumentParser(); parser.add_argument("--wait-for", type=pathlib.Path, action="append", default=[])
    parser.add_argument("--score-only", action="store_true", help="Require existing completed replays; never launch a replay")
    parser.add_argument("--hyphenated-days", action="store_true", help="Use YYYY-MM-DD in existing source and paired filenames")
    args = parser.parse_args()
    stamp_for = lambda day: day if args.hyphenated_days else day.replace("-", "")
    for completion in args.wait_for:
        while not completion.exists(): time.sleep(10)
    dataset = ARTIFACTS / "dataset-v2"; cohort_lock = ARTIFACTS / "served-cohort-lock.json"; model_lock = ARTIFACTS / "selection-lock.json"
    for day in DAYS:
        stamp = stamp_for(day); jobs = []; sources = {}
        for arm, prefix in [("baseline", "general-baseline"), ("candidate", "analytic")]:
            source = ARTIFACTS / f"client-{prefix}-{stamp}.jsonl.gz"; sources[arm] = source
            manifest = source.with_name(source.name.replace(".jsonl.gz", ".manifest.json"))
            if manifest.exists(): continue
            if args.score_only: raise RuntimeError(f"Missing completed replay: {manifest}")
            if source.exists(): raise RuntimeError(f"Incomplete output already exists: {source}")
            env = dict(os.environ)
            for variable in ["MODEL_PARAMS", "MAX_POSITIONS", "CONTEXT_HOOK", "ANALYTIC_FIT"]: env.pop(variable, None)
            env.update({"EVAL_DAY": day, "EVAL_DATASET": str(dataset), "EVAL_OUT": str(source),
                        "EVAL_FIT_AT": "2026-09-05T04:00:00Z", "COMPARE_COLD": "0", "POLL_STRIDE": "6",
                        "SOURCE_ROOT": str(SERVICE), "TZ": "America/New_York"})
            if arm == "candidate":
                env["CONTEXT_HOOK"] = str(HERE / "models/analytic-client-hook.ts")
                env["ANALYTIC_FIT"] = str(ARTIFACTS / "analytic/reserved-confirmation/fit.json")
            log = source.with_name(source.name.replace(".jsonl.gz", ".log")).open("w")
            process = subprocess.Popen(["nice", "-n", "10", str(SERVICE / "node_modules/.bin/tsx"), str(HERE / "client-replay.ts")],
                                       cwd=SERVICE, env=env, stdout=log, stderr=subprocess.STDOUT)
            jobs.append((arm, process, log)); print(f"{day} {arm} started pid={process.pid}", flush=True)
        failures = []
        for arm, process, log in jobs:
            code = process.wait(); log.close()
            if code: failures.append((arm, code))
            print(f"{day} {arm} exited {code}", flush=True)
        if failures: raise RuntimeError(f"Replay failures: {failures}")
        manifests = [json.loads(path.with_name(path.name.replace(".jsonl.gz", ".manifest.json")).read_text()) for path in sources.values()]
        if manifests[0]["sourceHashes"] != manifests[1]["sourceHashes"]: raise RuntimeError("Baseline and candidate source hashes differ")
        out = ARTIFACTS / f"client-reserved-{stamp}-paired"
        run([sys.executable, str(HERE / "compare_client.py"), "--baseline", str(sources["baseline"]), "--candidate", str(sources["candidate"]),
             "--dataset", str(dataset), "--day", day, "--out", str(out), "--cohort-lock", str(cohort_lock), "--candidate-lock", str(model_lock)],
            ARTIFACTS / f"client-reserved-{stamp}-score.log")
        run([sys.executable, str(HERE / "compare_stands.py"), "--baseline", str(sources["baseline"]).replace(".jsonl.gz", ".stands.jsonl.gz"),
             "--candidate", str(sources["candidate"]).replace(".jsonl.gz", ".stands.jsonl.gz"), "--dataset", str(dataset), "--day", day,
             "--out", str(out / "display-score.json")], ARTIFACTS / f"client-reserved-{stamp}-display-score.log")
        print(f"{day} paired and scored", flush=True)
    aggregate = ARTIFACTS / "client-reserved-paired"; aggregate.mkdir(exist_ok=True)
    coverage = {}
    for day in DAYS:
        folder = ARTIFACTS / f"client-reserved-{stamp_for(day)}-paired"
        coverage[day] = json.loads((folder / "coverage.json").read_text())
    (aggregate / "coverage-by-day.json").write_text(json.dumps(coverage, indent=2) + "\n")
    for arm, prefix in [("baseline", "general-baseline"), ("candidate", "analytic")]:
        with (aggregate / f"{arm}.matched.jsonl.gz").open("wb") as out:
            for day in DAYS:
                with (ARTIFACTS / f"client-reserved-{stamp_for(day)}-paired/{arm}.matched.jsonl.gz").open("rb") as source: shutil.copyfileobj(source, out)
        with (aggregate / f"{arm}.stands.jsonl.gz").open("wb") as out:
            for day in DAYS:
                with (ARTIFACTS / f"client-{prefix}-{stamp_for(day)}.stands.jsonl.gz").open("rb") as source: shutil.copyfileobj(source, out)
        (aggregate / f"{arm}.manifest.json").write_text(json.dumps({"completedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(), "days": DAYS}) + "\n")
    run([sys.executable, str(HERE / "score.py"), "--baseline", str(aggregate / "baseline.matched.jsonl.gz"),
         "--candidate", str(aggregate / "candidate.matched.jsonl.gz"), "--out", str(aggregate / "score.json"),
         "--candidate-lock", str(model_lock), "--bus-day-sensitivity"], aggregate / "score.log")
    command = [sys.executable, str(HERE / "compare_stands.py"), "--baseline", str(aggregate / "baseline.stands.jsonl.gz"),
               "--candidate", str(aggregate / "candidate.stands.jsonl.gz"), "--dataset", str(dataset), "--out", str(aggregate / "display-score.json")]
    for day in DAYS: command += ["--day", day]
    run(command, aggregate / "display-score.log")
    print("Reserved full-client confirmation complete", flush=True)

if __name__ == "__main__": main()
