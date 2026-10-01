#!/bin/bash
set -euo pipefail
cd /home/gwarren/projects/yale-shuttle-watcher/overnight-ux-2026-09-17/services/shuttle-v2
npm test -- src/server/serverEta.test.ts src/server/serverEta.closure.test.ts web/src/journeyArrival.test.ts web/src/arriveByMessage.test.ts
OUT=/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/review-ux07 node /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/review-ux07/review-lifecycle.mjs
