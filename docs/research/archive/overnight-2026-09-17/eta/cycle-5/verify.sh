#!/bin/bash
set -euo pipefail
cd /home/gwarren/projects/yale-shuttle-watcher/overnight-eta-2026-09-17/services/shuttle-v2
npm test -- web/src/eta/releaseSmoothing.test.ts web/src/eta/arrival.test.ts web/src/eta/lap.test.ts src/server/serverEta.test.ts src/server/serverEta.parity.test.ts src/server/serverEta.closure.test.ts
npm run typecheck
cd web
npx vite build
