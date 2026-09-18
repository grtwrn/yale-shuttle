#!/bin/bash
set -euo pipefail
cd /home/gwarren/projects/yale-shuttle-watcher/overnight-ux-2026-09-17/services/shuttle-v2
export OUT=${OUT:-/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/ux-pickup/final}
export BASELINE=/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/cycle-10/browser-contract.json
node scripts/pickup-selection-check.mjs
VIEWPORT=desktop OUT="$OUT/desktop" node scripts/pickup-selection-check.mjs
