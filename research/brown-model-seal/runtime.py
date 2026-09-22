"""Load sealed pools and execute exact original fit AST; no path construction."""
import ast
import collections
import datetime as dt
import hashlib
import json
import math
from pathlib import Path
from zoneinfo import ZoneInfo

TOPOLOGY_SHA = 'eb753d58c4ace616e844b3a54842978c4ec46833373560e1b236d7b5d61b40bc'
PROTOCOL_SHA = '4d1e09bd3cb41762a11e19a7de49bcfb8d8c479b44b3354a845df1b6c8f82742'
FROZEN = 1789531200000
VALID_FROM = 1790136000000
VALID_UNTIL = 1790742600000
CELLS = [(19, 8, w, t) for w, targets in ((0, (1, 2, 3, 4, 5)), (5, (6, 7, 8, 0))) for t in targets]


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()


def sha(data):
    return hashlib.sha256(data).hexdigest()


def file_sha(path):
    digest = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def exact_fit_class(source):
    """Compile unmodified function ASTs with the original globals only."""
    tree = ast.parse(source)
    helpers = [n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name in ('clock', 'weekend', 'q')]
    models = [n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == 'Models']
    assert len(models) == 1 and {n.name for n in helpers} == {'clock', 'weekend', 'q'} and len(helpers) == 3
    fits = [n for n in models[0].body if isinstance(n, ast.FunctionDef) and n.name == 'fit']
    assert len(fits) == 1
    cls = ast.ClassDef(name='SealedFit', bases=[], keywords=[], body=fits, decorator_list=[])
    module = ast.fix_missing_locations(ast.Module(body=[*helpers, cls], type_ignores=[]))
    namespace = dict(collections=collections, dt=dt, math=math, TZ=ZoneInfo('America/New_York'))
    exec(compile(module, '<pinned original K fit>', 'exec'), namespace)
    hashes = {n.name: sha(ast.get_source_segment(source, n).encode()) for n in [*helpers, *fits]}
    return namespace['SealedFit'], hashes


def from_pools(source, pools):
    cls, hashes = exact_fit_class(source)
    model = cls()
    model.cache = {}
    model.paths = {}
    assert pools['schema'] == 1 and len(pools['cells']) == len(CELLS)
    for cell in pools['cells']:
        key = tuple(cell['key'])
        assert key in CELLS and key not in model.paths
        for path in cell['paths']:
            assert all(isinstance(path[f], (int, float)) and not isinstance(path[f], bool) and math.isfinite(path[f])
                       for f in ('start', 'end', 'duration'))
            assert path['start'] < path['end'] < FROZEN and 0 < path['duration'] <= 5400
            assert path['duration'] == (path['end'] - path['start']) / 1000
            assert isinstance(path['weekend'], bool) and isinstance(path['day'], str)
            assert path['day'] == dt.datetime.fromtimestamp(path['start']/1000, ZoneInfo('America/New_York')).strftime('%Y-%m-%d')
            assert path['weekend'] == (dt.datetime.fromtimestamp(path['start']/1000, ZoneInfo('America/New_York')).weekday() >= 5)
            assert all(path.get(f) is not None for f in ('sourceId', 'targetId', 'bus'))
        model.paths[key] = cell['paths']
    assert set(model.paths) == set(CELLS)
    return model, hashes


def load(directory, expected_artifact_id):
    directory = Path(directory)
    manifest = json.loads((directory / 'manifest.json').read_text())
    identity = dict(manifest)
    artifact_id = identity.pop('artifactId')
    assert artifact_id == expected_artifact_id == sha(canonical(identity))
    assert manifest['schema'] == 1 and manifest['kind'] == 'sealed' and manifest['training'] == 'frozen' and manifest['K'] == 8
    assert manifest['trainBefore'] == FROZEN
    assert manifest['validFrom'] == VALID_FROM and manifest['validUntil'] == VALID_UNTIL
    assert isinstance(manifest['builtAt'], int) and not isinstance(manifest['builtAt'], bool)
    assert manifest['builtAt'] >= FROZEN and manifest['builtAt'] < VALID_UNTIL
    assert manifest['protocolSha256'] == PROTOCOL_SHA and manifest['topologySha256'] == TOPOLOGY_SHA
    assert manifest['parity'] == dict(physical=True, source=True, path=True, fit=True)
    for name, expected in manifest['sealedFiles'].items():
        relative = Path(name)
        assert not relative.is_absolute() and '..' not in relative.parts
        assert file_sha(directory / relative) == expected
    assert manifest['pathsSha256'] == manifest['sealedFiles']['paths.json']
    assert manifest['parametersSha256'] == manifest['sealedFiles']['parameters.json']
    assert manifest['sourceSha256'] == manifest['sealedFiles']['sources.json']
    sources = json.loads((directory / 'sources.json').read_text())
    for name, expected in sources.items():
        assert manifest['sealedFiles']['source/' + name] == expected
    pools = json.loads((directory / 'paths.json').read_text())
    model, hashes = from_pools((directory / 'source/research/k-sweep/evaluate.py').read_text(), pools)
    assert hashes == manifest['fitFunctionSha256']
    return model, manifest


def available(manifest, at):
    return (isinstance(at, (int, float)) and not isinstance(at, bool) and math.isfinite(at)
            and manifest['builtAt'] <= at and manifest['validFrom'] <= at < manifest['validUntil'])
