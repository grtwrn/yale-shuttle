#!/bin/bash
set -euo pipefail
cd /home/gwarren/projects/yale-shuttle-watcher/overnight-eta-2026-09-17/services/shuttle-v2
npm test
npm run typecheck
(cd web && npx vite build)
node /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/review-round-5/browser_parity.mjs
