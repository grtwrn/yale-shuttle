#!/bin/bash
set -euo pipefail
cd /home/gwarren/projects/yale-shuttle-watcher/overnight-ux-2026-09-17/services/shuttle-v2
npm test -- web/src/stopAlerts.test.ts web/src/stopAlerts.replay.test.ts web/src/leaveAlert.test.ts web/src/liveUpdates.test.ts web/src/mapFilter.test.ts
npm run typecheck
(cd web && npx vite build)
export OUT=${OUT:-/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/ux-08/verified}
node scripts/stop-alert-controls-check.mjs
DESKTOP=1 OUT="$OUT/desktop" node scripts/stop-alert-controls-check.mjs
