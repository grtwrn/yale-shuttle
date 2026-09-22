"""Authoring helper: hash source bytes only; never imports or executes a fitter."""
import hashlib
import json
from pathlib import Path

root=Path(__file__).resolve().parents[2]
paths=set()
for directory in ('research/brown-daily-seals','research/brown-rolling-seal','research/brown-model-seal','research/brown-directed',
                  'research/brown-clocks','research/canonical-windows','research/k-sweep','research/useful-windows','research/window-only',
                  'services/shuttle-v2/src/collector','services/shuttle-v2/src/network'):
    for p in (root/directory).glob('*'):
        if p.is_file() and p.suffix in ('.py','.ts','.mjs') and not p.name.startswith('__daily-'):paths.add(str(p.relative_to(root)))
for p in (root/'research/brown-daily-seals/units').glob('*'):paths.add(str(p.relative_to(root)))
paths.update(['research/brown-directed/PROSPECTIVE-FOUR-ARM.json','research/brown-rolling-seal/package.json',
    'services/shuttle-v2/package.json','services/shuttle-v2/package-lock.json','.github/workflows/brown-daily-seal.yml','.github/workflows/brown-daily-fixtures.yml'])
value=dict(schema=1,scope='Daily Brown research implementation only; new-day requests and timers remain inactive pending review',
    protocolSha256='4d1e09bd3cb41762a11e19a7de49bcfb8d8c479b44b3354a845df1b6c8f82742',
    files={name:hashlib.sha256((root/name).read_bytes()).hexdigest() for name in sorted(paths)})
(root/'research/brown-daily-seals/IMPLEMENTATION.json').write_text(json.dumps(value,indent=2)+'\n')
print(json.dumps({'pinnedFiles':len(paths)}))
