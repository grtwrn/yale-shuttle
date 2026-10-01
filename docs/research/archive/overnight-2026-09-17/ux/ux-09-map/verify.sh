#!/usr/bin/env bash
set -euo pipefail
cd /home/gwarren/projects/yale-shuttle-watcher/overnight-ux-2026-09-17/services/shuttle-v2
result_root=${OUT:-/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/ux-09-map/verified}
npm test -- web/src/mapFilter.test.ts web/src/rideMapFocus.test.ts web/src/rideEnd.test.ts web/src/rideArrival.test.ts web/src/rideAlert.test.ts web/src/mapLabels.test.ts web/src/etaSource.test.ts
npm run typecheck
(cd web && npx vite build)
OUT="$result_root/mobile" node scripts/map-lifecycle-check.mjs
DESKTOP=1 OUT="$result_root/desktop" node scripts/map-lifecycle-check.mjs
OUT="$result_root/original-repro" node /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/ux-09/map-stress.mjs
OUT="$result_root/feed" node scripts/empty-service-check.mjs
OUT="$result_root/fullscreen" node scripts/fullscreen-map-check.mjs
