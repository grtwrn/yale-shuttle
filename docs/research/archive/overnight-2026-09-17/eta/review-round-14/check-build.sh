#!/bin/bash
set -euo pipefail
cd /home/gwarren/projects/yale-shuttle-watcher/overnight-eta-2026-09-17/services/shuttle-v2
O=/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/review-round-14
# Preserve the frozen bundles used in independently executed continuations.
cp "$O/current.mjs" "$O/current-frozen.mjs"
cp "$O/canonical.mjs" "$O/canonical-frozen.mjs"
node "$O/build.mjs" > "$O/build.log" 2>&1
python3 "$O/audit_join_changes.py" > "$O/join-audit.log" 2>&1
