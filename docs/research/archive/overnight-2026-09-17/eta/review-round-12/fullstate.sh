#!/bin/bash
set -euo pipefail
O=/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/review-round-12
node "$O/build-fullstate.mjs"
node "$O/fullstate.mjs" prewarmed
node "$O/fullstate.mjs" empty
python3 - <<'PY'
from pathlib import Path
import json,gzip
p=Path('/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/review-round-12')
a=json.loads(gzip.decompress((p/'fullstate-prewarmed.json.gz').read_bytes()))
b=json.loads(gzip.decompress((p/'fullstate-empty.json.gz').read_bytes()))
assert a==b and len(a)==78
fields=sorted({k for f in a for _,e in f['entries'] for k in e})
assert set(['belief','floors','releasePin','releaseSmoothing'])<=set(fields)
r=dict(completeModelEntryMatches=78,seenAtMatches=78,wireMatches=78,observedEntryFields=fields)
(p/'fullstate-verification.json').write_text(json.dumps(r,indent=2)+'\n')
print(json.dumps(r))
PY
