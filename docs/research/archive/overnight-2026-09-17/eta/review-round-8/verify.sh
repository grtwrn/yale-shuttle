set -eu
cd /home/gwarren/projects/yale-shuttle-watcher/overnight-eta-2026-09-17/services/shuttle-v2
npm test -- web/src/atStopJourney.test.ts web/src/journeyArrival.test.ts web/src/arriveBy.test.ts web/src/arriveByMessage.test.ts web/src/planner.test.ts web/src/etaSource.test.ts web/src/eta/releaseSmoothing.test.ts src/server/serverEta.test.ts src/server/serverEta.release.test.ts src/server/serverEta.parity.test.ts src/server/serverEta.closure.test.ts web/src/tripBusIdentity.test.ts web/src/accuracy-closing-bus.test.ts web/src/RideFinish.test.tsx web/src/standWait.test.ts
npm run typecheck
(cd web && npx vite build)
./node_modules/.bin/tsx /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/review-round-8/verify-decisions.mts
node /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/review-round-8/browser_ordered.mjs
node /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/review-round-8/browser_ordered_transitions.mjs
node /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/review-round-8/browser_deadline.mjs
node /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/review-round-8/browser_walk_gate.mjs
node /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/review-round-8/walk-risk-boundary.mjs
node /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/review-round-8/browser-risk-matrix.mjs
OUT=/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/review-round-8/ux-mobile node scripts/trip-identity-check.mjs
DESKTOP=1 OUT=/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/review-round-8/ux-desktop node scripts/trip-identity-check.mjs
