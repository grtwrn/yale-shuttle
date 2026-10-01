#!/bin/bash
set -euo pipefail
cd /home/gwarren/projects/yale-shuttle-watcher/overnight-ux-2026-09-17/services/shuttle-v2
npm test -- web/src/ArriveBy.render.test.tsx web/src/arriveByMessage.test.ts web/src/arriveBy.test.ts web/src/journeyArrival.test.ts web/src/liveUpdates.test.ts web/src/tripDraft.test.ts src/server/serverEta.closure.test.ts web/src/tripRanking.test.ts web/src/planner.test.ts src/server/serverEta.test.ts
npm run typecheck
(cd web && npx vite build)
node /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/review-round-2/browser-check.mjs
node /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/review-round-2/supporting-route-check.mjs
node /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/review-round-2/reviewer-acceptance.mjs
node /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/review-round-2/shell-check.mjs
node /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/review-round-2/hidden-route-shell.mjs
