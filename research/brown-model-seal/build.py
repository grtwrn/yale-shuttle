"""Hosted-only build: no prospective responses or performance labels are read."""
import collections
import datetime as dt
import gzip
import importlib.util
import json
import os
from pathlib import Path
import shutil
import sys

from runtime import (CELLS, FROZEN, PROTOCOL_SHA, TOPOLOGY_SHA, VALID_FROM, VALID_UNTIL,
                     canonical, file_sha, from_pools, load, sha)

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
CANONICAL = HERE / 'input/canonical/canonical-windows/results'
DIRECTED = HERE / 'input/directed'
RAW = ROOT / 'research/k-sweep/results/raw_positions.jsonl.gz'
OUT = HERE / 'results'
EXPECTED = {
    'raw': '3990d06ebdab596cfebdd7f03c528f7efcbb46fd3f6af68a9d64ede648e220b9',
    'visits': 'a3aa7065e7e82e018f2d0671b5a3044df766d033b7098462e4f257115d880fd5',
    'preparation': '2edd09127b7d41357ef6ecb6bf461f75c4f0b59c33d37ad2dd11cff24269df0d',
}
SOURCE_FILES = (
    'research/k-sweep/prepare.py', 'research/k-sweep/evaluate.py',
    'research/useful-windows/rolling.py', 'research/canonical-windows/study.py',
    'research/brown-model-seal/runtime.py', 'research/brown-model-seal/build.py',
)


def read(path):
    with gzip.open(path, 'rt') as stream:
        return [json.loads(line) for line in stream if line.strip()]


def write(name, value):
    (OUT / name).write_bytes(canonical(value) + b'\n')


def write_prefix(name, rows):
    import hashlib
    digest = hashlib.sha256()
    with (OUT / name).open('wb') as raw:
        with gzip.GzipFile(filename='', mode='wb', fileobj=raw, mtime=0) as stream:
            for row in rows:
                line = canonical(row) + b'\n'
                stream.write(line)
                digest.update(line)
    return digest.hexdigest()


def pools(model):
    return dict(schema=1, cells=[dict(key=cell, paths=model.paths.get(cell, [])) for cell in CELLS])


def physical(v):
    return {k: v[k] for k in ('bus_name', 'bus_id', 'route_id', 'stop_index', 'stop_id',
                              'arrived_at', 'departed_at', 'known_at')}


def path_evidence(model, visits):
    by_id = {v['id']: v for v in visits}
    groups = collections.defaultdict(list)
    for v in visits:
        if v['arrived_at'] is not None:
            groups[v['bus_name'], v['route_id']].append(v)
    positions = {}
    for key, vs in groups.items():
        vs.sort(key=lambda v: (v['anchored_at'], v['id']))
        positions[key] = {v['id']: i for i, v in enumerate(vs)}
    rows, full = [], []
    for cell in CELLS:
        for p in model.paths.get(cell, []):
            source, target = by_id[p['sourceId']], by_id[p['targetId']]
            row = {k: v for k, v in p.items() if k not in ('sourceId', 'targetId')}
            row.update(cell=cell, source=physical(source), target=physical(target))
            rows.append(row)
            key = source['bus_name'], source['route_id']
            start, end = positions[key][source['id']], positions[key][target['id']]
            assert start < end
            intermediates = groups[key][start + 1:end]
            assert all(v['departed_at'] <= v['known_at'] < FROZEN for v in [source, *intermediates, target])
            assert source['bus_id'] == target['bus_id']
            full.append(dict(row, sourceId=p['sourceId'], targetId=p['targetId'],
                             intermediates=[dict(id=v['id'], physical=physical(v)) for v in intermediates]))
    return sorted(rows, key=canonical), full


