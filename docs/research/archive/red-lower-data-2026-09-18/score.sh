#!/bin/bash
set -euo pipefail
O=/home/gwarren/projects/yale-shuttle-watcher/red-lower-data-2026-09-18
python "$O/pair.py" > "$O/pair-validation.json"
python /home/gwarren/projects/yale-shuttle-watcher/red-window-data/full-path-score.py --pairs "$O/pairs.jsonl" --db /home/gwarren/projects/yale-shuttle-watcher/release-integration-data/outcomes-complete.db --out "$O/score.json" --min-warm-sec 600 > "$O/score.log"
python "$O/summarize.py" > "$O/summary.log"
