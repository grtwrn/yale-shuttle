"""Builder verification of provenance, numerical metrics and retained regressions."""
import collections
import datetime as dt
import hashlib
import json
import math
from pathlib import Path
import sqlite3
from role_state import day,ready,FIT
from run_role import OUT,OLD,ROOT,ARMS,CONTRACTS

plan=json.loads((OUT/'PLAN.json').read_text())
for p,h in {**plan['inputs'],**plan['currentComparatorHashes']}.items():
    assert hashlib.sha256(Path(p).read_bytes()).hexdigest()==h,p
landmarks=[json.loads(l) for l in (OUT/'role-landmarks.jsonl').read_text().splitlines()]
predictions=[json.loads(l) for l in (OUT/'predictions.jsonl').read_text().splitlines()]
con=sqlite3.connect(f'file:{ROOT}/conditional-replay-data/outcomes.db?mode=ro',uri=True);con.row_factory=sqlite3.Row
visits={v['id']:dict(v) for v in con.execute('SELECT * FROM stop_visits')}
weights=collections.defaultdict(float);history_checks=0
for r in landmarks:
    v=visits[r['id']]
    assert r['pinAt']==v['pinned_at'] and r['forecastAt']==r['pinAt']+r['elapsed']*1000
    assert abs(r['truthRemaining']-(v['departed_at']-r['forecastAt'])/1000)<1e-9
    weights[r['id'],r['regime']]+=r['landmarkWeight']
    for vid,known,physical in zip(r['role']['ids'],r['role']['knownTimes'],r['role']['physicalTimes']):
        source=visits[vid]
        assert source['bus_name']==r['bus'] and source['stop_id']==r['stop'] and source['route_id']==3
        assert physical==source['departed_at']<r['pinAt'] and day(physical)==r['day']
        assert known==ready(source)+(120000 if r['regime']=='confirmed240' else 0)<=r['pinAt']
        assert vid!=r['id'] and vid!=65237
        history_checks+=1
assert len(weights)==1070 and all(abs(v-1)<1e-12 for v in weights.values())
assert {64318,58224,65347,48550,51469,54002,52633,52168,54777,53429}<={r['id'] for r in landmarks}
extraction=json.loads((OUT/'extraction.json').read_text())
assert all(p['known']<FIT for p in extraction['trainingThresholdPairs'])
primary={(r['id'],r['elapsed']):r for r in landmarks if r['regime']==CONTRACTS[0]}
delayed={(r['id'],r['elapsed']):r for r in landmarks if r['regime']==CONTRACTS[1]}
assert primary.keys()==delayed.keys()
for k,r in primary.items():
    clean=lambda s:{key:value for key,value in s.items() if key!='knownTimes'}
    assert clean(r['role'])==clean(delayed[k]['role'])
reset_events={(r['stop'],x['atId']):x['reason'] for r in primary.values() if r['elapsed']==0 for x in r['role']['resets']}
by=collections.defaultdict(dict)
for p in predictions:
    assert 0<=p['q'][0]<=p['q'][1]<=p['q'][2] and all(math.isfinite(x) for x in p['q'])
    by[p['id'],p['elapsed'],p['regime']][p['arm']]=p
assert len(by)==1444 and all(set(v)==set(ARMS) for v in by.values())
for arms in by.values():
    if not arms[ARMS[0]]['roleSupported']:assert all(p['q']==arms[ARMS[0]]['q'] for p in arms.values())

# Recompute overall proper-score and directional-tail values without metric helper.
metric_checks=0
for score in json.loads((OUT/'scores.json').read_text()):
    if score['group']!='all' or score['arm']=='current_code_component':continue
    rs=[r for r in predictions if (r['stop'],r['regime'],r['arm'])==(score['stop'],score['contract'],score['arm'])]
    weight=[r['landmarkWeight'] if score['weighting']=='original_cohort' else 1 for r in rs];total=sum(weight)
    mae=wis=width=early=late=0
    for r,w in zip(rs,weight):
        lo,med,hi=r['q'];truth=r['truthRemaining'];w/=total
        mae+=w*abs(med-truth);width+=w*(hi-lo)
        wis+=w*(.5*abs(med-truth)+.1*(hi-lo)+max(0,lo-truth)+max(0,truth-hi))/1.5
        early+=w*(truth<lo);late+=w*(truth>hi)
    for key,value in [('mae',mae),('wis80',wis),('width80',width),('earlyRate',early),('lateRate',late)]:assert abs(value-score[key])<1e-9,(key,value,score[key])
    metric_checks+=1

