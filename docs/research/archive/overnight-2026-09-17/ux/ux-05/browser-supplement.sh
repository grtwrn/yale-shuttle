#!/bin/bash
set -euo pipefail
cd /home/gwarren/projects/yale-shuttle-watcher/overnight-ux-2026-09-17/services/shuttle-v2
OUT=/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/ux-05/supplemental node scripts/minimap-label-check.mjs
DESKTOP=1 OUT=/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/ux-05/supplemental-desktop node scripts/minimap-label-check.mjs
BASELINE_SOURCE=/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/ux-05/TransitMap.baseline.tsx OUT=/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/ux-05/baseline-expanded node scripts/minimap-label-check.mjs --baseline
