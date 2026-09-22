"""Hosted reload of the root-owned seal, queried only at development origins."""
import gzip
import hashlib
import importlib.util
import json
from pathlib import Path

ROOT = Path('research/brown-response')
SEALED = ROOT / 'input/sealed'
EXPECTED_ID = 'd8648c2a87c00a113268e5da49ef6a8fa46c62081f740ac9bf8152fb7f648c76'
runtime_path = SEALED / 'source/research/brown-model-seal/runtime.py'
assert hashlib.sha256(runtime_path.read_bytes()).hexdigest() == 'cabb4b0ccf997a4068c6555a1e68319122071570e4cccdbedce93886303e7c79'
spec = importlib.util.spec_from_file_location('sealed_original_runtime', runtime_path)
runtime = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runtime)
model, manifest = runtime.load(SEALED, EXPECTED_ID)
rows = []
with gzip.open(ROOT / 'input/development/fit-comparisons.jsonl.gz', 'rt') as stream:
    for line in stream:
        r = json.loads(line)
        if r['cutoff'] != manifest['trainBefore'] or r['query'][1] != 8:
            continue
        assert r['query'][4] < 1789963200000  # Sep 21 00:00 ET: no later inputs.
        result = model.fit(*r['query'])
        assert result == r['baseline'] == r['candidate']
        rows.append(dict(query=r['query'], fit=result))
assert rows
assert not runtime.available(manifest, manifest['builtAt'] - 1)
assert not runtime.available(manifest, manifest['validFrom'] - 1)
assert runtime.available(manifest, manifest['validFrom'])
assert not runtime.available(manifest, manifest['validUntil'])
out = ROOT / 'results'
out.mkdir(parents=True, exist_ok=True)
(out / 'sealed-development-fits.json').write_text(json.dumps(rows, separators=(',', ':')) + '\n')
(out / 'sealed-runtime.json').write_text(json.dumps(dict(artifactId=EXPECTED_ID, builtAt=manifest['builtAt'],
    exactDevelopmentQueries=len(rows), fixtureHistoricalAvailabilityClaimed=False,
    prospectiveInputsRead=0, outcomesRead=0, loadedOriginalRuntime=True), indent=2) + '\n')
