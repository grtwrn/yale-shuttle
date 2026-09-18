"""Recorded-coordinate audit for new intermediate-stop contrasts; no exclusion rule."""
import datetime
import json
import math
from pathlib import Path

OUT=Path(__file__).resolve().parent
ROOT=Path('/home/gwarren/projects/yale-shuttle-watcher')
labels=json.loads((OUT/'trace-outcomes.json').read_text())
selected=[]
for c in labels['cases']:
    if c['sourceStop']!=121:continue
    path=next(e['path'] for e in c['endpoints'] if e['target']==11)
    for p in path:
        if p['visit']['stop_id'] in [115,75]:selected.append((c['sourceId'],p['visit']))
assert len(selected)==10
samples={v['id']:[] for _,v in selected}
for line in (ROOT/'conditional-replay-data/raw-frames.jsonl').open():
    f=json.loads(line)
    at=round(datetime.datetime.fromisoformat(f['at'].replace('Z','+00:00')).timestamp()*1000)
    for _,v in selected:
        if not v['anchored_at']-60000<=at<=v['departed_at']+60000:continue
        bs=[b for b in f['buses'] if b['bus_name']==v['bus_name'] and b['route_id']==3 and b.get('observed_at')==at]
        assert len(bs)<=1
        if bs:samples[v['id']].append(dict(at=at,lat=bs[0]['lat'],lon=bs[0]['lon']))

def metres(a,b):
    rad=math.pi/180
    x=(b['lon']-a['lon'])*rad*math.cos((a['lat']+b['lat'])*rad/2)
    y=(b['lat']-a['lat'])*rad
    return 6371000*math.hypot(x,y)

results=[]
for source,v in selected:
    rows=samples[v['id']]
    assert rows and rows[0]['at']<=v['anchored_at'] and rows[-1]['at']>=v['departed_at']+30000
    gaps=[(b['at']-a['at'])/1000 for a,b in zip(rows,rows[1:])]
    assert all(g>0 for g in gaps)
    runs=[]
    for row in rows:
        if not runs or (row['lat'],row['lon'])!=(runs[-1]['lat'],runs[-1]['lon']):
            runs.append(dict(start=row['at'],end=row['at'],lat=row['lat'],lon=row['lon'],count=1))
        else:runs[-1]['end']=row['at'];runs[-1]['count']+=1
    in_visit=[dict(start=max(r['start'],v['anchored_at']),end=min(r['end'],v['departed_at']),count=r['count'])
              for r in runs if r['end']>=v['anchored_at'] and r['start']<=v['departed_at']]
    longest=max(in_visit,key=lambda r:r['end']-r['start'])
    departure=[r for r in rows if r['at']==v['departed_at']]
    assert len(departure)==1
    changed=next((r for r in rows if r['at']>v['departed_at'] and metres(departure[0],r)>.01),None)
    assert changed
    record=dict(sourceId=source,visitId=v['id'],stopId=v['stop_id'],outcome=v['outcome'],how=v['how'],
        rows=len(rows),maxObservedGapSec=max(gaps),anchorToPinSec=(v['pinned_at']-v['anchored_at'])/1000,
        arrivalToDepartureSec=(v['departed_at']-v['arrived_at'])/1000,
        longestIdenticalCoordinateRunSec=(longest['end']-longest['start'])/1000,
        identicalRun=longest,coordinateChangeAfterDepartureSec=(changed['at']-v['departed_at'])/1000,
        coordinateChangeMetres=metres(departure[0],changed),
        interpretation='Repeated GPS is deadband-censored movement, not proof of doors open or exact physical stand. No new measurement-error evidence or exclusion.')
    results.append(record)
(OUT/'intermediate-raw-audit.json').write_text(json.dumps(dict(scope='Ten selected intermediate visits; actual recorded coordinates only, no first-published collector-clock claim.',cases=results),indent=2)+'\n')
print(json.dumps(results,indent=2))
