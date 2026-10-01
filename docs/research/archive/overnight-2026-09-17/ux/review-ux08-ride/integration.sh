#!/bin/bash
set -euo pipefail
cd /home/gwarren/projects/yale-shuttle-watcher/overnight-ux-2026-09-17/services/shuttle-v2
npm test -- web/src/livePickupSelection.test.ts web/src/planner.test.ts web/src/journeyArrival.test.ts web/src/atStopJourney.test.ts web/src/arriveBy.test.ts web/src/accuracy-closing-bus.test.ts src/server/serverEta.test.ts src/server/serverEta.parity.test.ts src/server/serverEta.closure.test.ts
OUT=/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/review-ux08-ride/pickup node scripts/pickup-selection-check.mjs
OUT=/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/review-ux08-ride/extra node /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/review-ux08-ride/lifecycle.mjs
DESKTOP=1 OUT=/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/review-ux08-ride/extra-desktop node /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/review-ux08-ride/lifecycle.mjs
