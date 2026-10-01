#!/usr/bin/env bash
set -euo pipefail
cd /home/gwarren/projects/yale-shuttle-watcher/overnight-ux-2026-09-17/services/shuttle-v2
npm test -- web/src/etaSource.test.ts
OUT=/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/review-ux09/extra-second node /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/review-ux09/lifecycle.mjs
OUT=/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/review-ux09/offline node /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/ux-09/offline-shell.mjs
