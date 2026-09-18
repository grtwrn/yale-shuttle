#!/usr/bin/env bash
set -euo pipefail
cd /home/gwarren/projects/yale-shuttle-watcher/overnight-ux-2026-09-17/services/shuttle-v2
npm test -- web/src/recents.test.ts web/src/tripDraft.test.ts web/src/format.test.ts web/src/endpoints.test.ts
npm run typecheck
(cd web && npx vite build)
OUT=/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/ux-02 node scripts/navigation-search-check.mjs
