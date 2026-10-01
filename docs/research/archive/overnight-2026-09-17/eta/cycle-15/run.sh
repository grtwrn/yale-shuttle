#!/bin/bash
set -euo pipefail
cd /home/gwarren/projects/yale-shuttle-watcher/overnight-eta-2026-09-17/services/shuttle-v2
O=/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/cycle-15
node "$O/build.mjs"
for arm in current canonical; do
  node --max-old-space-size=512 "$O/$arm.mjs" "$arm" > "$O/$arm.log" 2>&1
done
for arm in current canonical; do
  node --max-old-space-size=512 "$O/$arm.mjs" "$arm" 5900 6000 > "$O/$arm-resume5900.log" 2>&1
done
