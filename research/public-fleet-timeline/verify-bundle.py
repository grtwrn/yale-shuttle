"""Compare a hosted production web-stage build with immutable capture hashes."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys

expected = json.loads(Path(__file__).with_name('deployed-bundle.json').read_text())
root = Path(sys.argv[1])
output = Path(sys.argv[2])
subprocess.run(['git', 'diff', '--exit-code', expected['productionSource'], '--', 'services/shuttle-v2'], check=True)
tree = subprocess.check_output(['git', 'rev-parse', expected['productionSource'] + ':services/shuttle-v2/web'], text=True).strip()
assert tree == expected['webTree'], (tree, expected['webTree'])
results = []
for item in expected['files']:
    file = root / item['path']
    body = file.read_bytes() if file.exists() else None
    actual = None if body is None else dict(bytes=len(body), sha256=hashlib.sha256(body).hexdigest())
    results.append(dict(path=item['path'], expected=item, actual=actual,
                        matches=actual is not None and actual['bytes'] == item['bytes'] and actual['sha256'] == item['sha256']))
result = dict(productionSource=expected['productionSource'], webTree=tree,
              captureStartedAt=expected['captureStartedAt'], files=results,
              matches=all(row['matches'] for row in results),
              scope='Exact captured rider HTML/JavaScript bytes; no candidate forecast or outcome validation.')
output.mkdir(parents=True, exist_ok=True)
(output / 'bundle-verification.json').write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps(result, indent=2))
if not result['matches']:
    raise SystemExit(1)
