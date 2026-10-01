#!/bin/bash
set -euo pipefail
cd /home/gwarren/projects/yale-shuttle-watcher/overnight-eta-2026-09-17/services/shuttle-v2
./node_modules/.bin/tsx /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/cycle-5/decision_replay.mts
node /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/cycle-5/browser_parity.mjs
npm test
