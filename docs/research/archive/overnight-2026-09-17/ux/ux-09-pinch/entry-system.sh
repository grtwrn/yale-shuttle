#!/usr/bin/env bash
set -euo pipefail
cd /home/gwarren/projects/yale-shuttle-watcher/overnight-ux-2026-09-17/services/shuttle-v2
root=/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/ux-09-pinch
set +e
DIST_ROOT="$root/entry-dist" CASES=system-filter,system-nav OUT="$root/entry-system-second" node scripts/map-touch-teardown-check.mjs > "$root/entry-system-second.log" 2>&1
status=$?
set -e
printf 'Entry system comparison exit: %s\n' "$status"
python3 - "$root" "$status" <<'PY'
import json,sys
from pathlib import Path
root=Path(sys.argv[1]); r=json.loads((root/'entry-system-second/map-touch-teardown.json').read_text())
assert r['completed'] and r['resourcesClosed']
assert int(sys.argv[2])==1 and len(r['errors'])>=1
(root/'entry-system-outcome.json').write_text(json.dumps({'exit':int(sys.argv[2]),'cases':r['cases'],'expected_failure':True},indent=2))
PY
