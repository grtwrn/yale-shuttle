#!/usr/bin/env bash
set -eu
cd /home/gwarren/projects/yale-shuttle-watcher/overnight-eta-2026-09-17/services/shuttle-v2
OUT=/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/review-round-9
python3 "$OUT/prepare.py" > "$OUT/prepare.log" 2>&1
./node_modules/.bin/tsx "$OUT/audit.mts" > "$OUT/audit.log" 2>&1
./node_modules/.bin/tsx "$OUT/boundaries.mts" > "$OUT/boundaries.log" 2>&1
python3 "$OUT/verify_build.py" > "$OUT/build-provenance.log" 2>&1
