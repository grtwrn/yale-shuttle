#!/usr/bin/env bash
set -euo pipefail
cd /home/gwarren/projects/yale-shuttle-watcher/overnight-ux-2026-09-17/services/shuttle-v2
weather_out=${OUT:-/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/ux-10-weather/final}
OUT="$weather_out/mobile" node scripts/weather-controls-check.mjs
DESKTOP=1 OUT="$weather_out/desktop" node scripts/weather-controls-check.mjs
OUT="$weather_out/navigation" node scripts/navigation-search-check.mjs
