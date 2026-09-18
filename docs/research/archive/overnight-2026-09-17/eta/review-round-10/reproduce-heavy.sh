#!/usr/bin/env bash
set -euo pipefail
cd /home/gwarren/projects/yale-shuttle-watcher/overnight-eta-2026-09-17/services/shuttle-v2
O=/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/review-round-10
node "$O/verify-overlay.mjs"
bash "$O/browser-checks.sh"
