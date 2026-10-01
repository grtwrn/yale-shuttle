#!/bin/bash
set -euo pipefail
cd /home/gwarren/projects/yale-shuttle-watcher/overnight-eta-2026-09-17/services/shuttle-v2
REVIEW_OUT=/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/review-round-11
python3 "$REVIEW_OUT/prepare.py"
python3 "$REVIEW_OUT/prepare_tests.py"
./node_modules/.bin/vitest run --config "$REVIEW_OUT/vitest.config.mjs"
python3 "$REVIEW_OUT/prepare_current_pair.py"
./node_modules/.bin/tsx "$REVIEW_OUT/current_pair.mts"
python3 "$REVIEW_OUT/match_alternatives.py" > "$REVIEW_OUT/matcher.log"
python3 "$REVIEW_OUT/verify_outcomes.py"
python3 "$REVIEW_OUT/audit_chain_gaps.py" > "$REVIEW_OUT/chain-gaps.log"
