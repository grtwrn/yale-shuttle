#!/usr/bin/env bash
set -euo pipefail
cd /home/gwarren/projects/yale-shuttle-watcher/overnight-ux-2026-09-17/services/shuttle-v2
review_root=/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/review-ux09-pinch
npm test -- web/src/tripDraft.test.ts web/src/pullToRefresh.test.ts web/src/anonId.test.ts web/src/recents.test.ts web/src/liveUpdates.test.ts src/server/serverEta.test.ts src/server/serverEta.parity.test.ts src/server/serverEta.closure.test.ts web/src/arriveBy.test.ts
OUT="$review_root/recovery-mobile" node scripts/crash-recovery-check.mjs
DESKTOP=1 OUT="$review_root/recovery-desktop" node scripts/crash-recovery-check.mjs
OUT="$review_root/recovery-real-trip" node /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/review-ux09/lifecycle.mjs
OUT="$review_root/offline" node /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/ux-09/offline-shell.mjs
