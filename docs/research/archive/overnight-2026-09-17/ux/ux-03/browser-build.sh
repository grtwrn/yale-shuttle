#!/usr/bin/env bash
set -euo pipefail
cd /home/gwarren/projects/yale-shuttle-watcher/overnight-ux-2026-09-17/services/shuttle-v2
(cd web && npx vite build)
OUT=/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/ux-03 node scripts/feedback-accessibility-check.mjs
