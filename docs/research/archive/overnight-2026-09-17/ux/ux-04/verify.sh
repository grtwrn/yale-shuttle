#!/usr/bin/env bash
set -euo pipefail
cd /home/gwarren/projects/yale-shuttle-watcher/overnight-ux-2026-09-17/services/shuttle-v2
result_root=${OUT:-/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/ux-04}
npm test -- web/src/historyRecency.test.ts web/src/ArrivalPlot.test.ts web/src/arrivalDetails.test.ts src/server/journeyHistory.test.ts
npm run typecheck
(cd web && npx vite build)
OUT="$result_root" node scripts/arrival-history-check.mjs
DESKTOP=1 OUT="$result_root/desktop" node scripts/arrival-history-check.mjs
