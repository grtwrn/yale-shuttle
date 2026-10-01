#!/usr/bin/env bash
set -euo pipefail
cd /home/gwarren/projects/yale-shuttle-watcher/overnight-ux-2026-09-17/services/shuttle-v2
result_root=${OUT:-/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/ux-09-map/browser-second}
OUT="$result_root/mobile" node scripts/map-lifecycle-check.mjs
DESKTOP=1 OUT="$result_root/desktop" node scripts/map-lifecycle-check.mjs
OUT="$result_root/original-repro" node /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/ux-09/map-stress.mjs
OUT="$result_root/feed" node scripts/empty-service-check.mjs
OUT="$result_root/fullscreen" node scripts/fullscreen-map-check.mjs
