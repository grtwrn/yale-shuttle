"""Independent arithmetic/provenance review; source artifacts are read-only."""
import collections
import hashlib
import json
import math
from pathlib import Path
import sqlite3
import statistics
import numpy as np

ROOT = Path('/home/gwarren/projects/yale-shuttle-watcher')
TEAM = ROOT / 'overnight-2026-09-17/eta'
C1 = TEAM / 'cycle-1'
C2 = TEAM / 'cycle-2'
OUT = Path(__file__).resolve().parent
read = lambda p: json.loads(p.read_text())
lines = lambda p: [json.loads(s) for s in p.read_text().splitlines()]
report = {}
hashes = {}
for p, key in ((C1/'PLAN.json','inputs'), (C1/'COMPARATOR_PLAN.json','hashes'), (C2/'PLAN.json','inputs')):
    for name, expected in read(p)[key].items():
        actual = hashlib.sha256(Path(name).read_bytes()).hexdigest()
        assert actual == expected, name
        hashes[name] = actual
fit_file = read(C1/'fits.json')
assert hashlib.sha256((C1/'fit_landmarks.py').read_bytes()).hexdigest() == fit_file['scriptSha256']
assert hashlib.sha256((C1/'PLAN.json').read_bytes()).hexdigest() == fit_file['planSha256']
report['frozenHashesVerified'] = len(hashes) + 2

rows = lines(C1/'landmarks.jsonl')
cohort = read(C1/'cohort.json')
preds = lines(C1/'predictions.jsonl')
base = read(C1/'comparator.json')['forecasts']
fits = {(r['stop'], r['regime'], r['arm']): r for r in fit_file['fits']}
lookup = {(r['id'],r['elapsed'],r['regime']):r for r in rows}
assert len(rows) == len(lookup) == 3898
assert len(cohort) == 535
db = sqlite3.connect('file:'+str(ROOT/'conditional-replay-data/outcomes.db')+'?mode=ro', uri=True)
db.row_factory = sqlite3.Row
weights = collections.defaultdict(float)
for r in rows:
    v = db.execute('SELECT * FROM stop_visits WHERE id=?',(r['id'],)).fetchone()
    assert r['pinAt'] == v['pinned_at']
    assert r['forecastAt'] == r['pinAt'] + 1000*r['elapsed']
    assert abs(r['truthRemaining'] - (v['departed_at']-r['forecastAt'])/1000) < 1e-9
    assert r['truthRemaining'] > 0
    assert r['outcomeReady'] >= v['departed_at']+120000
    if r['split'] == 'train': assert r['outcomeReady'] < 1789012800000
    if r['split'] == 'development': assert r['pinAt'] >= 1789358400000
    weights[r['id'],r['regime']] += r['landmarkWeight']
    for side in ('ahead','follower'):
        identity = r['identities'][side]
        if identity:
            assert identity['known'] <= r['pinAt'] and identity['originKnown'] <= r['pinAt']
            assert identity['bus'] != r['bus']
        snapshot = r['snapshots'][side]
        for event in [snapshot['latestAllRoute'], snapshot['progress'], *snapshot['reached']]:
            if event: assert event['known'] <= r['forecastAt']
        if snapshot['usable']:
            assert snapshot['latestAllRoute']['route'] == 3
            assert r['forecastAt']-snapshot['latestAllRoute']['physical'] <= 600000
        else: assert not any(snapshot['features'])
assert len(weights) == 1070 and all(abs(x-1)<1e-12 for x in weights.values())
assert 65237 not in {r['id'] for r in cohort}
assert set((64318,58224,65347,48550,51469,54002,52633,52168,54777,53429)) <= {r['id'] for r in cohort}
report['landmarkTruthAndKnownTimeChecks'] = len(rows)
report['normalizedVisitContractPairs'] = len(weights)

def independent_design(r):
    elapsed = np.arange(7.5, 1800, 15) + r['elapsed']
    theta = (r['pinAt']/1000 % 900 + elapsed)*2*math.pi/900
    sine, cosine = np.sin(theta), np.cos(theta)
    lap = (r['lap']-r['referenceLap'])/600 if r['lapSupported'] else 0
    core = np.stack([np.ones(120), np.log1p(elapsed/60), elapsed/600,
        np.clip(elapsed-300,0,None)/600, np.clip(elapsed-600,0,None)/600,
        np.repeat(lap,120), np.repeat(float(not r['lapSupported']),120),
        sine, cosine, np.repeat(r['elapsed']/600,120)], axis=1)
    peers=[]
    for side in ('ahead','follower'):
        values=np.asarray(r['snapshots'][side]['features'])
        if not r['lapSupported']: values=np.zeros_like(values)
        peers.extend((np.outer(np.ones(120),values),np.outer(sine,values),np.outer(cosine,values)))
    return core,np.concatenate(peers,axis=1)

