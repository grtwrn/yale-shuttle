"""Bounded read-only history measurement audit. No fits or record corrections."""
from pathlib import Path
import collections
import datetime as dt
import json
import math
import sqlite3
from zoneinfo import ZoneInfo

ROOT = Path('/home/gwarren/projects/yale-shuttle-watcher')
OUT = ROOT / 'red-rest-history-2026-09-18'
TZ = ZoneInfo('America/New_York')
STOPS = {11,121,117,13,14}
CURRENT = (64318,64854,65347,68304,70927,58505,65119,67621)
QUARANTINED_DURATION = {65237}
fresh = json.loads((OUT/'recordings.json').read_text())
db = sqlite3.connect(f'file:{ROOT / "release-integration-data/outcomes-complete.db"}?mode=ro',uri=True)
db.row_factory = sqlite3.Row
visits = {v['id']:dict(v) for v in db.execute('SELECT * FROM stop_visits WHERE route_id=3 AND stop_id IN(11,121,117,13,14)')}
for v in fresh['stop_visits']:
    if v['route_id']==3 and v['stop_id'] in STOPS:
        if v['id'] in visits:
            assert (v['bus_name'],v['anchored_at']) == (visits[v['id']]['bus_name'],visits[v['id']]['anchored_at'])
        visits[v['id']] = v
stops = {v['id']:dict(v) for v in db.execute('SELECT * FROM stops')}
seq = json.loads(db.execute('SELECT stops_json FROM routes WHERE id=3').fetchone()[0])
legs = {v['id']:dict(v)for v in db.execute('SELECT * FROM legs WHERE route_id=3')}
legs.update({v['id']:v for v in fresh['legs']if v['route_id']==3})


def day(at):
    return dt.datetime.fromtimestamp(at/1000,TZ).date().isoformat()


def known(v,strict=False):
    if v['departed_at'] is None or v['how']=='gap':return None
    d=v['departed_at'];c=(v['confirm_sec'] or 0)*1000
    return d+600000+c if strict else max(d+120000,d+c+15000,(v['first_moved_at'] or d)+c)


def distance(a,b):
    la1,la2=map(math.radians,(a['lat'],b['lat']))
    dla=la2-la1;dlo=math.radians(b['lon']-a['lon'])
    return 6371000*2*math.asin(min(1,math.sqrt(math.sin(dla/2)**2+math.cos(la1)*math.cos(la2)*math.sin(dlo/2)**2)))


def quality(v,raw):
    pin=v['pinned_at'];dep=v['departed_at']
    if pin is None or dep is None:return dict(rawAvailable=False,reason='no complete pinned interval')
    rs=[r for r in raw if pin-30000<=r['collected_at']<=dep+30000]
    qs=[r for r in rs if pin<=r['collected_at']<=dep]
    gaps=[(b['collected_at']-a['collected_at'])/1000 for a,b in zip(rs,rs[1:])]
    run=0;longest=0
    for a,b in zip(qs,qs[1:]):
        run=run+(b['collected_at']-a['collected_at'])/1000 if (a['lat'],a['lon'])==(b['lat'],b['lon']) else 0
        longest=max(longest,run)
    final = next((r for r in reversed(rs) if r['collected_at']<=dep),None)
    moved = next((r for r in rs if r['collected_at']>dep and final and distance(final,r)>15),None)
    inbound=[e for e in legs.values()if e['bus_name']==v['bus_name']and e['to_stop_id']==v['stop_id']and e['to_pinned_at']==pin]
    return dict(rawAvailable=bool(qs),rawRows=len(qs),maxGapSec=max(gaps,default=None),longestExactCoordinatePlateauSec=longest,
        minDistanceToStopM=min((distance(r,stops[v['stop_id']])for r in qs),default=None),
        firstFinalMovementAfterDepartureSec=(moved['collected_at']-dep)/1000 if moved else None,
        exactInboundLegIds=[e['id']for e in inbound],
        finalRaw=[dict(at=r['collected_at'],lat=r['lat'],lon=r['lon'])for r in rs if dep-15000<=r['collected_at']<=dep+20000])


