#!/bin/bash
set -euo pipefail
cd /home/gwarren/projects/yale-shuttle-watcher/overnight-ux-2026-09-17/services/shuttle-v2
npm test -- web/src/livePickupSelection.test.ts web/src/tripBusIdentity.test.ts web/src/planner.test.ts web/src/accuracy-closing-bus.test.ts web/src/journeyArrival.test.ts web/src/atStopJourney.test.ts web/src/arriveBy.test.ts src/server/serverEta.closure.test.ts
npm run typecheck
(cd web && npx vite build)
export OUT=${OUT:-/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/ux-pickup/verified}
BASELINE=/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/cycle-10/browser-contract.json node scripts/pickup-selection-check.mjs
VIEWPORT=desktop OUT="$OUT/desktop" BASELINE=/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/cycle-10/browser-contract.json node scripts/pickup-selection-check.mjs
OUT="$OUT/identity" node scripts/trip-identity-check.mjs
DESKTOP=1 OUT="$OUT/identity-desktop" node scripts/trip-identity-check.mjs
