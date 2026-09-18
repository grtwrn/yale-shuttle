#!/bin/bash
set -euo pipefail
cd /home/gwarren/projects/yale-shuttle-watcher/overnight-ux-2026-09-17/services/shuttle-v2
npm test -- src/server/serverEta.test.ts src/server/serverEta.closure.test.ts web/src/etaSource.test.ts web/src/liveUpdates.test.ts
OUT=/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/review-ux06-trip node /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/review-ux06-trip/review-transitions.mjs
