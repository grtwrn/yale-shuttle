#!/usr/bin/env bash
set -euo pipefail
cd /home/gwarren/projects/yale-shuttle-watcher/overnight-ux-2026-09-17/services/shuttle-v2
artifact=/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/ux-09
node "$artifact/build-baseline.mjs"
# These are diagnostic reproductions expected to fail, not passing release gates.
if OUT="$artifact/map-stress-current" node "$artifact/map-stress.mjs"; then
  echo 'Current diagnostic exit 0'
else
  echo "Current diagnostic exit $?"
fi
if DIST_ROOT="$artifact/baseline-dist" OUT="$artifact/map-stress-baseline" node "$artifact/map-stress.mjs"; then
  echo 'Baseline diagnostic exit 0'
else
  echo "Baseline diagnostic exit $?"
fi
