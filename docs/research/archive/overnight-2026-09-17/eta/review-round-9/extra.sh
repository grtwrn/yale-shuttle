#!/usr/bin/env bash
set -eu
cd /home/gwarren/projects/yale-shuttle-watcher/overnight-eta-2026-09-17/services/shuttle-v2
OUT=/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/review-round-9
./node_modules/.bin/vitest run web/src/planner.test.ts web/src/journeyArrival.test.ts web/src/tripBusIdentity.test.ts web/src/etaSource.test.ts > "$OUT/targeted-tests.log" 2>&1
node "$OUT/browser-extra.mjs" > "$OUT/browser-extra-mobile.log" 2>&1
REVIEW_DESKTOP=1 node "$OUT/browser-extra.mjs" > "$OUT/browser-extra-desktop.log" 2>&1