def main():
    assert os.environ.get('GITHUB_ACTIONS') == 'true', 'Fitting must run on hosted CI, never the Pi'
    assert os.environ.get('BLUE_MAX_PATH_SECONDS') == '5400'
    assert not OUT.exists(), 'Never overwrite a sealed or partial build'
    OUT.mkdir(parents=True)
    protocol = ROOT / 'research/brown-directed/PROSPECTIVE-FOUR-ARM.json'
    assert file_sha(protocol) == PROTOCOL_SHA
    assert file_sha(RAW) == EXPECTED['raw']
    assert file_sha(CANONICAL / 'training-visits.jsonl.gz') == EXPECTED['visits']
    assert file_sha(CANONICAL / 'canonical-topology.json') == TOPOLOGY_SHA
    assert file_sha(CANONICAL / 'preparation.json') == EXPECTED['preparation']
    physical_gate = json.loads((DIRECTED / 'parity-summary.json').read_text())
    source_gate = json.loads((DIRECTED / 'feature-parity.json').read_text())
    fit_gate = json.loads((DIRECTED / 'model-parity.json').read_text())
    assert physical_gate['baselineCanonicalIdentity'] and physical_gate['Brown']['discrepancyKeys'] == 0
    assert source_gate['sourceDepartureKnownAtParity'] and source_gate['originalLeadAndNonBrownFeatureParity']
    assert fit_gate['pathFitDifferences'] == 0

    spec = importlib.util.spec_from_file_location('sealed_canonical', ROOT / 'research/canonical-windows/study.py')
    c = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(c)
    c.OUT = CANONICAL
    c.configure()
    assert c.FROZEN == FROZEN and c.ev.MODEL_CAP == 5400
    assert c.ev.WAITS[19] == [0, 5] and c.ev.ROUTES[19]['stops'] == [145,147,4,42,98,121,115,172,47]
    visits, raw = read(CANONICAL / 'training-visits.jsonl.gz'), read(RAW)
    model, audit = c.fit(visits, raw, FROZEN)
    admitted = [v for v in visits if c.rr.available(v, FROZEN)]
    raw_prefix = [r for r in raw if r['collected_at'] < FROZEN]
    expected_pools = pools(model)
    path_rows, evidence = path_evidence(model, admitted)
    for variant in ('baseline', 'candidate'):
        old = [r for r in read(DIRECTED / f'{variant}-paths-{FROZEN}.jsonl.gz') if r['cell'][1] == 8]
        assert list(map(canonical, path_rows)) == sorted(map(canonical, old)), variant + ' physical paths differ'
    prefix_model, prefix_audit = c.fit(admitted, raw_prefix, FROZEN)
    assert canonical(pools(prefix_model)) == canonical(expected_pools)
    assert prefix_audit == audit
    source = (ROOT / 'research/k-sweep/evaluate.py').read_text()
    reloaded, function_hashes = from_pools(source, json.loads(canonical(expected_pools)))
    queries = [r for r in read(DIRECTED / 'fit-comparisons.jsonl.gz') if r['cutoff'] == FROZEN and r['query'][1] == 8]
    assert queries
    for row in queries:
        query = row['query']
        assert model.fit(*query) == prefix_model.fit(*query) == reloaded.fit(*query) == row['baseline'] == row['candidate']

    write('paths.json', expected_pools)
    write('path-evidence.json', evidence)
    raw_hash = write_prefix('raw-prefix.jsonl.gz', raw_prefix)
    known_hash = write_prefix('known-at-prefix.jsonl.gz', admitted)
    shutil.copyfile(CANONICAL / 'canonical-topology.json', OUT / 'canonical-topology.json')
    shutil.copyfile(CANONICAL / 'preparation.json', OUT / 'preparation.json')
    shutil.copyfile(protocol, OUT / 'protocol.json')
    sources = {}
    for name in SOURCE_FILES:
        dest = OUT / 'source' / name
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(ROOT / name, dest)
        sources[name] = file_sha(dest)
    write('sources.json', sources)
    parameters = dict(route=19, K=8, waits=[0,5], trainBefore=FROZEN, pathCapSec=5400,
                      circularClockSigmaMinutes=120, weekdayWeekendSplit=True, minimumEffective=12,
                      minimumMaterialDays=3, materialWeightFraction=.05, quantiles=[.1,.9],
                      maxRawGapSec=60, maxRawSpeedMS=22, providerContinuity=True,
                      strictActualKnownAt=True, liveSourceAgeSec=2700, liveObservationAgeSec=15)
    write('parameters.json', parameters)
    gate_files = ('parity-summary.json', 'feature-parity.json', 'model-parity.json',
                  f'baseline-paths-{FROZEN}.jsonl.gz', f'candidate-paths-{FROZEN}.jsonl.gz', 'fit-comparisons.jsonl.gz')
    evidence_hashes = {}
    for name in gate_files:
        dest = OUT / 'parity' / name
        dest.parent.mkdir(exist_ok=True)
        shutil.copyfile(DIRECTED / name, dest)
        evidence_hashes[name] = file_sha(dest)
    write('verification.json', dict(passed=True, paths=len(path_rows), cells=len(CELLS),
          queries=len(queries), unsupportedQueries=sum(r['baseline'] is None for r in queries),
          rawPrefixRows=len(raw_prefix), knownAtPrefixRows=len(admitted),
          exactPhysicalPathsBothVariants=True, exactSavedFitsBothVariants=True,
          exactReloadedFit=True, deletedFuturePrefixExact=True,
          prospectiveObservationsRead=0, performanceLabelsRead=0, newParameters=0))
    sealed_files = {str(p.relative_to(OUT)): file_sha(p) for p in sorted(OUT.rglob('*')) if p.is_file()}
    manifest = dict(schema=1, training='frozen', K=8, trainBefore=FROZEN,
        builtAt=int(dt.datetime.now(dt.timezone.utc).timestamp()*1000), validFrom=VALID_FROM, validUntil=VALID_UNTIL,
        protocolSha256=PROTOCOL_SHA, topologySha256=TOPOLOGY_SHA, pathsSha256=sealed_files['paths.json'],
        rawPrefixSha256=raw_hash, knownAtPrefixSha256=known_hash,
        sourceSha256=sealed_files['sources.json'], parametersSha256=sealed_files['parameters.json'],
        fitFunctionSha256=function_hashes, parity=dict(physical=True,source=True,path=True,fit=True),
        parityEvidence=dict(run=35691411464, files=evidence_hashes),
        inputHashes=EXPECTED, creatingCommit=os.environ['GITHUB_SHA'], creatingRun=os.environ['GITHUB_RUN_ID'],
        sealedFiles=sealed_files, scope='Frozen Brown K8 pools only; no candidate launch or outcome claim')
    manifest['artifactId'] = sha(canonical(manifest))
    write('manifest.json', manifest)
    final, loaded = load(OUT, manifest['artifactId'])
    assert loaded == manifest
    for row in queries:
        assert final.fit(*row['query']) == row['baseline']
    print(json.dumps(dict(artifactId=manifest['artifactId'], builtAt=manifest['builtAt'],
                         paths=len(path_rows), queries=len(queries), passed=True)))


if __name__ == '__main__':
    main()
