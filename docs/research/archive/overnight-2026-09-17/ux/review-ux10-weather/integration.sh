#!/usr/bin/env bash
set -euo pipefail
cd /home/gwarren/projects/yale-shuttle-watcher/overnight-ux-2026-09-17/services/shuttle-v2
review_out=/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/review-ux10-weather
OUT="$review_out/browser" bash /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/ux-10-weather/browser.sh
OUT="$review_out/extra" node "$review_out/extra.mjs"
OUT="$review_out/supplemental" node /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/ux-10-weather/supplemental.mjs
OUT="$review_out/feed" node scripts/empty-service-check.mjs
npm test -- src/server/serverEta.test.ts src/server/serverEta.parity.test.ts src/server/serverEta.closure.test.ts
