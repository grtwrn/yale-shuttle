#!/usr/bin/env bash
set -euo pipefail
cd /home/gwarren/projects/yale-shuttle-watcher/overnight-ux-2026-09-17/services/shuttle-v2
npm test -- web/src/recents.test.ts web/src/tripDraft.test.ts web/src/endpoints.test.ts web/src/format.test.ts web/src/anonId.test.ts
npm run typecheck
(cd web && npx vite build)
