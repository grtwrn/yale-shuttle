#!/usr/bin/env bash
set -euo pipefail
cd /home/gwarren/projects/yale-shuttle-watcher/overnight-ux-2026-09-17/services/shuttle-v2
result_root=${OUT:-/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/ux-09/release}
OUT="$result_root/mobile" node scripts/crash-recovery-check.mjs
DESKTOP=1 OUT="$result_root/desktop" node scripts/crash-recovery-check.mjs