def independent_quantiles(z):
    rates=np.logaddexp(0,z)/15
    tail=min(.2,max(1/1800,float(rates[-1])))
    answer=[]
    for probability in (.1,.5,.9):
        remaining=-math.log(1-probability)
        seconds=0.
        for rate in rates:
            if remaining <= rate*15:
                seconds += remaining/rate
                break
            remaining -= rate*15
            seconds += 15
        else: seconds += remaining/tail
        answer.append(seconds)
    return answer

max_delta=0
for p in preds:
    r=lookup[p['id'],p['elapsed'],p['regime']]
    assert r['split']=='development'
    assert (r['forecastAt'],r['truthRemaining'],r['landmarkWeight']) == (p['forecastAt'],p['truthRemaining'],p['landmarkWeight'])
    core,peer=independent_design(r)
    f=fits[p['stop'],p['regime'],'landmark_lap_elapsed_clock']
    z=core @ np.asarray(f['coefficients'])
    if p['arm']!='landmark_lap_elapsed_clock':
        f=fits[p['stop'],p['regime'],p['arm']]
        z += peer[:,f['columns']] @ np.asarray(f['coefficients'])
    q=independent_quantiles(z)
    delta=max(abs(a-b) for a,b in zip(q,p['q']))
    max_delta=max(max_delta,delta)
    assert delta < 1e-7, (p['id'],delta)
assert len(preds)==4332
report['forecastsIndependentlyRecomputed']=len(preds)
report['maximumQuantileDifferenceSec']=max_delta

baseline={(r['id'],r['elapsed']):r for r in base}
all_rows=list(preds)
for r in preds:
    if r['arm']=='landmark_lap_elapsed_clock':
        b=baseline[r['id'],r['elapsed']]
        all_rows.append({**r,**b})

def metrics(rs,visit):
    ww=[r['landmarkWeight'] if visit else 1 for r in rs]
    total=sum(ww)
    values=collections.defaultdict(list)
    for r in rs:
        lo,med,hi=r['q'];y=r['truthRemaining']
        err=abs(med-y)
        interval=hi-lo+10*max(lo-y,0)+10*max(y-hi,0)
        for key,value in dict(mae=err,wis80=(.5*err+.1*interval)/1.5,width80=hi-lo,
                              earlyRate=float(y<lo),lateRate=float(y>hi)).items():
            values[key].append(value)
    result={k:sum(w*x for w,x in zip(ww,v))/total for k,v in values.items()}
    result['earlyCount']=sum(values['earlyRate']);result['lateCount']=sum(values['lateRate'])
    result.update(visits=len({r['id'] for r in rs}),landmarks=len(rs),dates=len({r['day'] for r in rs}))
    ordered=sorted(zip(values['mae'],ww))
    for name,prob in [('medianAbs',.5),('p90Abs',.9)]:
        cum=0
        for err,w in ordered:
            cum += w
            if cum >= prob*total-1e-12:
                result[name]=err;break
    return result

def group_rows(rs,group):
    if group=='all':return rs
    if group=='lap_supported':return [r for r in rs if r['lapSupported']]
    if group=='lap_unsupported':return [r for r in rs if not r['lapSupported']]
    if group=='follower_unknown':return [r for r in rs if not r['followerKnown']]
    if group=='follower_same_as_ahead':return [r for r in rs if r['followerKnown'] and r['sameAsAhead']]
    if group=='follower_distinct':return [r for r in rs if r['followerKnown'] and not r['sameAsAhead']]
    if group.startswith('elapsed_'):return [r for r in rs if r['elapsed']==int(group.split('_')[1])]
    return [r for r in rs if r['day']==group]

scores=read(C1/'scores.json')
for s in scores:
    rs=[r for r in all_rows if (r['stop'],r['regime'],r['arm'])==(s['stop'],s['regime'],s['arm'])]
    rs=group_rows(rs,s['group'])
    got=metrics(rs,s['weighting']=='visit')
    for key,value in got.items():
        # Check the weighted quantile bracket, allowing either adjacent outcome
        # only when the requested probability lies exactly on a weight boundary.
        if key in ('medianAbs','p90Abs'):
            probability=.5 if key=='medianAbs' else .9
            selected=s[key]
            pairs=[(abs(r['q'][1]-r['truthRemaining']),r['landmarkWeight'] if s['weighting']=='visit' else 1) for r in rs]
            total=sum(w for _,w in pairs)
            below=sum(w for error,w in pairs if error<selected-1e-9)
            through=sum(w for error,w in pairs if error<=selected+1e-9)
            assert below<=probability*total+1e-9 and through>=probability*total-1e-9
            assert any(abs(error-selected)<1e-9 for error,_ in pairs)
            continue
        assert abs(value-s[key])<1e-8,(s,key,value,s[key])
