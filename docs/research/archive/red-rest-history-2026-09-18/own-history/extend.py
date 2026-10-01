"""Score immutable later capture only after original coefficients are frozen."""
from pathlib import Path
import bisect, collections, datetime, hashlib, json
import numpy as np
import screen as s

OUT=s.OUT;ROOT=s.ROOT
frozen=json.loads((OUT/'fits.json').read_text())
fits=frozen['fits'];ref=frozen['referenceLap'];uref=frozen['referenceUnionAge']
old_capture=json.loads((ROOT/'red-early-covariates-2026-09-18/recordings-followup.json').read_text())
path=OUT.parent/'recordings.json';capture=json.loads(path.read_text())
episodes={e['id']:e for e in json.loads((OUT/'cohort.json').read_text())}
visits,bybus=s.load_history()
changes=[]
for v in capture['stop_visits']:
    if v['id'] in episodes:
        e=episodes[v['id']]
        if (v['pinned_at'],v['departed_at'])!=(e['a'],e['a']+round(e['y']*1000)):
            changes.append(dict(id=v['id'],old=[e['a'],e['y']],new=[v['pinned_at'],v['departed_at']]))
    visits[v['id']]=v
assert not changes,changes
bybus=collections.defaultdict(list)
for v in visits.values():bybus[v['bus_name']].append(v)
for vs in bybus.values():vs.sort(key=lambda v:(v['anchored_at'],v['id']))
departures=collections.defaultdict(list)
for v in capture['arrivals']:departures[v['bus_name'],v['stop_id']].append(v['departed_at'])
for vs in departures.values():vs.sort()
def prior(bus,stop,at):
    vals=departures[bus,stop];i=bisect.bisect_right(vals,at-120000)
    return vals[i-1] if i else None
new={};excluded=collections.Counter()
for v in visits.values():
    if v['route_id']!=3 or v['stop_id']!=11 or v['id'] in episodes:continue
    if not(v['pinned_at'] is not None and v['departed_at'] is not None and v['departed_at']>=v['pinned_at'] and v['outcome']=='stopped' and v['how']!='gap' and v['closest_m']<=75):
        excluded['not_eligible_complete_stopped']+=1;continue
    ready=s.known(v,'primary')
    if not(old_capture['capturedAt']<=ready<capture['capturedAt']):
        excluded['not_newly_available_outcome']+=1;continue
    a=v['pinned_at'];day=s.day(a);dep=prior(v['bus_name'],11,a);other=prior(v['bus_name'],121,a)
    loop=dep is not None and other is not None and dep<other<a and s.day(dep)==day
    lap=(a-dep)/1000 if loop else None
    own_ok=other is not None and s.day(other)==day and 0<a-other<=7200000
    e=dict(id=v['id'],bus=v['bus_name'],day=day,a=a,y=(v['departed_at']-a)/1000,lap=lap,stop=11,
        ready=ready,split='development',lapSupported=lap is not None and .65*ref<=lap<=1.65*ref,
        ownUnionDeparture=other if own_ok else None,ownUnionAge=(a-other)/1000 if own_ok else None)
    e['histories']={reg:s.history(e,bybus,s.PLAN['redSequence'],reg) for reg in s.REGIMES}
    new[e['id']]=e
records=[]
for e in new.values():
    ages=[age for age in [0,60,180,300,480] if age<e['y']]
    for reg in s.REGIMES:
        use='primary' if 'alias' in fits[reg] else reg
        for age in ages:
            r=dict(id=e['id'],bus=e['bus'],day=e['day'],pinAt=e['a'],forecastAt=e['a']+age*1000,elapsed=age,
                truthRemaining=e['y']-age,holdSec=e['y'],lap=e['lap'],weight=1/len(ages),split='development',regime=reg,
                lapSupported=e['lapSupported'],ownUnionDeparture=e['ownUnionDeparture'],predictions={})
            for arm in s.ARMS:
                d=s.distribution(e,np.array(fits[use][arm]['coefficients']),ref,uref,arm,reg)
                q,p=s.base.remaining(d,age);r['predictions'][arm]=dict(q=q,p120=p)
            records.append(r)
scores=[]
for reg in s.REGIMES:
    rr=[r for r in records if r['regime']==reg]
    if not rr:continue
    for score in s.base.summarize(rr,s.ARMS):scores.append(dict(regime=reg,**score))
meta=dict(openedAfterFit=frozen['createdAt'],scoredAt=datetime.datetime.now(datetime.timezone.utc).isoformat(),
    fitSha256=hashlib.sha256((OUT/'fits.json').read_bytes()).hexdigest(),captureSha256=hashlib.sha256(path.read_bytes()).hexdigest(),
    oldCapturedAt=old_capture['capturedAt'],newCapturedAt=capture['capturedAt'],newVisitIds=sorted(new),newVisits=len(new),
    supportedVisits=sum(e['lapSupported'] for e in new.values()),excluded=dict(excluded),oldOutcomeChanges=changes,
    limitations='All predefined coefficients frozen before reading new capture; no fitting or candidate selection on these new outcomes. Same Sep18 and very few later visits, not independent day confirmation.')
(OUT/'extension-meta.json').write_text(json.dumps(meta,indent=2)+'\n')
(OUT/'extension-cohort.json').write_text(json.dumps(list(new.values()),indent=2)+'\n')
(OUT/'extension-predictions.jsonl').write_text(''.join(json.dumps(r)+'\n' for r in records))
(OUT/'extension-scores.json').write_text(json.dumps(scores,indent=2)+'\n')
print(json.dumps(meta,indent=2))
for r in scores:
    if (r['regime'],r['period'],r['cohort'],r['weighting'])==('primary','Sep18','lap_supported','visit'):
        print(json.dumps({a:{k:v[k] for k in ['visits','landmarks','mae','wis80','width80','earlyCount','lateCount']} for a,v in r['arms'].items()},indent=2))
