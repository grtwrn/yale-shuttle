#!/usr/bin/env bash
set -euo pipefail
cd /home/gwarren/projects/yale-shuttle-watcher/overnight-ux-2026-09-17/services/shuttle-v2
npm test -- web/src/arriveBy.test.ts web/src/arriveByMessage.test.ts web/src/journeyArrival.test.ts web/src/liveUpdates.test.ts web/src/tripDraft.test.ts src/server/serverEta.closure.test.ts
npm run typecheck
(cd web && npx vite build)
node /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/review-round-1/browser-check.mjs
node /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/review-round-1/shell-check.mjs
