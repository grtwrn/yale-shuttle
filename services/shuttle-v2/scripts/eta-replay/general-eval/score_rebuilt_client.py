#!/usr/bin/env python3
"""Score completed, label-only client reruns sequentially; never launch a model."""
import argparse, json, pathlib, shutil, subprocess, sys, time

HERE = pathlib.Path(__file__).resolve().parent
BASE = HERE.parents[2] / "scripts/.eta-replay/overnight-2026-09-08"

def invoke(command, log):
    with log.open("w") as out: subprocess.run(["nice", "-n", "10", sys.executable] + command, stdout=out, stderr=subprocess.STDOUT, check=True)

def main():
    p = argparse.ArgumentParser(); p.add_argument("--days", default="2026-09-04,2026-09-05,2026-09-06,2026-09-07,2026-09-08")
    args = p.parse_args(); days = args.days.split(","); dataset = BASE / "dataset-v2"; rebuild = BASE / "label-rebuild-client-v1"
    for day in days:
        suffix = "dev" if day == "2026-09-04" else day
        current = {side: BASE / f"client-repaired-{prefix}-{suffix}.stands.jsonl.gz" for side, prefix in [("baseline", "baseline"), ("candidate", "analytic")]}
        original_suffix = "dev" if day == "2026-09-04" else "regression-published" if day == "2026-09-08" else day
        original = {side: BASE / f"client-{prefix}-{original_suffix}.stands.jsonl.gz" for side, prefix in [("baseline", "general-baseline"), ("candidate", "analytic")]}
        manifests = []
        for source in current.values():
            path = pathlib.Path(str(source).replace(".stands.jsonl.gz", ".manifest.json"))
            while not path.exists(): time.sleep(5)
            manifests.append(json.loads(path.read_text()))
        label_manifest = json.loads((rebuild / day / "manifest.json").read_text())
        lock = pathlib.Path(label_manifest["lockFile"]); frozen = json.loads(lock.read_text())
        patterns = lambda xs: {x["routeId"]: x for x in xs}
        for manifest in manifests:
            if patterns(manifest["networkPatterns"]) != patterns(frozen["networkPatterns"]): raise ValueError(f"Replay/label canonical geometry differs on {day}")
        if manifests[0]["sourceHashes"] != manifests[1]["sourceHashes"]: raise ValueError(f"Replay arms differ in source hashes on {day}")
        output = BASE / f"client-repaired-{day}-comparison"
        invoke([str(HERE / "compare_rebuilt_stands.py"), "--baseline", str(current["baseline"]), "--candidate", str(current["candidate"]),
                "--original-baseline", str(original["baseline"]), "--original-candidate", str(original["candidate"]),
                "--dataset", str(dataset), "--day", day, "--labels", str(rebuild / day / "episodes.jsonl.gz"),
                "--matches", str(rebuild / day / "matches.jsonl.gz"), "--label-lock", str(lock), "--out", str(output)],
               BASE / f"client-repaired-{day}-comparison.log")
        print(f"{day} repaired display comparison complete", flush=True)
    reserved = ["2026-09-05", "2026-09-06", "2026-09-07"]
    if not all(day in days for day in reserved): return
    output = BASE / "client-repaired-reserved-comparison"; output.mkdir(exist_ok=True)
    reports = {day: json.loads((BASE / f"client-repaired-{day}-comparison/measurement-repair-report.json").read_text()) for day in reserved}
    (output / "coverage-by-day.json").write_text(json.dumps(reports, indent=2) + "\n")
    cohorts = {"full-rebuilt": "all-associated", "original-matched": "original-matched", "rebuilt-matched": "rebuilt-matched",
               "original-first-repaired-clock": "original-first-repaired-clock", "occurrence-agreement-sensitivity": "occurrence-agreement"}
    for name, suffix in cohorts.items():
        paths = []
        for side in ["baseline", "candidate"]:
            target = output / f"{side}.{name}.stands.jsonl.gz"; paths.append(target)
            with target.open("wb") as sink:
                for day in reserved:
                    source = BASE / f"client-repaired-{day}-comparison/{side}.{suffix}.stands.jsonl.gz"
                    with source.open("rb") as file: shutil.copyfileobj(file, sink)
            pathlib.Path(str(target).replace(".stands.jsonl.gz", ".manifest.json")).write_text(json.dumps({"scoringOnlyAggregate": True, "days": reserved}) + "\n")
        command = [str(HERE / "compare_stands.py"), "--baseline", str(paths[0]), "--candidate", str(paths[1]),
                   "--dataset", str(dataset), "--out", str(output / f"{name}-score.json")]
        for day in reserved:
            command += ["--day", day]
            if name != "original-matched": command += ["--episode-labels", str(rebuild / day / "episodes.jsonl.gz")]
        invoke(command, output / f"{name}.log")
    print("Repaired reserved aggregate complete", flush=True)

if __name__ == "__main__": main()
