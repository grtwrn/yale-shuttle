#!/bin/bash
set -euo pipefail
cd /home/gwarren/projects/yale-shuttle-watcher/overnight-ux-2026-09-17/services/shuttle-v2
export OUT=${OUT:-/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/ux-05}
npm test -- web/src/mapLabels.test.ts web/src/chipCluster.test.ts web/src/routes.test.ts web/src/mapFilter.test.ts
npm run typecheck
(cd web && npx vite build)
node scripts/minimap-label-check.mjs
DESKTOP=1 OUT="$OUT/desktop" node scripts/minimap-label-check.mjs
node /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/ux-05/shell-map.mjs
