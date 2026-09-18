#!/bin/bash
set -euo pipefail
cd /home/gwarren/projects/yale-shuttle-watcher/overnight-ux-2026-09-17/services/shuttle-v2
OUT=/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/ux-06/supplemental node scripts/fullscreen-map-check.mjs
DESKTOP=1 OUT=/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/ux-06/supplemental-desktop node scripts/fullscreen-map-check.mjs
