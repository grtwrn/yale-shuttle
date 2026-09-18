#!/bin/bash
set -euo pipefail
cd /home/gwarren/projects/yale-shuttle-watcher/overnight-ux-2026-09-17/services/shuttle-v2
npm test -- web/src/ArriveBy.render.test.tsx web/src/arriveByMessage.test.ts web/src/arriveBy.test.ts web/src/journeyArrival.test.ts web/src/liveUpdates.test.ts web/src/tripDraft.test.ts src/server/serverEta.closure.test.ts
npm run typecheck
(cd web && npx vite build)
node /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/ux-01-fix/browser-check.mjs
node /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/ux-01-fix/supporting-route-check.mjs
node /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/ux-01-fix/reviewer-acceptance.mjs
node /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/ux-01-fix/shell-check.mjs
node /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/ux-01-fix/hidden-route-shell.mjs
