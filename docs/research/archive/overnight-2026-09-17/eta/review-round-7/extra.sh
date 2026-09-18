set -eu
cd /home/gwarren/projects/yale-shuttle-watcher/overnight-eta-2026-09-17/services/shuttle-v2
npm test -- src/server/serverEta.closure.test.ts
node /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/review-round-7/walk-risk-boundary.mjs
