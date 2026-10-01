#!/usr/bin/env bash
set -euo pipefail
cd /home/gwarren/projects/yale-shuttle-watcher/overnight-ux-2026-09-17/services/shuttle-v2
npm test -- web/src/myReports.test.ts web/src/screenshot.test.ts web/src/etaSource.test.ts web/src/liveUpdates.test.ts src/server/serverEta.closure.test.ts
npm run typecheck
(cd web && npx vite build)
OUT=/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/review-round-4/mobile node scripts/feedback-accessibility-check.mjs
DESKTOP=1 OUT=/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/review-round-4/desktop node scripts/feedback-accessibility-check.mjs
