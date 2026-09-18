#!/bin/bash
set -euo pipefail
cd /home/gwarren/projects/yale-shuttle-watcher/overnight-ux-2026-09-17/services/shuttle-v2
npm test -- web/src/tripBusIdentity.test.ts web/src/journeyArrival.test.ts web/src/planner.test.ts web/src/accuracy-closing-bus.test.ts web/src/RideFinish.test.tsx web/src/standWait.test.ts
npm run typecheck
(cd web && npx vite build)

export OUT=${OUT:-/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/ux-06-trip/final}
node scripts/trip-identity-check.mjs
DESKTOP=1 OUT="$OUT/desktop" node scripts/trip-identity-check.mjs
