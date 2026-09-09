#!/usr/bin/env python3
"""Pair separate completed client replays using the frozen served cohort.

Source arms are selected explicitly (both default to continuous/warm tracking).
The immutable label adapter records missing predictions before shared scoring.
"""
import argparse, collections, datetime, gzip, hashlib, json, pathlib, subprocess, sys
from inventory import lines

HERE = pathlib.Path(__file__).resolve().parent

def digest(path):
    h = hashlib.sha256()
    with path.open("rb") as f:
        for part in iter(lambda: f.read(1024 * 1024), b""): h.update(part)
    return h.hexdigest()

def main():
    p = argparse.ArgumentParser()
    p.add_argument("--baseline", type=pathlib.Path, required=True); p.add_argument("--candidate", type=pathlib.Path, required=True)
    p.add_argument("--baseline-input-arm", default="warm"); p.add_argument("--candidate-input-arm", default="warm")
    p.add_argument("--dataset", type=pathlib.Path, required=True); p.add_argument("--day", required=True)
    p.add_argument("--out", type=pathlib.Path, required=True); p.add_argument("--cohort-lock", type=pathlib.Path, required=True)
    p.add_argument("--candidate-lock", type=pathlib.Path); p.add_argument("--bootstrap", type=int, default=2000)
    p.add_argument("--displayed-intervals", action="store_true", help="Explicitly allow negative lower displayed physical-arrival interval bounds without clipping")
    args = p.parse_args()
    lock = json.loads(args.cohort_lock.read_text())
    for path, expected in lock["sourceHashes"].items():
        source = pathlib.Path(path)
        # Locks created from the repository root remain usable from the service.
        if not source.exists(): source = HERE.parents[4] / path
        if digest(source) != expected: raise ValueError(f"Frozen cohort input changed: {source}")
        if source.name == "manifest.json" and digest(args.dataset / "manifest.json") != expected:
            raise ValueError("Requested dataset differs from the frozen cohort manifest")
    sources = [("baseline", args.baseline, args.baseline_input_arm), ("candidate", args.candidate, args.candidate_input_arm)]
    for _, source, _ in sources:
        manifest = pathlib.Path(str(source).replace(".jsonl.gz", ".manifest.json"))
        if not manifest.exists(): raise ValueError(f"Incomplete replay: missing {manifest}")
    args.out.mkdir(parents=True, exist_ok=True)
    combined = args.out / "combined.jsonl.gz"; counts = collections.Counter(); inputs = {}
    with gzip.open(combined, "wt") as out:
        for arm, source, input_arm in sources:
            inputs[arm] = {"path": str(source), "sha256": digest(source), "sourceArm": input_arm}
            for row in lines(source):
                if row.get("arm") != input_arm: continue
                row["arm"] = arm; counts[arm] += 1
                out.write(json.dumps(row, separators=(",", ":")) + "\n")
    if any(counts[arm] == 0 for arm, _, _ in sources): raise ValueError(f"Empty source arm: {dict(counts)}")
    manifest = {"completedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(), "inputs": inputs,
                "rows": dict(counts), "cohortLockSha256": digest(args.cohort_lock), "wrapperSha256": digest(pathlib.Path(__file__))}
    combined.with_name("combined.manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    subprocess.run([sys.executable, str(HERE / "pair_client.py"), str(combined), "--dataset", str(args.dataset),
                    "--day", args.day, "--out", str(args.out), "--baseline-arm", "baseline", "--candidate-arm", "candidate", "--served-cohort"], check=True)
    command = [sys.executable, str(HERE / "score.py"), "--baseline", str(args.out / "baseline.matched.jsonl.gz"),
               "--candidate", str(args.out / "candidate.matched.jsonl.gz"), "--out", str(args.out / "score.json"),
               "--bootstrap", str(args.bootstrap), "--bus-day-sensitivity"]
    if args.candidate_lock: command += ["--candidate-lock", str(args.candidate_lock)]
    if args.displayed_intervals: command += ["--displayed-intervals"]
    subprocess.run(command, check=True)

if __name__ == "__main__": main()
