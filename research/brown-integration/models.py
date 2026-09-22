"""Hosted development fixture pools; never a prospective K5 model export."""
import gzip
import hashlib
import importlib.util
import json
import sys
import time
from pathlib import Path

ROOT=Path('research/brown-integration')
DEV=Path('research/brown-response/input/development')
SEALED=Path('research/brown-response/input/sealed')
OUT=ROOT/'results/models'
OUT.mkdir(parents=True,exist_ok=True)
def read(path):
    with gzip.open(path,'rt') as f:return [json.loads(s) for s in f if s.strip()]
def sha(data):return hashlib.sha256(data).hexdigest()
def file_sha(path):return sha(Path(path).read_bytes())
def write(path,value):path.write_text(json.dumps(value,separators=(',',':'),sort_keys=True,allow_nan=False)+'\n')
def module(name,path):
    spec=importlib.util.spec_from_file_location(name,path);m=importlib.util.module_from_spec(spec);sys.modules[name]=m;spec.loader.exec_module(m);return m
runtime_path=SEALED/'source/research/brown-model-seal/runtime.py'
assert file_sha(runtime_path)=='cabb4b0ccf997a4068c6555a1e68319122071570e4cccdbedce93886303e7c79'
runtime=module('original_sealed_fit',runtime_path)
frozen,real=runtime.load(SEALED,'d8648c2a87c00a113268e5da49ef6a8fa46c62081f740ac9bf8152fb7f648c76')
source=(SEALED/'source/research/k-sweep/evaluate.py').read_text()
models={}
def prefix_sha(rows):
    digest=hashlib.sha256()
    for row in rows:digest.update((json.dumps(row,separators=(',',':'),sort_keys=True)+'\n').encode())
    return digest.hexdigest()
def save(name,model,k,cutoff,parent=None,raw_prefix=None,known_prefix=None):
    directory=OUT/name;directory.mkdir(exist_ok=True)
    cells=[dict(key=list(cell),paths=paths) for cell,paths in model.paths.items() if cell[:2]==(19,k)]
    write(directory/'paths.json',dict(schema=1,cells=cells))
    paths_sha=file_sha(directory/'paths.json')
    params=json.loads((SEALED/'parameters.json').read_text());params.update(K=k,trainBefore=cutoff)
    write(directory/'parameters.json',params)
    write(directory/'sources.json',dict(originalBundle=real['sourceSha256'],originalEvaluate=sha(source.encode()),
        fixtureBuilder=file_sha(__file__),runtime=file_sha(runtime_path)))
    manifest=dict(schema=1,kind='fixture',artifactId=f'development-fixture/{name}/{paths_sha}',training='frozen' if k==8 else 'rolling',K=k,
        trainBefore=cutoff,builtAt=cutoff,validFrom=cutoff,validUntil=1789963200000,
        protocolSha256=real['protocolSha256'],topologySha256=real['topologySha256'],pathsSha256=paths_sha,
        rawPrefixSha256=raw_prefix or real['rawPrefixSha256'],
        knownAtPrefixSha256=known_prefix or real['knownAtPrefixSha256'],sourceSha256=file_sha(directory/'sources.json'),
        parametersSha256=file_sha(directory/'parameters.json'),parity=dict(physical=True,source=True,path=True,fit=True),
        fixtureAvailabilityOnly=True,actualFixtureBuiltAt=int(time.time()*1000),parentSealedArtifact=parent)
    # The fixture's synthetic availability clock is NEVER an actual sealed build.
    write(directory/'manifest.json',manifest)
    (directory/'original-evaluate.py').write_text(source)
    models[name]=dict(directory=str(directory),manifest=manifest,sourceFileSha256=file_sha(directory/'original-evaluate.py'))
save('frozen_K8',frozen,8,real['trainBefore'],dict(artifactId=real['artifactId'],builtAt=real['builtAt']))
c=module('integration_canonical',Path('research/canonical-windows/study.py'))
top=json.loads((DEV/'canonical-topology.json').read_text());c.ev.ROUTES={r['id']:r for r in top['routes']}
c.ev.WAITS={int(k):v for k,v in json.loads((DEV/'preparation.json').read_text())['waits'].items()}
visits=read(ROOT/'input/canonical/canonical-windows/results/training-visits.jsonl.gz')
visits=[v for v in visits if v['route_id']==19]
names={v['bus_name'] for v in visits}
raw=[r for r in read('research/brown-response/input/raw/raw_positions.jsonl.gz') if r['bus_name'] in names]
comparisons=read(DEV/'fit-comparisons.jsonl.gz')
checks=[]
for cutoff in (1789531200000,1789617600000):
    model,_=c.fit(visits,raw,cutoff)
    count=0
    for row in comparisons:
        if row['cutoff']==cutoff and row['query'][1]==5:
            assert model.fit(*row['query'])==row['baseline']==row['candidate'];count+=1
    assert count
    save(f'rolling_K5_{cutoff}',model,5,cutoff,raw_prefix=prefix_sha(r for r in raw if r['collected_at']<cutoff),
         known_prefix=prefix_sha(v for v in visits if c.rr.available(v,cutoff)))
    checks.append(dict(cutoff=cutoff,exactSavedQueries=count))
write(OUT/'index.json',models)
write(ROOT/'results/model-fixtures.json',dict(fixtureOnly=True,prospectiveArtifactCreated=False,checks=checks,
    realK8Artifact=real['artifactId'],realK8BuiltAt=real['builtAt'],outcomesRead=0,prospectiveBodiesRead=0))
