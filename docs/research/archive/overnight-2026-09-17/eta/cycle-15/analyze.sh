#!/bin/bash
set -euo pipefail
O=/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/cycle-15
cd /home/gwarren/projects/yale-shuttle-watcher/overnight-eta-2026-09-17/services/shuttle-v2
python3 "$O/compare_resume.py" > "$O/compare-resume.log" 2>&1
python3 "$O/score.py" > "$O/score.log" 2>&1
node_modules/.bin/tsx "$O/decisions.mts" > "$O/decisions.log" 2>&1
