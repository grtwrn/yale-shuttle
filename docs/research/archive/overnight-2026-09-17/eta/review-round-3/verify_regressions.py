"""Independently check paired-selection arithmetic and recorded coordinates."""
import collections, datetime as dt, hashlib, json, math, sqlite3
from pathlib import Path
OUT=Path(__file__).resolve().parent; P=OUT.parent/'cycle-3'; ROOT=Path('/home/gwarren/projects/yale-shuttle-watcher')
load=lambda p:json.loads(p.read_text())
manifest=load(P/'artifact-hashes.json')['files']
for path,info in manifest.items():
    data=Path(path).read_bytes();assert len(data)==info['bytes'] and hashlib.sha256(data).hexdigest()==info['sha256']
rows=[json.loads(s) for s in (P/'predictions.jsonl').read_text().splitlines()]
current={(r['id'],r['elapsed']):r for r in load(OUT.parent/'cycle-1/comparator.json')['forecasts']}
core='landmark_lap_elapsed_clock';recursive='plus_recursive_role'
rows += [dict(r,arm='current_code_component',q=current[r['id'],r['elapsed']]['q']) for r in list(rows) if r['arm']==core]
by=collections.defaultdict(list)
for r in rows:by[r['id'],r['regime'],r['arm']].append(r)
def score(rs):
    result=dict(mae=0,wis80=0);total=sum(r['landmarkWeight'] for r in rs)
    for r in rs:
        w=r['landmarkWeight']/total;lo,med,hi=r['q'];y=r['truthRemaining'];ae=abs(med-y)
        result['mae']+=w*ae;result['wis80']+=w*(.5*ae+.1*(hi-lo)+max(0,lo-y)+max(0,y-hi))/1.5
    return result
paired=load(P/'paired-visits.json');recomputed=[]
for r in paired:
    ca=by[r['id'],r['contract'],recursive];ba=by[r['id'],r['contract'],r['comparator']]
    cm=score(ca);bm=score(ba)
    assert len(ca)==len(ba) and {x['elapsed'] for x in ca}=={x['elapsed'] for x in ba}
    for k in ('mae','wis80'):
        assert abs(cm[k]-r['candidate'][k])<1e-9 and abs(bm[k]-r['current'][k])<1e-9
    assert abs((cm['wis80']-bm['wis80'])-r['deltaWIS'])<1e-9
    assert abs((cm['mae']-bm['mae'])-r['deltaMAE'])<1e-9
    for f in r['forecasts']:
        c=next(x for x in ca if x['elapsed']==f['elapsed']);b=next(x for x in ba if x['elapsed']==f['elapsed'])
        assert c['q']==f['candidate'] and b['q']==f['baseline'] and c['truthRemaining']==b['truthRemaining']==f['truth']
    recomputed.append(dict(r,deltaWIS=cm['wis80']-bm['wis80']))
tops=load(P/'top-regressions.json');top_groups=0
for stop in (11,121):
    for contract in ('confirmed120','confirmed240'):
        for comparator in (core,'plus_two_history_phase','current_code_component'):
            group=[r for r in recomputed if (r['stop'],r['contract'],r['comparator'])==(stop,contract,comparator)]
            expected=[r['id'] for r in sorted(group,key=lambda r:-r['deltaWIS'])[:5]]
            actual=[r['id'] for r in tops if (r['stop'],r['contract'],r['comparator'])==(stop,contract,comparator)]
            assert expected==actual;top_groups+=1
con=sqlite3.connect(f'file:{ROOT}/conditional-replay-data/outcomes.db?mode=ro',uri=True);con.row_factory=sqlite3.Row
saved_audits=load(P/'verification.json')['regressions']
selected={r['id']:dict(con.execute('SELECT * FROM stop_visits WHERE id=?',(r['id'],)).fetchone()) for r in saved_audits}
con.close()
observations=collections.defaultdict(list);frames=0;route_counts=collections.Counter();route_names=collections.defaultdict(set)
for line in (ROOT/'conditional-replay-data/raw-frames.jsonl').open():
    f=json.loads(line);frames+=1;at=round(dt.datetime.fromisoformat(f['at'].replace('Z','+00:00')).timestamp()*1000)
    for b in f['buses']:
        route_counts[b['route_id']]+=1;route_names[b['route_id']].add(b['bus_name'])
        for vid,v in selected.items():
            if b['route_id']==3 and b['bus_name']==v['bus_name'] and b.get('observed_at')==at and v['anchored_at']-60000<=at<=v['departed_at']+60000:
                observations[vid].append((at,b['lat'],b['lon']))
audits=[]
for a in saved_audits:
    v=selected[a['id']];fs=observations[a['id']];assert len(fs)==a['rawPolls']
    maxgap=max(((b[0]-x[0])/1000 for x,b in zip(fs,fs[1:])),default=None)
    assert maxgap==a['maxRawGapSec']
    if fs:
        departure=next(f for f in fs if f[0]==v['departed_at'])
        changed=next(f for f in fs if f[0]>departure[0] and f[1:]!=departure[1:])
        assert (changed[0]-departure[0])/1000==a['changedCoordinateAfterDepartureSec']
        assert fs[0][0]<=v['anchored_at'] and fs[-1][0]>=v['departed_at']+30000
    assert a['anchorToPinSec']==(v['pinned_at']-v['anchored_at'])/1000
    audits.append({k:a[k] for k in ('id','holdSec','anchorToPinSec','rawPolls','maxRawGapSec','changedCoordinateAfterDepartureSec')})
assert next(a for a in audits if a['id']==62056)['holdSec']==15.002
assert next(a for a in audits if a['id']==65621)['maxRawGapSec']==21.259
inventory=load(OUT.parent/'cycle-4/input-inventory.json')
assert inventory['frames']==frames==12654 and dict(route_counts)=={3:36516}
assert {k:len(v) for k,v in route_names.items()}=={3:4}
for p,h in inventory['hashes'].items():assert hashlib.sha256(Path(p).read_bytes()).hexdigest()==h
result=dict(artifactHashes=len(manifest),pairedVisits=len(paired),topFiveComparisons=top_groups,regressionAudits=audits,rawCovered=sum(bool(a['rawPolls']) for a in audits),archiveFrames=frames,archiveRoutes=dict(route_counts),inventoryHashes=len(inventory['hashes']))
(OUT/'regression-check.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result,indent=2))
