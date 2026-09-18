#!/bin/bash
set -euo pipefail
cd /home/gwarren/projects/yale-shuttle-watcher/overnight-ux-2026-09-17/services/shuttle-v2
export OUT=${OUT:-/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/ux-06/final}
mkdir -p "$OUT"
npm test -- web/src/berthMap.test.ts web/src/berthDisclosure.test.ts web/src/berths.test.ts web/src/mapLabels.test.ts web/src/arrivalDetails.test.ts
npm run typecheck
(cd web && npx vite build)
node scripts/fullscreen-map-check.mjs
DESKTOP=1 OUT="$OUT/desktop" node scripts/fullscreen-map-check.mjs
node /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/ux-06/shell-fullscreen.mjs
