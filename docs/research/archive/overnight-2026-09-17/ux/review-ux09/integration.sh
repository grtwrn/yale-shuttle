#!/usr/bin/env bash
set -euo pipefail
cd /home/gwarren/projects/yale-shuttle-watcher/overnight-ux-2026-09-17/services/shuttle-v2
npm test -- src/server/serverEta.test.ts src/server/serverEta.parity.test.ts src/server/serverEta.closure.test.ts web/src/liveArrivals.test.ts web/src/arriveBy.test.ts
OUT=/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/review-ux09/extra node /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/review-ux09/lifecycle.mjs
OUT=/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/review-ux09/offline node /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/ux-09/offline-shell.mjs
