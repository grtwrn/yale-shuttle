"""Seal first daily K5 pool after raw/reducer/physical/path/fit gates, hosted only."""
import bisect
import collections
import datetime as dt
import gzip
import importlib.util
import json
import os
from pathlib import Path
import shutil
import sys

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(HERE.parent / 'brown-model-seal'))
from runtime import CELLS, PROTOCOL_SHA, TOPOLOGY_SHA, VALID_FROM, canonical, file_sha, from_pools, load, sha

CUTOFF = 1790049600000
END = VALID_FROM + 86400000
CELLS = [(r, 5, w, t) for r, _, w, t in CELLS]
CANONICAL = HERE / 'input/canonical/canonical-windows/results'
REPLAY = HERE / 'replay-results'
RAW = HERE / 'input/merged-raw.jsonl.gz'
OUT = HERE / 'results'
FROZEN_ID = 'd8648c2a87c00a113268e5da49ef6a8fa46c62081f740ac9bf8152fb7f648c76'
SOURCE_FILES = (
    'research/k-sweep/prepare.py', 'research/k-sweep/evaluate.py',
    'research/useful-windows/rolling.py', 'research/canonical-windows/study.py',
    'research/brown-model-seal/runtime.py', 'research/brown-rolling-seal/build.py',
    'research/brown-rolling-seal/prepare.py', 'research/brown-rolling-seal/replay.ts',
    'research/brown-directed/guard.ts', 'services/shuttle-v2/src/collector/detector.ts',
    'services/shuttle-v2/src/collector/departure.ts', 'services/shuttle-v2/src/collector/visitRows.ts',
)


def read(path):
    with gzip.open(path, 'rt') as f:
        return [json.loads(line) for line in f if line.strip()]


def write(name, value):
    (OUT / name).write_bytes(canonical(value)+b'\n')


def write_prefix(name, rows):
    import hashlib
    h = hashlib.sha256()
    with (OUT / name).open('wb') as raw:
        with gzip.GzipFile(filename='', mode='wb', fileobj=raw, mtime=0) as f:
            for row in rows:
                line = canonical(row)+b'\n'
                f.write(line)
                h.update(line)
    return h.hexdigest()


def pools(model):
    return dict(schema=1, cells=[dict(key=cell, paths=model.paths.get(cell, [])) for cell in CELLS])


def physical(v):
    return {k:v[k] for k in ('bus_name','bus_id','route_id','stop_index','stop_id','arrived_at','departed_at','known_at')}


def evidence(model, visits):
    by_id = {v['id']:v for v in visits}
    grouped = collections.defaultdict(list)
    for v in visits:
        grouped[v['bus_name'],v['route_id']].append(v)
    indexes = {}
    for key, rows in grouped.items():
        rows.sort(key=lambda v:(v['anchored_at'],v['id']))
        indexes[key] = {v['id']:i for i,v in enumerate(rows)}
    identities, full = [], []
    for cell in CELLS:
        for p in model.paths.get(cell, []):
            s,t = by_id[p['sourceId']],by_id[p['targetId']]
            key = s['bus_name'],s['route_id']
            a,b = indexes[key][s['id']],indexes[key][t['id']]
            assert a < b
            middle = grouped[key][a+1:b]
            assert all(v['arrived_at'] <= v['departed_at'] <= v['known_at'] < CUTOFF for v in [s,*middle,t])
            row = {k:v for k,v in p.items() if k not in ('sourceId','targetId')}
            row.update(cell=cell, source=physical(s), target=physical(t))
            identities.append(row)
            full.append(dict(row,sourceId=p['sourceId'],targetId=p['targetId'],
                             intermediates=[dict(id=v['id'],physical=physical(v)) for v in middle]))
    return sorted(map(canonical,identities)),full


