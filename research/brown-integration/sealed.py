"""Hosted synthetic queries through the two actual immutable sealed models."""
import hashlib
import importlib.util
import json
import sys
from pathlib import Path

ROOT = Path('research/brown-integration')
OUT = ROOT / 'results/sealed'
RUNTIME = ROOT / 'input/rolling/source/research/brown-model-seal/runtime.py'
RUNTIME_SHA = '9e5ca3bb06140305a005c14f3ccfd634e866f6808c1b356f4b0bf7d640697785'
SPECS = {
    'frozen': (Path('research/brown-response/input/sealed'),
               'd8648c2a87c00a113268e5da49ef6a8fa46c62081f740ac9bf8152fb7f648c76',
               1790057940242, 1789531200000, 1790136000000, 1790742600000),
    'rolling': (ROOT / 'input/rolling',
                '97ff8586a3760e4a3696689510008f9a972b94b989cf793b52bcd4ad457fd54f',
                1790059735660, 1790049600000, 1790136000000, 1790222400000),
}
BINDINGS = ('artifactId', 'pathsSha256', 'sourceSha256', 'parametersSha256',
            'protocolSha256', 'topologySha256', 'rawPrefixSha256', 'knownAtPrefixSha256')


def sha(data):
    return hashlib.sha256(data).hexdigest()


def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, separators=(',', ':'), sort_keys=True, allow_nan=False) + '\n')


assert sha(RUNTIME.read_bytes()) == RUNTIME_SHA
spec = importlib.util.spec_from_file_location('actual_sealed_runtime', RUNTIME)
runtime = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runtime)
models, index = {}, {}
for name, (directory, artifact_id, built, cutoff, start, end) in SPECS.items():
    model, manifest = runtime.load(directory, artifact_id)
    assert manifest['kind'] == 'sealed'
    assert [manifest[k] for k in ('builtAt', 'trainBefore', 'validFrom', 'validUntil')] == [built, cutoff, start, end]
    assert not runtime.available(manifest, built - 1)
    assert not runtime.available(manifest, built)  # Both real exports precede validity.
    assert not runtime.available(manifest, start - 1)
    assert runtime.available(manifest, start)
    assert runtime.available(manifest, end - 1)
    assert not runtime.available(manifest, end)
    models[artifact_id] = model
    index[name] = dict(directory=str(directory), manifest=manifest,
                       manifestSha256=sha((directory / 'manifest.json').read_bytes()),
                       runtimeSha256=RUNTIME_SHA)

if sys.argv[1:] == ['prepare']:
    write(OUT / 'models.json', index)
    write(OUT / 'load-summary.json', dict(
        actualSealedArtifacts=True, syntheticInputsOnly=True, prospectiveBodiesRead=0,
        outcomesRead=0, trainingChanged=False, runtimeSha256=RUNTIME_SHA,
        models={name: dict(artifactId=x['manifest']['artifactId'],
                          manifestSha256=x['manifestSha256'],
                          builtAt=x['manifest']['builtAt'], validFrom=x['manifest']['validFrom'],
                          validUntil=x['manifest']['validUntil'],
                          sealedFilesVerified=len(x['manifest']['sealedFiles'])) for name, x in index.items()}))
elif sys.argv[1:] == ['query']:
    assert json.loads((OUT / 'models.json').read_text()) == index
    inventory = []
    for request_path in sorted((OUT / 'requests').glob('*.json')):
        request_bytes = request_path.read_bytes()
        request = json.loads(request_bytes)
        manifest = request['manifest']
        entry = next(x for x in index.values() if x['manifest']['artifactId'] == manifest['artifactId'])
        assert request['schema'] == 1 and manifest == entry['manifest']
        assert request['binding'] == {key: manifest[key] for key in BINDINGS}
        wanted = {tuple(q) for x in request['inputs'] for row in x['rows'] for q in row['queries']}
        assert wanted == {tuple(q) for q in request['queries']}
        assert len(wanted) == len(request['queries'])
        rows = []
        for query in request['queries']:
            assert query[0] == 19 and query[1] == manifest['K']
            # Clocks are fabricated September 23 inputs. No captured rows or
            # realized September 23 outcomes enter the immutable model pools.
            assert manifest['validFrom'] - 2700000 <= query[4] < 1790222400000
            rows.append(dict(query=query, fit=models[manifest['artifactId']].fit(*query)))
        response = dict(schema=1, requestSha256=sha(request_bytes), binding=request['binding'],
                        rows=rows, runtimeSha256=RUNTIME_SHA)
        result_path = OUT / 'responses' / request_path.name
        write(result_path, response)
        inventory.append(dict(request=str(request_path), result=str(result_path),
                              requestSha256=sha(request_bytes), resultSha256=sha(result_path.read_bytes()),
                              runtimeSha256=RUNTIME_SHA, queries=len(rows),
                              unsupported=sum(row['fit'] is None for row in rows)))
    assert len(inventory) == 2 and all(row['queries'] > 0 for row in inventory)
    write(OUT / 'query-inventory.json', inventory)
else:
    raise SystemExit('Expected prepare or query')