report['scoreRowsIndependentlyRecomputed']=len(scores)
report['primaryTotals']=[s for s in scores if s['group']=='all' and s['weighting']=='visit' and s['regime']=='arrival15']
report['fixedLandmarkWeightRanges']={str(stop):sorted({r['landmarkWeight'] for r in rows if r['split']=='development' and r['stop']==stop and r['elapsed']==0}) for stop in (11,121)}
regressions=read(C1/'top-regressions.json')
comparisons={(r['stop'],r['regime'],r['arm'],r['comparator']) for r in regressions}
for stop,regime,arm,comparator in comparisons:
    cc=collections.defaultdict(list);bb=collections.defaultdict(list)
    for r in all_rows:
        if (r['stop'],r['regime'])!=(stop,regime):continue
        if r['arm']==arm:cc[r['id']].append(r)
        if r['arm']==comparator:bb[r['id']].append(r)
    delta={vid:metrics(rr,True)['wis80']-metrics(bb[vid],True)['wis80'] for vid,rr in cc.items()}
    expected=sorted(delta,key=lambda vid:-delta[vid])[:5]
    actual=[r for r in regressions if (r['stop'],r['regime'],r['arm'],r['comparator'])==(stop,regime,arm,comparator)]
    assert expected==[r['id'] for r in actual]
    assert all(abs(delta[r['id']]-r['deltaWIS'])<1e-8 for r in actual)
report['topFiveRegressionComparisonsVerified']=len(comparisons)

# Independently verify selection and actual visit/leg connectivity, beyond telescoping sums.
manifest=read(C2/'case-manifest.json')
original=read(ROOT/'release-integration-data/final-development-score.json')
groups=collections.defaultdict(list)
for r in original['checkpoints']:
    assert r['warmMs']>=600000
    groups[r['sourceId']].append(r)
for stop in (11,121):
    order=sorted((sid for sid,rr in groups.items() if rr[0]['sourceStop']==stop),
        key=lambda sid:(-statistics.mean(abs(r['candidate']['eta']-r['truthSec']) for r in groups[sid]),sid))[:5]
    assert order==[r['sourceId'] for r in manifest['selection'] if r['sourceStop']==stop]
chains=0
for case in manifest['selection']:
    for j in case['journeys']:
        source=db.execute('SELECT * FROM stop_visits WHERE id=?',(j['sourceId'],)).fetchone()
        target=db.execute('SELECT * FROM stop_visits WHERE id=?',(j['targetVisitId'],)).fetchone()
        legs=[db.execute('SELECT * FROM legs WHERE id=?',(lid,)).fetchone() for lid in j['legIds']]
        assert legs[0]['from_stop_id']==source['stop_id'] and legs[0]['departed_at']==source['departed_at']
        assert legs[-1]['to_stop_id']==target['stop_id']==j['target']
        assert all(l['bus_name']==source['bus_name']==target['bus_name'] and l['route_id']==3 for l in legs)
        assert all(a['to_stop_id']==b['from_stop_id'] and a['arrived_at']<=b['departed_at'] for a,b in zip(legs,legs[1:]))
        # The archived scoring contract uses arrived_at for both outcome types;
        # pin/anchor are distinct clocks and must not silently replace the label.
        expected=target['arrived_at']
        assert j['targetArrivedAt']==expected
        direct=(expected-source['pinned_at'])/1000
        parts=(source['departed_at']-source['pinned_at'])/1000
        parts+=sum((l['arrived_at']-l['departed_at'])/1000 for l in legs)
        parts+=sum((b['departed_at']-a['arrived_at'])/1000 for a,b in zip(legs,legs[1:]))
        parts+=(expected-legs[-1]['arrived_at'])/1000
        assert abs(direct-parts)<1e-8
        chains+=1
assert chains==20
report['connectedChainsAndTimeIdentities']=chains
report['selectedSourceIds']=[r['sourceId'] for r in manifest['selection']]
audit=read(C1/'regression-record-audit.json')
assert 'firstPublished' not in (C1/'regression-record-audit.json').read_text()
assert read(C1/'regression-record-audit.before-clock-label-fix.json')['SUPERSEDED']
for r in audit['completedRecords']:
    v=db.execute('SELECT * FROM stop_visits WHERE id=?',(r['id'],)).fetchone()
    assert v['outcome']=='stopped' and v['how']!='gap' and v['rest_polls']>0
    assert r['outgoingLegs']
    assert abs(r['holdSec']-(v['departed_at']-v['pinned_at'])/1000)<1e-9
report['retainedRegressionRecordsVerified']=len(audit['completedRecords'])
db.close()
(OUT/'evidence-check.json').write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps({k:v for k,v in report.items() if k!='primaryTotals'},indent=2))
