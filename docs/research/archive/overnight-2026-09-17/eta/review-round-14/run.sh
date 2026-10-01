#!/bin/bash
set -euo pipefail
cd /home/gwarren/projects/yale-shuttle-watcher/overnight-eta-2026-09-17/services/shuttle-v2
O=/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/review-round-14
node --max-old-space-size=512 "$O/current.mjs" current 5900 6000 >"$O/current-resume.log" 2>&1
node --max-old-space-size=512 "$O/canonical.mjs" canonical 5900 6000 >"$O/canonical-resume.log" 2>&1
python3 "$O/compare_resume.py" >"$O/compare-resume.log" 2>&1
python3 "$O/score.py" >"$O/score.log" 2>&1
python3 "$O/verify_score.py" >"$O/verify-score.log" 2>&1
./node_modules/.bin/tsx "$O/decisions.mts" >"$O/decisions.log" 2>&1
python3 "$O/verify_decisions.py" >"$O/verify-decisions.log" 2>&1
python3 "$O/rider_outcomes.py" >"$O/rider-outcomes.log" 2>&1
python3 "$O/verify_semantics.py" >"$O/verify-semantics.log" 2>&1
