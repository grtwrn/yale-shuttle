"""Export only the qualified broad K10 priors and an independent parity fixture."""
import gzip,json
from pathlib import Path
from evaluate import IN,OUT,ROUTES,CUTOFF,Models,Quality,read,clock
assert OUT.name=='long90'
model=Models(read(IN/'stop_visits.jsonl.gz'),Quality(read(IN/'raw_positions.jsonl.gz')))
models=[]
for rid,w in [(1,24),(16,0)]:
    seq=ROUTES[rid]['stops']
    paths={str(seq[ti]):[[e['day'],clock(e['start']),e['duration']] for e in es]
        for (route,k,wait,ti),es in model.paths.items() if (route,k,wait)==(rid,10,w)}
    assert len(paths)==len(seq)-1
    models.append(dict(version='blue-k10-20260921',trainBefore=CUTOFF,validUntil=1790568000000,
        sequence=seq,paths=paths,routeId=rid,label=ROUTES[rid]['name'],sourceIndex=(w-10)%len(seq),waitIndex=w))
(OUT/'blue-k10-models.json').write_text(json.dumps(models,separators=(',',':'))+'\n')
fixtures=[]
for r in read(OUT/'forecasts.jsonl.gz'):
    if r['route'] not in (1,16):continue
    rid=r['route'];seq=ROUTES[rid]['stops'];w=24 if rid==1 else 0;s=(w-10)%len(seq)
    ti=seq.index(r['target']);origin=r['origins'].get(str(s));release=r['origins'].get(str(w))
    evidence=None
    if r['ready'] and origin:
        evidence=dict(origin=origin,observedAt=r['observedAt'],index=r['index'],phase=r['phase'],released=bool(
            (release and release['departed']>origin['departed']) or (r['index']-s)%len(seq)>10 or (r['index']==w and r['phase']=='drive')))
    fixtures.append(dict(route=rid,now=r['at'],target=r['target'],stopsAhead=r['stopsAhead'],
        anchor=(ti-r['stopsAhead'])%len(seq),baseline=r['baseline'],evidence=evidence,expected=r['forecasts']['K10']))
with gzip.open(OUT/'blue-k10-parity.json.gz','wt') as f:json.dump(fixtures,f,separators=(',',':'))
print(json.dumps(dict(models=[dict(route=m['routeId'],paths=sum(len(v) for v in m['paths'].values()),targets=len(m['paths'])) for m in models],fixtures=len(fixtures))))
