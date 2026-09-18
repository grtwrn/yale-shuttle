#!/bin/bash
set -euo pipefail
cd /home/gwarren/projects/yale-shuttle-watcher/overnight-eta-2026-09-17/services/shuttle-v2
O=$(dirname "$(realpath "$0")")
node "$O/build.mjs"
for arm in current canonical; do
 node "$O/$arm.mjs" "$arm" > "$O/$arm.log" 2>&1
done
