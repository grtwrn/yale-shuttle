#!/usr/bin/env bash
set -euo pipefail
out=/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/review-round-15
for step in score verify_alignment verify_score verify_semantics compare_labels zero_hop_inventory; do
  python3 "$out/$step.py" > "$out/$step.log" 2>&1
done