def audit_provider_rows(model, visits, raw, quality):
    """Prove original path-span continuity; closing IDs are not arrival IDs."""
    by_id={v['id']:v for v in visits}
    mismatches=[]
    for cell in CELLS:
        for p in model.paths.get(cell,[]):
            s,t=by_id[p['sourceId']],by_id[p['targetId']]
            assert quality.ok(p['bus'],19,p['start'],p['end']), 'Original provider/route/gap/speed gate failed'
            if s['bus_id'] != t['bus_id']:
                mismatches.append(dict(cell=cell,path=p,source=s,target=t))
    mismatches.sort(key=lambda r:(r['path']['start'],r['path']['end'],r['cell']))
    names={r['path']['bus'] for r in mismatches}
    tracks={name:sorted((r for r in raw if r['bus_name']==name),key=lambda r:r['collected_at']) for name in names}
    times={name:[r['collected_at'] for r in rows] for name,rows in tracks.items()}
    examples=[]
    unresolved=[]
    for row in mismatches:
        name=row['path']['bus'];rows,ts=tracks[name],times[name]
        clocks=dict(sourceDeparture=row['source']['departed_at'],targetArrival=row['target']['arrived_at'],
                    targetDeparture=row['target']['departed_at'],targetKnownAt=row['target']['known_at'])
        windows={key:rows[bisect.bisect_left(ts,at-90000):bisect.bisect_right(ts,at+90000)] for key,at in clocks.items()}
        lo=max(0,bisect.bisect_right(ts,clocks['sourceDeparture'])-1)
        hi=min(len(rows)-1,bisect.bisect_left(ts,clocks['targetArrival']))
        quality_span=rows[lo:hi+1]
        known_hi=min(len(rows)-1,bisect.bisect_left(ts,clocks['targetKnownAt']))
        transitions=[dict(previous=a,current=b) for a,b in zip(rows[lo:known_hi+1],rows[lo+1:known_hi+1]) if a['bus_id']!=b['bus_id']]
        providers={r['bus_id'] for r in quality_span}
        resolved=(len(providers)==1 and row['source']['bus_id'] in providers
                  and row['target']['anchor_bus_id'] in providers
                  and rows[known_hi]['bus_id']==row['target']['bus_id']
                  and bool(transitions)
                  and all(change['previous']['collected_at']>=clocks['targetArrival'] for change in transitions))
        if not resolved:unresolved.append(dict(cell=row['cell'],source=row['source']['id'],target=row['target']['id']))
        examples.append(dict(row,rawWindows=windows,postArrivalProviderTransitions=transitions,
            pathSpanProviderContinuous=resolved,originalQualityBracket=dict(
            first=quality_span[0],last=quality_span[-1],rows=len(quality_span),
            providerIds=sorted(providers),routes=sorted({r['route_id'] for r in quality_span}))))
    result=dict(pathMismatches=len(mismatches),uniquePairs=len({(r['source']['id'],r['target']['id']) for r in mismatches}),
                allPairs=[dict(cell=r['cell'],source=r['source']['id'],target=r['target']['id'],
                               sourceProvider=r['source']['bus_id'],targetProvider=r['target']['bus_id']) for r in mismatches],
                examples=examples[:25],exampleRule='first25chronological mismatched paths; every mismatch checked; no performance labels',
                unresolved=unresolved,originalPathQualityUnchanged=True,
                identityContract='raw provider continuity from source departure through target arrival; target closing ID may change afterward',
                modelSealed=False)
    write('provider-identity-audit.json',result)
    print(json.dumps(dict(providerPathMismatches=len(mismatches),uniquePairs=result['uniquePairs'])))
    assert not unresolved, 'HALT: unresolved path provider evidence; no model sealed'


