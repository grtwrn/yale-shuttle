#!/bin/bash
set -euo pipefail
cd /home/gwarren/projects/yale-shuttle-watcher/overnight-ux-2026-09-17/services/shuttle-v2
npm test -- web/src/rideAlert.test.ts web/src/rideEnd.test.ts web/src/RideFinish.test.tsx web/src/rideArrival.test.ts web/src/rideMapFocus.test.ts web/src/etaSource.test.ts web/src/liveUpdates.test.ts web/src/tripBusIdentity.test.ts
npm run typecheck
(cd web && npx vite build)
export OUT=${OUT:-/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/ux-08-ride/verified}
node scripts/ride-recovery-check.mjs
DESKTOP=1 OUT="$OUT/desktop" node scripts/ride-recovery-check.mjs
