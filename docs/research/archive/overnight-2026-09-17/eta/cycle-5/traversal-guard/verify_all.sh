#!/bin/bash
set -euo pipefail
cd /home/gwarren/projects/yale-shuttle-watcher/overnight-eta-2026-09-17/services/shuttle-v2
npm test
npm run typecheck
(cd web && npx vite build)
./node_modules/.bin/tsx /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/cycle-5/traversal-guard/capture_candidate.mts
./node_modules/.bin/tsx /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/cycle-5/traversal-guard/decision_replay.mts
node /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/cycle-5/traversal-guard/browser_parity.mjs
./node_modules/.bin/tsx /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/cycle-5/traversal-guard/full_pair.mts /home/gwarren/projects/yale-shuttle-watcher/release-integration-data/raw-complete-frames.jsonl
