#!/bin/bash
set -euo pipefail
export OUT=${OUT:-/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/ux-07-fix/verified}
bash /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/ux-07/verify.sh
cd /home/gwarren/projects/yale-shuttle-watcher/overnight-ux-2026-09-17/services/shuttle-v2
OUT="$OUT/reviewer-acceptance" node /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/review-ux07/boundary-acceptance.mjs
