"""Evaluate bound requests with the original fit AST; missing query != null fit."""
import hashlib
import importlib.util
import json
from pathlib import Path

ROOT=Path('research/brown-integration/results')
def sha(data):return hashlib.sha256(data).hexdigest()
runtime_path=Path('research/brown-response/input/sealed/source/research/brown-model-seal/runtime.py')
runtime_hash=sha(runtime_path.read_bytes())
assert runtime_hash=='cabb4b0ccf997a4068c6555a1e68319122071570e4cccdbedce93886303e7c79'
spec=importlib.util.spec_from_file_location('exact_fit_runtime',runtime_path)
runtime=importlib.util.module_from_spec(spec);spec.loader.exec_module(runtime)
index=json.loads((ROOT/'models/index.json').read_text())
by_id={m['manifest']['artifactId']:m for m in index.values()}
bindings=('artifactId','pathsSha256','sourceSha256','parametersSha256','protocolSha256','topologySha256','rawPrefixSha256','knownAtPrefixSha256')
inventory=[]
for path in sorted((ROOT/'requests').glob('*.json')):
    request_bytes=path.read_bytes();request=json.loads(request_bytes)
    assert request['schema']==1
    model=by_id[request['binding']['artifactId']];directory=Path(model['directory']);manifest=model['manifest']
    assert request['manifest']==manifest and request['binding']=={k:manifest[k] for k in bindings}
    assert sha((directory/'paths.json').read_bytes())==manifest['pathsSha256']
    assert sha((directory/'parameters.json').read_bytes())==manifest['parametersSha256']
    assert sha((directory/'sources.json').read_bytes())==manifest['sourceSha256']
    sources=json.loads((directory/'sources.json').read_text())
    assert sources['fixtureBuilder']==sha(Path('research/brown-integration/models.py').read_bytes()) and sources['runtime']==runtime_hash
    assert sha((directory/'original-evaluate.py').read_bytes())==model['sourceFileSha256']
    assert model['sourceFileSha256']==sources['originalEvaluate']
    cls,_=runtime.exact_fit_class((directory/'original-evaluate.py').read_text());fit=cls();fit.cache={}
    pools=json.loads((directory/'paths.json').read_text());fit.paths={tuple(c['key']):c['paths'] for c in pools['cells']}
    queries=request['queries'];assert len({tuple(q) for q in queries})==len(queries)
    requested_by_rows={tuple(q) for row in request['inputs'] for group in row['rows'] for q in group['queries']}
    assert requested_by_rows=={tuple(q) for q in queries}
    rows=[]
    for q in queries:
        assert q[0]==19 and q[1]==manifest['K'] and q[4]<1789963200000
        rows.append(dict(query=q,fit=fit.fit(*q)))
    result=dict(schema=1,requestSha256=sha(request_bytes),binding=request['binding'],rows=rows,runtimeSha256=runtime_hash)
    target=ROOT/'responses'/path.name;target.parent.mkdir(exist_ok=True)
    target.write_text(json.dumps(result,separators=(',',':'),sort_keys=True,allow_nan=False)+'\n')
    inventory.append(dict(request=str(path),result=str(target),requestSha256=sha(request_bytes),resultSha256=sha(target.read_bytes()),
        runtimeSha256=runtime_hash,queries=len(rows),unsupported=sum(r['fit'] is None for r in rows)))
(ROOT/'query-inventory.json').write_text(json.dumps(inventory,indent=2)+'\n')
