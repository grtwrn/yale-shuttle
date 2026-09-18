#!/usr/bin/env bash
set -uo pipefail
cd /home/gwarren/projects/yale-shuttle-watcher/overnight-ux-2026-09-17/services/shuttle-v2
review_root=/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/review-ux09-map
OUT="$review_root/pinch-current" node "$review_root/interrupt-pinch.mjs" > "$review_root/pinch-current.log" 2>&1
current_result=$?
DIST_ROOT=/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/ux-09/baseline-dist OUT="$review_root/pinch-baseline" node "$review_root/interrupt-pinch.mjs" > "$review_root/pinch-baseline.log" 2>&1
baseline_result=$?
python3 - "$current_result" "$baseline_result" <<'PY'
import sys,json
print(json.dumps({'current_exit':int(sys.argv[1]),'baseline_exit':int(sys.argv[2])}))
PY
AUTO_END=1 OUT="$review_root/pinch-auto-current" node "$review_root/interrupt-pinch.mjs" > "$review_root/pinch-auto-current.log" 2>&1
current_result=$?
AUTO_END=1 DIST_ROOT=/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/ux-09/baseline-dist OUT="$review_root/pinch-auto-baseline" node "$review_root/interrupt-pinch.mjs" > "$review_root/pinch-auto-baseline.log" 2>&1
baseline_result=$?
python3 - "$current_result" "$baseline_result" <<'PY'
import sys,json
print(json.dumps({'auto_current_exit':int(sys.argv[1]),'auto_baseline_exit':int(sys.argv[2])}))
PY