top=[r for r in json.loads((OUT/'top-regressions.json').read_text()) if r['contract']==CONTRACTS[0] and r['comparator']==ARMS[0]]
selected={r['id']:visits[r['id']] for r in top};frames=collections.defaultdict(list)
for line in (ROOT/'conditional-replay-data/raw-frames.jsonl').open():
    f=json.loads(line);at=round(dt.datetime.fromisoformat(f['at'].replace('Z','+00:00')).timestamp()*1000)
    for vid,v in selected.items():
        if not v['anchored_at']-60000<=at<=v['departed_at']+60000:continue
        for b in f['buses']:
            if b['route_id']==3 and b['bus_name']==v['bus_name'] and b.get('observed_at')==at:
                frames[vid].append(dict(at=at,lat=b['lat'],lon=b['lon']))
audits=[]
for vid,v in selected.items():
    assert v['outcome']=='stopped' and v['how']!='gap' and v['rest_polls']>0
    legs=[dict(x) for x in con.execute('SELECT id,from_stop_id,to_stop_id,departed_at,arrived_at,hops FROM legs WHERE route_id=3 AND bus_name=? AND departed_at=?',(v['bus_name'],v['departed_at']))]
    fs=frames[vid];ds=[f for f in fs if f['at']==v['departed_at']]
    change=next((f for f in fs if ds and f['at']>ds[0]['at'] and (f['lat'],f['lon'])!=(ds[0]['lat'],ds[0]['lon'])),None)
    if fs:assert len(ds)==1 and change and fs[0]['at']<=v['anchored_at'] and fs[-1]['at']>=v['departed_at']+30000
    role=next(r['role'] for r in landmarks if r['id']==vid and r['regime']==CONTRACTS[0] and r['elapsed']==0)
    audits.append(dict(id=vid,bus=v['bus_name'],stop=v['stop_id'],day=day(v['pinned_at']),holdSec=(v['departed_at']-v['pinned_at'])/1000,anchorToPinSec=(v['pinned_at']-v['anchored_at'])/1000,outcome=v['outcome'],how=v['how'],restPolls=v['rest_polls'],shuffles=v['shuffles'],outgoingLegs=legs,historyIds=role['ids'],resets=role['resets'],rawPolls=len(fs),maxRawGapSec=max(((b['at']-a['at'])/1000 for a,b in zip(fs,fs[1:])),default=None),changedCoordinateAfterDepartureSec=(change['at']-v['departed_at'])/1000 if change else None,decision='Retain; no positively established measurement error. Missing raw coverage is not an exclusion. Repeated GPS is deadband-censored, not a driver-policy or receipt-time measurement.'))
con.close()
result=dict(hashReferences=len({**plan['inputs'],**plan['currentComparatorHashes']}),historyEventUses=history_checks,weightSums=len(weights),forecastGroups=len(by),forecasts=len(predictions),numericalScoreRows=metric_checks,retainedPriorAuditedCases=10,latencyFeatureEqualityChecks=len(primary),uniqueHistoricalResets=len(reset_events),resetReasons=dict(collections.Counter(f'{stop}/{reason}' for (stop,vid),reason in reset_events.items())),regressionRecords=len(audits),regressionsWithRaw=sum(bool(r['rawPolls']) for r in audits),regressions=audits)
(OUT/'verification.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps({k:v for k,v in result.items() if k!='regressions'},indent=2))
for r in audits:print(json.dumps({k:r[k] for k in ('id','holdSec','anchorToPinSec','rawPolls','maxRawGapSec','changedCoordinateAfterDepartureSec')}))
