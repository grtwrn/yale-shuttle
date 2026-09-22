"""Export only the qualified broad K10 priors and an independent parity fixture."""
import gzip,json
from pathlib import Path
from evaluate import IN,OUT,ROUTES,CUTOFF,Models,Quality,read,clock,WAITS,previous_wait
assert OUT.name=='long90'
model=Models(read(IN/'stop_visits.jsonl.gz'),Quality(read(IN/'raw_positions.jsonl.gz')))
audit=json.loads((OUT/'audit.json').read_text())
selected={int(k):v for k,v in json.loads((OUT/'selection.json').read_text())['selected'].items()}
assert selected=={14:'K10',15:'K8'}, selected
assert all(audit[str(rid)][arm]['passed'] for rid,arm in selected.items())
models=[]
for rid,arm in selected.items():
    k=int(arm[1:]);assert len(WAITS[rid])==1;w=WAITS[rid][0]
    seq=ROUTES[rid]['stops']
    paths={str(seq[ti]):[[e['day'],clock(e['start']),e['duration']] for e in es]
        for (route,k,wait,ti),es in model.paths.items() if (route,k,wait)==(rid,k,w)}
    assert len(paths)==len(seq)-1
    models.append(dict(version='route-checkpoint-20260921',trainBefore=CUTOFF,validUntil=1790568000000,
        sequence=seq,paths=paths,routeId=rid,label=ROUTES[rid]['name'],sourceIndex=(w-k)%len(seq),waitIndex=w))
(OUT/'route-k10-models.json').write_text(json.dumps(models,separators=(',',':'))+'\n')
fixtures=[]
for r in read(OUT/'forecasts.jsonl.gz'):
    if r['route'] not in selected:continue
    rid=r['route'];arm=selected[rid];k=int(arm[1:]);seq=ROUTES[rid]['stops'];w=WAITS[rid][0];s=(w-k)%len(seq)
    ti=seq.index(r['target']);origin=r['origins'].get(str(s));release=r['origins'].get(str(w))
    evidence=None
    if r['ready'] and origin:
        evidence=dict(origin=origin,observedAt=r['observedAt'],index=r['index'],phase=r['phase'],released=bool(
            r.get('releasedOrigins',{}).get(f'{k}/{w}')==origin['departed'] or (release and release['departed']>origin['departed']) or (r['index']-s)%len(seq)>k or (r['index']==w and r['phase']=='drive')))
    fixtures.append(dict(route=rid,now=r['at'],target=r['target'],stopsAhead=r['stopsAhead'],
        anchor=(ti-r['stopsAhead'])%len(seq),baseline=r['baseline'],evidence=evidence,expected=r['forecasts'][arm]))
with gzip.open(OUT/'route-k10-parity.json.gz','wt') as f:json.dump(fixtures,f,separators=(',',':'))
print(json.dumps(dict(models=[dict(route=m['routeId'],paths=sum(len(v) for v in m['paths'].values()),targets=len(m['paths'])) for m in models],fixtures=len(fixtures))))
