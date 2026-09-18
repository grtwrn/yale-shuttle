"""Read-only record and observed-frame audit; never excludes by prediction error."""
import collections
import datetime as dt
import json
from pathlib import Path
import sqlite3

ROOT=Path('/home/gwarren/projects/yale-shuttle-watcher')
OUT=Path(__file__).resolve().parent
regressions=json.loads((OUT/'top-regressions.json').read_text())
selected=[r for r in regressions if r['regime']=='arrival15' and r['arm']=='plus_ahead_follower_snapshot' and r['comparator']=='current_code_component']
ids={r['id'] for r in regressions}
db=sqlite3.connect('file:'+str(ROOT/'conditional-replay-data/outcomes.db')+'?mode=ro',uri=True)
db.row_factory=sqlite3.Row
visits={i:dict(db.execute('SELECT * FROM stop_visits WHERE id=?',(i,)).fetchone()) for i in ids}
records=[]
for vid,v in sorted(visits.items()):
    legs=[dict(x) for x in db.execute('SELECT id,from_stop_id,to_stop_id,departed_at,arrived_at,to_pinned_at,leg_sec,hold_sec,drive_sec,hops FROM legs WHERE bus_name=? AND route_id=3 AND departed_at=? ORDER BY arrived_at',(v['bus_name'],v['departed_at']))]
    record={k:v[k] for k in ('id','bus_name','stop_id','anchored_at','pinned_at','departed_at','stand_sec','outcome','how','rest_polls','first_moved_at','last_at_rest_at','confirm_sec','closest_m','shuffles')}
    record.update(holdSec=(v['departed_at']-v['pinned_at'])/1000,anchorToPinSec=(v['pinned_at']-v['anchored_at'])/1000,
                  outgoingLegs=legs,decision='retain: no independently established error; completed-event evidence is not by itself new raw-GPS verification')
    assert v['outcome']=='stopped' and v['how']!='gap' and v['rest_polls']>0
    records.append(record)
db.close()
# Stream once, only observable bus telemetry; no rider IDs or feedback.
frames=collections.defaultdict(list)
for line in (ROOT/'conditional-replay-data/raw-frames.jsonl').open():
    f=json.loads(line);at=round(dt.datetime.fromisoformat(f['at'].replace('Z','+00:00')).timestamp()*1000)
    for r in selected:
        v=visits[r['id']]
        if not v['anchored_at']-180000<=at<=v['departed_at']+60000:continue
        for b in f['buses']:
            if b['bus_name']==v['bus_name'] and b['route_id']==3 and b.get('observed_at')==at:
                frames[v['id']].append(dict(at=at,**b))
raw=[]
for r in selected:
    v=visits[r['id']];fs=sorted({f['at']:f for f in frames[r['id']]}.values(),key=lambda f:f['at'])
    runs=[]
    for f in fs:
        if runs and (runs[-1]['lat'],runs[-1]['lon'])==(f['lat'],f['lon']):
            runs[-1]['end']=f['at'];runs[-1]['n']+=1
        else:runs.append(dict(start=f['at'],end=f['at'],lat=f['lat'],lon=f['lon'],n=1))
    pins=[f for f in fs if f.get('at_stop_id')==v['stop_id'] and f.get('at_stop_since')]
    during=[f for f in fs if v['pinned_at']<=f['at']<=v['departed_at']]
    gaps=[(b['at']-a['at'])/1000 for a,b in zip(fs,fs[1:])]
    after=[f for f in fs if f['at']>v['departed_at']]
    last=during[-1] if during else None
    movement=next((f for f in after if last and (f['lat'],f['lon'])!=(last['lat'],last['lon'])),None)
    raw.append(dict(id=r['id'],polls=len(fs),holdPolls=len(during),maxObservedGapSec=max(gaps) if gaps else None,
        firstReconstructedPinAt=pins[0]['at'] if pins else None,
        firstReconstructedPinLagSec=(pins[0]['at']-v['pinned_at'])/1000 if pins else None,
        pinClockStrings=sorted({f['at_stop_since'] for f in pins}),
        lastHoldObservedAt=last['at'] if last else None,
        firstChangedCoordinateAfterDepartureSec=(movement['at']-v['departed_at'])/1000 if movement else None,
        plateaus=[dict(x,seconds=(x['end']-x['start'])/1000) for x in runs if x['end']-x['start']>=10000],
        limitation='Collector fields are causally reconstructed by archive raw-feed.mts, not recovered first publication. Recorded GPS repeats are feed-deadband censoring, not proof of physical immobility. Empty observations mean archival coverage absent, never invalid outcome.'))
(OUT/'regression-record-audit.json').write_text(json.dumps(dict(completedRecords=records,primaryRawChecks=raw),indent=2)+'\n')
(OUT/'regression-observed-frames.jsonl').write_text(''.join(json.dumps(dict(sourceId=vid,**f))+'\n' for vid,fs in frames.items() for f in fs))
print(json.dumps(dict(completedRecords=len(records),primaryCases=len(selected),primaryWithRaw=sum(bool(x['polls']) for x in raw),retained=True),indent=2))
for r in raw:
    print(json.dumps({k:r[k] for k in ('id','polls','holdPolls','maxObservedGapSec','firstReconstructedPinLagSec','firstChangedCoordinateAfterDepartureSec')}))
