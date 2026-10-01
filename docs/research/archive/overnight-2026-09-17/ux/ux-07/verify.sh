#!/bin/bash
set -euo pipefail
cd /home/gwarren/projects/yale-shuttle-watcher/overnight-ux-2026-09-17/services/shuttle-v2
npm test -- web/src/liveUpdates.test.ts web/src/mapFilter.test.ts web/src/etaSource.test.ts web/src/schedule.test.ts web/src/announcements.test.ts web/src/routeThumb.test.ts
npm run typecheck
(cd web && npx vite build)
export OUT=${OUT:-/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/ux-07/final}
node scripts/empty-service-check.mjs
DESKTOP=1 OUT="$OUT/desktop" node scripts/empty-service-check.mjs
