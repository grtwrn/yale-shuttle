set -eu
cd /home/gwarren/projects/yale-shuttle-watcher/overnight-eta-2026-09-17/services/shuttle-v2
npm test -- web/src/eta/releaseSmoothing.test.ts web/src/journeyArrival.test.ts web/src/etaSource.test.ts src/server/serverEta.test.ts src/server/serverEta.closure.test.ts src/server/serverEta.parity.test.ts web/src/arrivals.test.ts web/src/planner.test.ts
npm run typecheck
(cd web && npx vite build)
./node_modules/.bin/tsx /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/review-round-6/counterfactual.mts
node /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/review-round-6/browser_missing.mjs
node /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/review-round-6/build_ordered.mjs
node /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/review-round-6/browser_ordered_transitions.mjs
