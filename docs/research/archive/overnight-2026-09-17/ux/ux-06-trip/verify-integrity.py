import hashlib
import json
import subprocess
from pathlib import Path

artifact = Path(__file__).resolve().parent
root = Path('/home/gwarren/projects/yale-shuttle-watcher/overnight-ux-2026-09-17')
evidence = json.loads((artifact / 'integrity.json').read_text())
assert subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root).decode().strip() == evidence['head']
for relative, expected in evidence['sources'].items():
    assert hashlib.sha256((root / relative).read_bytes()).hexdigest() == expected, relative
relative = 'services/shuttle-v2/web/src/TransitMap.tsx'
baseline = subprocess.check_output(['git', 'show', 'HEAD:' + relative], cwd=root).decode()
assert baseline == (artifact / 'baseline-TransitMap.tsx').read_text()
current = (root / relative).read_text()
start = '  const options: TripOption[] | null = useMemo'
end = '  // Origin and destination are the same place'
before = baseline[baseline.index(start):baseline.index(end)]
after = current[current.index(start):current.index(end)]
assert before == after
assert hashlib.sha256(before.encode()).hexdigest() == evidence['numerical_options_sha256']
for name in ['planner.ts', 'journeyArrival.ts', 'arrivals.ts', 'etaSource.ts']:
    relative = 'services/shuttle-v2/web/src/' + name
    assert subprocess.check_output(['git', 'show', 'HEAD:' + relative], cwd=root) == (root / relative).read_bytes()
subprocess.run(['git', 'diff', '--check'], cwd=root, check=True)
subprocess.run(['git', 'diff', '--cached', '--exit-code'], cwd=root, check=True)
print('PASS: exact HEAD, five source hashes, frozen baseline, unchanged numerical options/modules, whitespace and empty index')
