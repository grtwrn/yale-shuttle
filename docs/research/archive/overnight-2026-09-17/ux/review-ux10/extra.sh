#!/usr/bin/env bash
set -euo pipefail
cd /home/gwarren/projects/yale-shuttle-watcher/overnight-ux-2026-09-17/services/shuttle-v2
review_out=/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/review-ux10
OUT="$review_out/extra-mobile" node "$review_out/extra-transitions.mjs"
DESKTOP=1 OUT="$review_out/extra-desktop" node "$review_out/extra-transitions.mjs"
