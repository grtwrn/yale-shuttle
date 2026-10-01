#!/bin/bash
set -euo pipefail
cd /home/gwarren/projects/yale-shuttle-watcher/overnight-ux-2026-09-17/services/shuttle-v2
npm test
OUT=/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/review-ux07-fix node /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/review-ux07-fix/review-lifecycle.mjs
