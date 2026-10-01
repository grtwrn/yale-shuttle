#!/usr/bin/env bash
set -euo pipefail
cd /home/gwarren/projects/yale-shuttle-watcher/overnight-ux-2026-09-17/services/shuttle-v2
review_out=/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/review-ux10
npm test -- web/src/mapFilter.test.ts web/src/rideMapFocus.test.ts web/src/rideEnd.test.ts web/src/rideArrival.test.ts web/src/rideAlert.test.ts web/src/mapLabels.test.ts web/src/etaSource.test.ts web/src/pullToRefresh.test.ts web/src/liveUpdates.test.ts src/server/serverEta.test.ts src/server/serverEta.parity.test.ts src/server/serverEta.closure.test.ts web/src/arriveBy.test.ts
OUT="$review_out/saved" bash /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/ux-10/browser.sh
OUT="$review_out/touch" node scripts/map-touch-teardown-check.mjs
OUT="$review_out/map" node scripts/map-lifecycle-check.mjs
OUT="$review_out/crash" node scripts/crash-recovery-check.mjs
OUT="$review_out/actual-trip" node /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/review-ux09/lifecycle.mjs
OUT="$review_out/offline" node /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/ux-09/offline-shell.mjs