def main():
    assert os.environ.get('GITHUB_ACTIONS') == 'true' and os.environ.get('BLUE_MAX_PATH_SECONDS') == '5400'
    assert not OUT.exists()
    OUT.mkdir()
    raw_audit = json.loads((HERE/'input/raw-audit.json').read_text())
    assert file_sha(RAW) == raw_audit['mergedSha256']
    gate = json.loads((REPLAY/'parity-summary.json').read_text())
    assert gate['baselineCanonicalIdentity'] and gate['nonBrownEventIdentity']
    assert gate['Brown']['discrepancyKeys'] == 0 and gate['strictPhysicalSourceParity']
    assert len(gate['prefixChecks']) == 6 and gate['rawSha256'] == file_sha(RAW)
    protocol = ROOT/'research/brown-directed/PROSPECTIVE-FOUR-ARM.json'
    assert file_sha(protocol) == PROTOCOL_SHA
    assert file_sha(CANONICAL/'canonical-topology.json') == TOPOLOGY_SHA
    assert file_sha(CANONICAL/'preparation.json') == '2edd09127b7d41357ef6ecb6bf461f75c4f0b59c33d37ad2dd11cff24269df0d'
    spec = importlib.util.spec_from_file_location('rolling_seal_canonical',ROOT/'research/canonical-windows/study.py')
    c = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(c)
    c.OUT=CANONICAL
    c.configure()
    assert c.ev.MODEL_CAP == 5400 and c.ev.WAITS[19] == [0,5]
    raw = read(RAW)
    old, new = read(REPLAY/'baseline-visits.jsonl.gz'),read(REPLAY/'candidate-visits.jsonl.gz')
    original,audit = c.fit(old,raw,CUTOFF)
    guarded,guard_audit = c.fit(new,raw,CUTOFF)
    admitted = [v for v in old if c.rr.available(v,CUTOFF)]
    guard_admitted = [v for v in new if c.rr.available(v,CUTOFF)]
    raw_prefix = [r for r in raw if r['collected_at'] < CUTOFF]
    audit_provider_rows(original,admitted,raw_prefix,c.rr.TrainingQuality(raw_prefix))
    a,full_evidence = evidence(original,admitted)
    b,_ = evidence(guarded,guard_admitted)
    assert a == b, 'HALT: original and guarded physical path identities differ'
    prefix,prefix_audit = c.fit(admitted,raw_prefix,CUTOFF)
    assert canonical(pools(original)) == canonical(pools(prefix)) and audit == prefix_audit
    source = (ROOT/'research/k-sweep/evaluate.py').read_text()
    reloaded,function_hashes = from_pools(source,json.loads(canonical(pools(original))),cutoff=CUTOFF,K=5)
    # Query clocks are input-only; no forecast rows or performance labels are loaded.
    clocks = {v['departed_at'] for v in admitted if v['route_id'] == 19}
    clocks.update(range(VALID_FROM, VALID_FROM+7*86400000+1, 3600000))
    queries = [(*cell,clock) for cell in CELLS for clock in sorted(clocks)]
    supported = 0
    for q in queries:
        x = original.fit(*q)
        assert x == guarded.fit(*q) == prefix.fit(*q) == reloaded.fit(*q)
        supported += x is not None
    frozen,frozen_manifest = load(HERE/'input/frozen',FROZEN_ID)
    frozen_checks = 0
    for row in read(HERE/'input/frozen/parity/fit-comparisons.jsonl.gz'):
        if row['cutoff'] == frozen_manifest['trainBefore'] and row['query'][1] == 8:
            assert frozen.fit(*row['query']) == row['baseline'] == row['candidate']
            frozen_checks += 1
    assert frozen_checks == 167
    write('paths.json',pools(original))
    write('path-evidence.json',full_evidence)
    raw_hash = write_prefix('raw-prefix.jsonl.gz',raw_prefix)
    known_hash = write_prefix('known-at-prefix.jsonl.gz',admitted)
    for src,dest in ((CANONICAL/'canonical-topology.json','canonical-topology.json'),
                     (CANONICAL/'preparation.json','preparation.json'),(protocol,'protocol.json'),
                     (REPLAY/'parity-summary.json','physical-source-parity.json'),
                     (HERE/'input/raw-audit.json','raw-audit.json'),
                     (HERE/'data/raw-provenance.json','raw-provenance.json')):
        shutil.copyfile(src,OUT/dest)
    sources={}
    for name in SOURCE_FILES:
        dest=OUT/'source'/name
        dest.parent.mkdir(parents=True,exist_ok=True)
        shutil.copyfile(ROOT/name,dest)
        sources[name]=file_sha(dest)
    write('sources.json',sources)
    parameters=dict(route=19,K=5,waits=[0,5],trainBefore=CUTOFF,pathCapSec=5400,
                    circularClockSigmaMinutes=120,weekdayWeekendSplit=True,minimumEffective=12,
                    minimumMaterialDays=3,materialWeightFraction=.05,quantiles=[.1,.9],
                    maxRawGapSec=60,maxRawSpeedMS=22,providerContinuity=True,
                    strictActualKnownAt=True,liveSourceAgeSec=2700,liveObservationAgeSec=15)
    write('parameters.json',parameters)
    write('training-audit.json',dict(original=audit,guarded=guard_audit))
    write('verification.json',dict(passed=True,physicalPaths=len(a),cells=len(CELLS),fitQueries=len(queries),
          supportedQueries=supported,unsupportedQueries=len(queries)-supported,
          rawPrefixRows=len(raw_prefix),knownAtPrefixRows=len(admitted),
          physicalAndSourceParity=True,nonBrownIdentity=True,exactPhysicalPathsBothVariants=True,
          exactOriginalGuardedReloadedFits=True,deletedFuturePoolFitExact=True,
          priorFrozenArtifactQueries=frozen_checks,prospectiveObservationsRead=0,performanceLabelsRead=0))
    files={str(p.relative_to(OUT)):file_sha(p) for p in sorted(OUT.rglob('*')) if p.is_file()}
    manifest=dict(schema=1,kind='sealed',training='rolling',K=5,trainBefore=CUTOFF,
        builtAt=int(dt.datetime.now(dt.timezone.utc).timestamp()*1000),validFrom=VALID_FROM,validUntil=END,
        protocolSha256=PROTOCOL_SHA,topologySha256=TOPOLOGY_SHA,pathsSha256=files['paths.json'],
        rawPrefixSha256=raw_hash,knownAtPrefixSha256=known_hash,sourceSha256=files['sources.json'],
        parametersSha256=files['parameters.json'],fitFunctionSha256=function_hashes,
        parity=dict(physical=True,source=True,path=True,fit=True),
        parityEvidence=dict(run=os.environ['GITHUB_RUN_ID'],replayRun=os.environ.get('REPLAY_EVIDENCE_RUN'),physical=files['physical-source-parity.json']),
        inputHashes=dict(raw=file_sha(RAW),originalVisits=file_sha(REPLAY/'baseline-visits.jsonl.gz'),
                         guardedVisits=file_sha(REPLAY/'candidate-visits.jsonl.gz')),
        creatingCommit=os.environ['GITHUB_SHA'],creatingRun=os.environ['GITHUB_RUN_ID'],
        sealedFiles=files,scope='Sep23 rolling Brown K5 pools only; no candidate launch or outcome claim')
    manifest['artifactId']=sha(canonical(manifest))
    write('manifest.json',manifest)
    final,loaded=load(OUT,manifest['artifactId'])
    assert loaded==manifest
    for q in queries:
        assert final.fit(*q)==original.fit(*q)
    print(json.dumps(dict(passed=True,artifactId=manifest['artifactId'],builtAt=manifest['builtAt'],
                         paths=len(a),queries=len(queries),frozenQueries=frozen_checks)))


if __name__ == '__main__':
    main()
