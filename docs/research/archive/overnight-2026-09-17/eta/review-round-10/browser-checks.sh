#!/usr/bin/env bash
set -euo pipefail
ETA_CYCLE_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
cd /home/gwarren/projects/yale-shuttle-watcher/overnight-eta-2026-09-17/services/shuttle-v2
node "$ETA_CYCLE_DIR/browser-projection.mjs"
VIEWPORT=desktop node "$ETA_CYCLE_DIR/browser-projection.mjs"
