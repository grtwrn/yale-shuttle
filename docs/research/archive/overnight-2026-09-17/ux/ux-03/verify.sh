#!/usr/bin/env bash
set -euo pipefail
cd /home/gwarren/projects/yale-shuttle-watcher/overnight-ux-2026-09-17/services/shuttle-v2
npm test -- web/src/myReports.test.ts web/src/screenshot.test.ts
npm run typecheck
(cd web && npx vite build)
OUT=/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/ux-03 node scripts/feedback-accessibility-check.mjs
DESKTOP=1 OUT=/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/ux-03/desktop node scripts/feedback-accessibility-check.mjs
