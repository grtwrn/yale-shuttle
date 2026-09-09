#!/usr/bin/env python3
"""Normalize a learned component's existing forecasts to the common scorer schema."""
import argparse, gzip, json, pathlib

def main():
    p = argparse.ArgumentParser(); p.add_argument("input", type=pathlib.Path); p.add_argument("output", type=pathlib.Path); args = p.parse_args()
    opener = gzip.open if str(args.input).endswith(".gz") else open
    args.output.parent.mkdir(parents=True, exist_ok=True); n = 0
    with opener(args.input, "rt") as source, open(args.output, "w") as dest:
        for line in source:
            if not line.strip(): continue
            r = json.loads(line)
            r["id"] = f'{r["episodeId"]}@{int(r["issuedAt"])}'
            r["target"] = "remaining_stand"; r["targetAt"] = r["targetDepartureAt"]
            r["actualSec"] = (r["targetAt"] - r["issuedAt"]) / 1000
            dest.write(json.dumps(r, separators=(",", ":")) + "\n"); n += 1
    print(json.dumps({"output": str(args.output), "forecasts": n}))

if __name__ == "__main__": main()
