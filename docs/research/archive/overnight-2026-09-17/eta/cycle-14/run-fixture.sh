#!/bin/bash
set -euo pipefail
cd /home/gwarren/projects/yale-shuttle-watcher/overnight-eta-2026-09-17/services/shuttle-v2
O=$(dirname "$(realpath "$0")")
node "$O/build-fixture.mjs"
for arm in current canonical; do
 for mode in normal reverse restart10 restart20 restart30; do
  node "$O/$arm-fixture.mjs" "$arm" "$mode"
 done
done
