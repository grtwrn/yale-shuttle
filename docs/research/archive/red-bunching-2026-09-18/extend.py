"""Apply every frozen bunching arm to the previously unopened afternoon capture."""
import bisect, collections, datetime, hashlib, json
import screen as s

OUT=s.OUT;ROOT=s.ROOT
fit_path=OUT/'fits.json';frozen=json.loads(fit_path.read_text());fit_hash=hashlib.sha256(fit_path.read_bytes()).hexdigest()
assert frozen['sourceSha256']==hashlib.sha256((OUT/'screen.py').read_bytes()).hexdigest()
assert frozen['planSha256']==hashlib.sha256((OUT/'PLAN.json').read_bytes()).hexdigest()
episodes,_,_,tables,old_extractor=s.load()
old_capture=json.loads((ROOT/'red-rest-history-2026-09-18/recordings.json').read_text())
path=ROOT/'red-bunching-data-2026-09-18/recordings.json'
opened=datetime.datetime.now(datetime.timezone.utc).isoformat()
capture=json.loads(path.read_text())
assert datetime.datetime.fromisoformat(opened)>datetime.datetime.fromisoformat(frozen['createdAt'])
assert capture['capturedAt']>datetime.datetime.fromisoformat(s.PLAN['createdAt']).timestamp()*1000
visits={v['id']:v for vs in old_extractor.anchors.values() for v in vs}
changes=[]
for v in capture['stop_visits']:
    if v['id'] in episodes:
        e=episodes[v['id']]
        if (v['pinned_at'],v['departed_at'])!=(e['a'],e['a']+round(e['y']*1000)):
            changes.append(dict(id=v['id'],old=[e['a'],e['y']],new=[v['pinned_at'],v['departed_at']]))
    visits[v['id']]=v
assert not changes,changes
extractor=s.Extractor(list(visits.values()),tables['sequence'],tables['edgeCosts'])
deps=collections.defaultdict(list)
for v in capture['arrivals']:deps[v['bus_name'],v['stop_id']].append(v['departed_at'])
for vs in deps.values():vs.sort()
def prior(bus,stop,at):
    vals=deps[bus,stop];i=bisect.bisect_right(vals,at-120000)
    return vals[i-1] if i else None
def ready(v):
    d=v['departed_at'];c=(v['confirm_sec'] or 0)*1000
    return max(d+120000,(v['first_moved_at'] or d)+c,d+c+15000)
new={};excluded=collections.Counter();ref=frozen['referenceLap']
for v in capture['stop_visits']:
    if v['route_id']!=3 or v['stop_id']!=11 or v['id'] in episodes:continue
    if not(v['pinned_at'] is not None and v['departed_at'] is not None and v['departed_at']>=v['pinned_at'] and
           v['outcome']=='stopped' and v['how']!='gap' and v['closest_m']<=75):
        excluded['not_eligible_complete_stopped']+=1;continue
    available=ready(v)
    if not(old_capture['capturedAt']<=available<capture['capturedAt']):
        excluded['not_newly_available_outcome']+=1;continue
    a=v['pinned_at'];day=s.day(a);dep=prior(v['bus_name'],11,a);other=prior(v['bus_name'],121,a)
    loop=dep is not None and other is not None and dep<other<a and s.day(dep)==day
    lap=(a-dep)/1000 if loop else None
    own_ok=other is not None and s.day(other)==day and 0<a-other<=7200000
    new[v['id']]=dict(id=v['id'],bus=v['bus_name'],day=day,a=a,y=(v['departed_at']-a)/1000,
        lap=lap,stop=11,ready=available,split='development',lapSupported=lap is not None and .65*ref<=lap<=1.65*ref,
        ownUnionDeparture=other if own_ok else None)
records=[]
for e in new.values():
    ages=[age for age in s.AGES if age<e['y']]
    for age in ages:
        r=dict(id=e['id'],bus=e['bus'],day=e['day'],pinAt=e['a'],forecastAt=e['a']+age*1000,
            elapsed=age,truthRemaining=e['y']-age,holdSec=e['y'],split=e['split'],lap=e['lap'],
            lapSupported=e['lapSupported'],weight=1/len(ages),ownUnionDeparture=e['ownUnionDeparture'])
        for delay in [15,120]:
            snap=extractor.snapshot(r,delay)
            p,active=s.predict(r,snap,ref,frozen['fits'],frozen['supports'])
            records.append(dict(r,delay=delay,snapshot=snap,predictions=p,gateActive=active))
scores=s.score(records)
meta=dict(openedAt=opened,fitFrozenAt=frozen['createdAt'],fitSha256=fit_hash,
    captureSha256=hashlib.sha256(path.read_bytes()).hexdigest(),oldCapturedAt=old_capture['capturedAt'],
    newCapturedAt=capture['capturedAt'],newVisitIds=sorted(new),newVisits=len(new),
    supportedVisits=sum(e['lapSupported'] for e in new.values()),excluded=dict(excluded),oldOutcomeChanges=changes,
    limitations='Coefficients, gates, travel proxies, and support frozen before capture opened. All three arms scored unchanged. Small same-day extension; not an independent-day validation. Outcome readiness is a conservative proxy, not exact publication time.')
(OUT/'extension-meta.json').write_text(json.dumps(meta,indent=2)+'\n')
(OUT/'extension-cohort.json').write_text(json.dumps(list(new.values()),indent=2)+'\n')
(OUT/'extension-predictions.jsonl').write_text(''.join(json.dumps(r,separators=(',',':'))+'\n' for r in records))
(OUT/'extension-scores.json').write_text(json.dumps(scores,indent=2)+'\n')
assert fit_hash==hashlib.sha256(fit_path.read_bytes()).hexdigest()
print(json.dumps(meta,indent=2))
for r in scores:
    if r['period']=='Sep18' and r['weighting']=='checkpoint' and r['group'] in ['all','supported_gate','close_follower','co_anchor']:
        print(json.dumps({**r,'arms':{a:{k:v[k] for k in ['visits','landmarks','mae','wis80','width80','earlyCount','lateCount']} for a,v in r['arms'].items()}}))
