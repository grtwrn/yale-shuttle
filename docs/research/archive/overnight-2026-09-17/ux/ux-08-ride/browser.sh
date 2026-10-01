#!/bin/bash
set -euo pipefail
cd /home/gwarren/projects/yale-shuttle-watcher/overnight-ux-2026-09-17/services/shuttle-v2
export OUT=${OUT:-/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/ux-08-ride/browser}
node scripts/ride-recovery-check.mjs
DESKTOP=1 OUT="$OUT/desktop" node scripts/ride-recovery-check.mjs
