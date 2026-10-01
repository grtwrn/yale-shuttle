#!/bin/bash
set -euo pipefail
O=/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/review-round-12/cache
node "$O/build.mjs"
for arm in current canonical; do
  node "$O/$arm.mjs" "$arm" kernel-low
  node "$O/$arm.mjs" "$arm" kernel-high
  node "$O/$arm.mjs" "$arm" warm
  node "$O/$arm.mjs" "$arm" cold
done
