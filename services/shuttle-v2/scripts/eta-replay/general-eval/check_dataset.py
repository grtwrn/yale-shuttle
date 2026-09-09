#!/usr/bin/env python3
"""Verify a frozen dataset without printing held-out outcome values or scores."""
import argparse, collections, json, pathlib
from inventory import ROOT, lines, sha

def main():
    p = argparse.ArgumentParser(); p.add_argument("dataset", type=pathlib.Path); args = p.parse_args()
    manifest_path = args.dataset / "manifest.json"; m = json.loads(manifest_path.read_text()); counts = collections.Counter(); ids = collections.defaultdict(set)
    for artifact in m["artifacts"]:
        file = pathlib.Path(artifact["path"])
        if not file.is_absolute(): file = ROOT / file
        if sha(file) != artifact["sha256"]: raise ValueError(f"Artifact hash mismatch: {file}")
        rows = list(lines(file))
        if len(rows) != artifact["rows"]: raise ValueError(f"Artifact row count mismatch: {file}")
        table = artifact["table"]; counts[f"{table}Rows"] += len(rows)
        if table == "physical-arrivals":
            for r in rows:
                assert r["id"] not in ids[table]; ids[table].add(r["id"])
                assert r["trackStartAt"] <= r["lowerBoundAt"] <= r["arrivedAt"] <= r["upperBoundAt"] == r["knownAt"]
                assert 0 < r["gapMs"] <= 30_000
                assert r["stopIndices"] and r["radiusM"] == 50
        elif table == "episodes":
            for r in rows:
                assert r["id"] not in ids[table]; ids[table].add(r["id"])
                if r["knownAt"] is not None:
                    assert r["knownAt"] <= r["observedBy"]
                    assert r["knownAt"] >= max(x for x in (r["anchoredAt"],r["pinnedAt"],r["arrivedAt"],r["departedAt"]) if x is not None)
                if r["departedAt"] is not None and r["pinnedAt"] is not None and r["departedAt"] < r["pinnedAt"]:
                    counts["invalidPinnedDepartureChronology"] += 1
                if r["nextPhysicalArrivalAt"] is not None:
                    assert r["departedAt"] <= r["nextPhysicalArrivalAt"] <= r["departedAt"] + 1_800_000
                    assert r["nextPhysicalArrivalAt"] <= r["nextPhysicalArrivalKnownAt"]
                    assert r["targetCensoring"] == "observed" and r["patternResolved"]
    result = {"manifest": str(manifest_path), "manifestSha256": sha(manifest_path), "verifiedArtifacts": len(m["artifacts"]),
              "counts": dict(counts), "outcomeValuesPrinted": False}
    output = args.dataset.parent / "dataset-check.json"; output.write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result, indent=2))

if __name__ == "__main__": main()
