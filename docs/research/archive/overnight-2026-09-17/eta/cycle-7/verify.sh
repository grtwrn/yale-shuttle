set -eu
cd /home/gwarren/projects/yale-shuttle-watcher/overnight-eta-2026-09-17/services/shuttle-v2
npm test -- web/src/atStopJourney.test.ts web/src/journeyArrival.test.ts web/src/arriveBy.test.ts web/src/arriveByMessage.test.ts web/src/planner.test.ts web/src/etaSource.test.ts
npm run typecheck
(cd web && npx vite build)
./node_modules/.bin/tsx /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/cycle-7/verify-decisions.mts
node /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/cycle-7/browser_ordered.mjs
node /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/cycle-7/browser_ordered_transitions.mjs