cases=[]
for sid in CURRENT:
    source=visits[sid];pin=source['pinned_at'];bus=source['bus_name']
    prior=[v for v in visits.values()if v['bus_name']==bus and v['stop_id']==11 and known(v) is not None and known(v)<=pin and day(v['departed_at'])==day(pin)]
    prev=max(prior,key=lambda v:v['departed_at'])
    history=sorted([v for v in visits.values()if v['bus_name']==bus and prev['anchored_at']<=v['anchored_at']<=pin],key=lambda v:v['anchored_at'])
    raw={r['id']:dict(r)for r in db.execute('SELECT * FROM raw_positions WHERE bus_name=? AND collected_at BETWEEN ? AND ? ORDER BY collected_at',(bus,prev['pinned_at']-30000,source['departed_at']+30000))}
    raw.update({r['id']:r for r in fresh['raw_positions']if r['bus_name']==bus and prev['pinned_at']-30000<=r['collected_at']<=source['departed_at']+30000})
    raw=sorted(raw.values(),key=lambda r:r['collected_at'])
    rows=[]
    for v in history:
        hold=(v['departed_at']-v['pinned_at'])/1000 if v['departed_at'] is not None and v['pinned_at'] is not None else None
        rows.append(dict(visit=v,stopName=stops[v['stop_id']]['name'],pinnedHoldSec=hold,storedStandSec=v['stand_sec'],
                         durationQuarantined=v['id']in QUARANTINED_DURATION,
                         knownAtPin=known(v)is not None and known(v)<=pin,strictKnownAtPin=known(v,True)is not None and known(v,True)<=pin,
                         quality=quality(v,raw)))
    cases.append(dict(sourceId=sid,bus=bus,sourcePinET=dt.datetime.fromtimestamp(pin/1000,TZ).isoformat(),
                      priorSourceId=prev['id'],history=rows,
                      allObservedRouteIds=sorted({r['route_id']for r in raw}),providerBusIds=sorted({r['bus_id']for r in raw})))

def cedar_summary(stop):
    vs=[v for v in visits.values()if v['stop_id']==stop]
    return dict(stop=stop,name=stops[stop]['name'],visits=len(vs),outcomes=dict(collections.Counter(v['outcome']for v in vs)),
                gapCount=sum(v['how']=='gap'for v in vs),missingPin=sum(v['pinned_at']is None for v in vs),
                passedWithPositivePinnedSpan=sum(v['outcome']=='passed'and v['pinned_at']is not None and v['departed_at']is not None and v['departed_at']>v['pinned_at']for v in vs))

result=dict(method='Selected-case measurement audit, no fitting. Primary availability=max(departure+120s,departure+confirmSec+15s,firstMovedAt+confirmSec); strict sensitivity=departure+600s+confirmSec. These are proxies, not exact publication times. Selected examples are descriptive and cannot establish a driver rule.',
            redSequence=[dict(index=i,id=s,name=stops[s]['name'])for i,s in enumerate(seq)],
            cedarStopsOnRed=[s for s in seq if 'cedar'in stops[s]['name'].lower()],
            cedarNamesOffRed=[dict(id=s,name=v['name'])for s,v in stops.items()if 'cedar'in v['name'].lower()and s not in seq],
            cedarSummary=[cedar_summary(s)for s in (117,13)],cases=cases,
            data=dict(outcomesDB='release-integration-data/outcomes-complete.db',freshCapture='red-rest-history-2026-09-18/recordings.json',capturedAt=fresh['capturedAt']),
            limitations=['Bus name/provider ID are observed; driver identity and shift changes are not. No statement is a driver-level causal conclusion.',
                         'Pinned duration, plateau-based stand_sec, broader physical waiting and legacy dwell are different measurements.',
                         'Passed episodes may have positive pinned spans; these are not automatically discretionary breaks.',
                         'Quarantine65237 only affects its corrupted hold start/duration; final departure and outgoing leg remain valid.',
                         'A later dataset read is used only for labels; historical feature eligibility is explicitly checked against pin.'])
