#!/usr/bin/env bash
set -euo pipefail
cd /home/gwarren/projects/yale-shuttle-watcher/overnight-eta-2026-09-17/services/shuttle-v2
O=/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/review-round-10
python3 "$O/prepare.py"
./node_modules/.bin/tsx "$O/audit.mts"
./node_modules/.bin/tsx "$O/boundaries.mts"
./node_modules/.bin/tsx "$O/multi-option.mts"
