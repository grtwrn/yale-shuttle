"""Hosted streaming equality check; no fits, outcome changes or new scores."""
import collections
import gzip
import hashlib
import itertools
import json
from pathlib import Path

HERE=Path(__file__).resolve().parent;ROOT=HERE/'policy-comparison-input'
PINS={'highway25':(10700961955,'684acd8df92b481aa83e359db55a77910596db8652996334ed2d20a724046722'),
      'highway50':(10700372713,'8dc5c983b3e8e07bc05d510f94ca6c10417122fc49c40ef85bdccd032d355a15')}
def rows(path):
    with gzip.open(path,'rt') as f:
        for line in f:
            if line.strip():yield json.loads(line)
def sha(path):
    h=hashlib.sha256()
    with path.open('rb') as f:
        for chunk in iter(lambda:f.read(1048576),b''):h.update(chunk)
    return h.hexdigest()
def key(r):return tuple(r[k] for k in ('at','bus','route','target'))
def main():
    artifacts=json.loads((ROOT/'artifacts.json').read_text())['artifacts'];hashes={};counts={}
    for policy,(ident,digest) in PINS.items():
        record=next(a for a in artifacts if a['id']==ident)
        assert record['digest']=='sha256:'+digest and record['name']=='checkpoint-ensemble-complete-'+policy
    for name in ('unscored.jsonl.gz','enriched.jsonl.gz'):
        files=[ROOT/p/name for p in PINS]
        for p in files:hashes[str(p.relative_to(ROOT))]=sha(p)
        n=0;routes=collections.Counter();transfer=collections.Counter();added=collections.Counter()
        for a,b in itertools.zip_longest(*(rows(p) for p in files)):
            assert a is not None and b is not None and key(a)==key(b)
            assert a['deployed']==b['deployed'];n+=1
            if a['route'] not in (9,10):
                assert a==b,('Other-route stream changed',name,key(a));routes[a['route']]+=1
            else:
                assert a['pointCandidates']==b['pointCandidates']
                for arm,f in a['candidates'].items():
                    if arm.startswith('original_'):continue
                    assert f==b['candidates'][arm]==a['deployed']
                transfer[a['route']]+=1
            if name=='enriched.jsonl.gz':
                if a.get('label'):assert a['label']==b['label'] and a['truth']==b['truth']
                elif b.get('label'):added[b['route']]+=1
        counts[name]=dict(rows=n,exactOtherRouteRows=dict(routes),exactTransferFallbackRows=dict(transfer),additionalLabels=dict(added))
    assert hashes=={p:sha(ROOT/p) for p in hashes}
    output=dict(sourceRun=35741682149,sourceFittingCode='323ce80f95f254f29a713abc5b176628eaa507e2',pins=PINS,
        immutableHashes=hashes,counts=counts,noFitsOrNewScores=True)
    (HERE/'policy-comparison.json').write_text(json.dumps(output,indent=2)+'\n');print(json.dumps(counts))
if __name__=='__main__':main()