result['priorCedarTrainingSupport'] = []
for stop in (117,13):
    vs=[v for v in visits.values()if v['stop_id']==stop and known(v)is not None and known(v)<1789358400000]
    result['priorCedarTrainingSupport'].append(dict(stop=stop,completedSourceVisits=len(vs),stopped=sum(v['outcome']=='stopped'for v in vs),
        atLeast120s=[dict(id=v['id'],bus=v['bus_name'],standSec=v['stand_sec'],pinnedSec=(v['departed_at']-v['pinned_at'])/1000 if v['pinned_at']else None)
                     for v in vs if (v['stand_sec']or 0)>=120],
        caveat='Source-visit count, not necessarily eligible histories among the160 fitted focal holds.'))
result['additionalUnionFragments'] = []
for focal,old_id,new_id in ((25064,24861,24868),(60263,59983,60020)):
    old,new=visits[old_id],visits[new_id]
    rs=[dict(r)for r in db.execute('SELECT * FROM raw_positions WHERE bus_name=? AND collected_at BETWEEN ? AND ? ORDER BY collected_at',
                                  (new['bus_name'],old['anchored_at']-30000,new['departed_at']+60000))]
    runs=[]
    for r in rs:
        key=[r['bus_id'],r['route_id'],r['lat'],r['lon']]
        if runs and runs[-1]['key']==key:
            runs[-1]['end']=r['collected_at'];runs[-1]['n']+=1
        else:runs.append(dict(key=key,start=r['collected_at'],end=r['collected_at'],n=1))
    legacy=[dict(r)for r in db.execute('SELECT * FROM arrivals WHERE bus_name=? AND route_id=3 AND stop_id=121 AND arrived_at BETWEEN ? AND ? ORDER BY arrived_at',
                                      (new['bus_name'],old['anchored_at']-30000,new['departed_at']))]
    result['additionalUnionFragments'].append(dict(focalId=focal,old=old,new=new,rawRows=len(rs),coordinateRuns=runs,
        maxRawGapSec=max(((b['collected_at']-a['collected_at'])/1000 for a,b in zip(rs,rs[1:])),default=None),legacy=legacy,
        verdict='Confirmed incomplete prior duration: observed320s same-zone plateau precedes new fragment, no intervening lap.'if new_id==60020 else 'Uncertain/incomplete prior duration: provider ID change, earlier unresolved same-stop visit and unmatched older inbound pin; no local raw to reconstruct total.'))
cohort_path=OUT/'own-history/cohort.json'
if cohort_path.exists():
    cohort=json.loads(cohort_path.read_text());used=collections.defaultdict(list)
    for e in cohort:
        h=e['histories']['primary']['latest']['11']
        if h['duration']is not None:used[h['id']].append(e['id'])
    fragment_flags=[]
    for sid,fs in used.items():
        v=visits[sid]
        older=[w for w in visits.values()if w['bus_name']==v['bus_name']and w['stop_id']==11 and v['anchored_at']-1200000<=w['anchored_at']<v['anchored_at']and(w['departed_at']is None or w['how']=='gap')]
        for w in older:
            union=[u for u in visits.values()if u['bus_name']==v['bus_name']and u['stop_id']==121 and w['anchored_at']<u['anchored_at']<v['anchored_at']]
            if not union:fragment_flags.append(dict(priorSourceId=sid,focalIds=fs,earlierIncompleteId=w['id']))
    result['priorWinchesterCohortMetadataCheck']=dict(distinctUsedPriorDurations=len(used),flags=fragment_flags,
        rule='Flag a used prior Winchester duration if an earlier unresolved/gap Winchester anchor on that bus is within20min, without an intervening Union anchor. Metadata screen only; absence is not full raw validation.')
assert result['cedarStopsOnRed']==[117,13]
for c in cases:
    assert all(h['knownAtPin']for h in c['history']if h['visit']['id']!=c['sourceId'])
(OUT/'own-history-measurement-review.json').write_text(json.dumps(result,indent=2)+'\n')
for c in cases:
    print(c['sourceId'],c['bus'],c['sourcePinET'],'routes',c['allObservedRouteIds'],'ids',c['providerBusIds'])
    for h in c['history']:
        q=h['quality'];v=h['visit'];print(v['id'],v['stop_id'],v['outcome'],round(h['pinnedHoldSec'] or 0,1),'strict',h['strictKnownAtPin'],'raw',q.get('rawRows'),'gap',q.get('maxGapSec'),'plateau',q.get('longestExactCoordinatePlateauSec'),'inbound',q.get('exactInboundLegIds'))
db.close()
