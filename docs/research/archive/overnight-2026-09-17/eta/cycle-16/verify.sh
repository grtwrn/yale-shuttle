#!/usr/bin/env bash
set -euo pipefail
out=/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/cycle-16
python3 "$out/verify_alignment.py" > "$out/alignment-verification.log" 2>&1
python3 "$out/verify_score.py" > "$out/verification.log" 2>&1
python3 "$out/verify_semantics.py" > "$out/semantic-verification.log" 2>&1
