#!/usr/bin/env bash
set -euo pipefail
cd /home/gwarren/projects/yale-shuttle-watcher/overnight-ux-2026-09-17/services/shuttle-v2
result_root=${OUT:-/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/ux-09/verified}
npm test -- web/src/tripDraft.test.ts web/src/pullToRefresh.test.ts web/src/anonId.test.ts web/src/recents.test.ts web/src/liveUpdates.test.ts
npm run typecheck
(cd web && npx vite build)
OUT="$result_root/mobile" node scripts/crash-recovery-check.mjs
DESKTOP=1 OUT="$result_root/desktop" node scripts/crash-recovery-check.mjs
OUT="$result_root/feed" node scripts/empty-service-check.mjs
