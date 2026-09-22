"""Hosted chronological evidence summary only; no prediction scoring."""
import collections
import datetime as dt
import gzip
import json
from pathlib import Path
from zoneinfo import ZoneInfo

OUT=Path(__file__).resolve().parent/'results'
def local(t):return dt.datetime.fromtimestamp(t/1000,ZoneInfo('America/New_York')).isoformat() if t is not None else None
with gzip.open(OUT/'trace.jsonl.gz','rt') as f:rows=[json.loads(x) for x in f]
cases=json.loads((OUT/'cases.json').read_text())
result={};timelines=[]
for case in cases:
 frames=[r for r in rows if r['case']==case['id'] and r['horizonSec']==5400]
 source,wait=case['source'],case['wait'];previous=None;origin=None;near_progress=phase_progress=0
 timeline=[];events=[];origin_epochs=[]
 for r in frames:
  s=r['state'] or {};v=r['visit'] or {};pas=v.get('pass') or {};transit=v.get('transit') or {}
  o=r['origins'].get(str(source));w=r['origins'].get(str(wait));changed_origin=bool(o and o['departed']!=origin)
  near,phase=s.get('nearestIndex',-1),r['index']
  if changed_origin:
   origin=o['departed'];near_progress=(near-source)%9 if near>=0 else None;phase_progress=(phase-source)%9 if phase>=0 else None
   origin_epochs.append(dict(departure=origin,departureET=local(origin),knownAt=o['knownAt'],knownAtET=local(o['knownAt']),firstTraceAt=r['at']))
  elif previous is not None and origin is not None:
   old=previous['state'] or {}
   if near>=0 and old.get('nearestIndex',-1)>=0 and near_progress is not None:near_progress+=(near-old['nearestIndex'])%9
   if phase>=0 and previous['index']>=0 and phase_progress is not None:phase_progress+=(phase-previous['index'])%9
  emissions=[dict(e,knownAt=r['at'],knownAtET=local(r['at']),arrivedAtET=local(e.get('arrivedAt')),departedAtET=local(e.get('departedAt')))
             for e in r['visitEvents']]
  events.extend(emissions)
  def token(x):
   state=x['state'] or {};visit=x['visit'] or {};p=visit.get('pass') or {}
   return (state.get('nearestIndex'),x['index'],x['phase'],state.get('stationaryStopId'),p.get('stopIndex'),p.get('pinnedAt'),p.get('arrivedAt'),
           tuple((str(k),z['departed']) for k,z in x['origins'].items()),tuple(x['releaseLatches'].items()))
  if previous is None or token(r)!=token(previous) or emissions:
   distances={d['index']:d['metres'] for d in r['distances'][0]}
   item=dict(case=case['id'],at=r['at'],atET=local(r['at']),provider=r['observations'][0]['busId'],route=r['observations'][0]['routeId'],
     lastStopId=r['observations'][0]['lastStopId'],lat=r['observations'][0]['lat'],lon=r['observations'][0]['lon'],
     nearest=near,phase=r['phase'],phaseIndex=phase,passIndex=pas.get('stopIndex'),passPinnedAt=pas.get('pinnedAt'),passArrivedAt=pas.get('arrivedAt'),
     passClosestM=pas.get('closestM'),transitFrom=transit.get('fromIndex'),transitDepartedAt=transit.get('departedAt'),
     source=o,sourceET=local(o['departed']) if o else None,wait=w,waitET=local(w['departed']) if w else None,
     releaseLatch=r['releaseLatches'].get(f'8/{wait}'),released=bool(o and r['releaseLatches'].get(f'8/{wait}')==o['departed']),
     sourceDistanceM=distances[source],waitDistanceM=distances[wait],
     diagnosticNearestAccumulation=near_progress,diagnosticPhaseAccumulation=phase_progress,
     modularSourceToPhase=(phase-source)%9 if phase>=0 else None,
     globalNearest=r['global'][0],aheadFromPrevious=r['aheadFromPrevious'][0],
     visitEvents=emissions,detectorEvents=r['detectorEvents'])
   timeline.append(item);timelines.append(item)
  previous=r
 source_events=[e for e in events if e['kind']=='visit' and e['stopIndex']==source]
 wait_events=[e for e in events if e['kind']=='visit' and e['stopIndex']==wait]
 result[case['id']]=dict(case=case,polls=len(frames),providers=sorted({r['observations'][0]['busId'] for r in frames}),
   routes=sorted({r['observations'][0]['routeId'] for r in frames}),contendedPolls=sum(r['contended'] for r in frames),
   maxObservedGapSec=max(((b['at']-a['at'])/1000 for a,b in zip(frames,frames[1:])),default=None),
   sourceEpochs=origin_epochs,sourceEmissions=source_events,waitEmissions=wait_events,timeline=timeline)
with gzip.open(OUT/'timeline.jsonl.gz','wt') as f:
 for r in timelines:f.write(json.dumps(r,separators=(',',':'))+'\n')
(OUT/'summary.json').write_text(json.dumps(result,indent=2)+'\n')
lines=['# Causal Brown source occurrence traces','','Diagnostic anchor/phase accumulation is NOT proof of physical forward motion. It changes no clock, guard, forecast, label or score. Full polls and reducer state are in trace.jsonl.gz.','']
for name,z in result.items():
 lines += [f'## {name}','',f"{z['polls']} polls; providers{z['providers']}; routes{z['routes']}; maximum gap{z['maxObservedGapSec']}s; contention{z['contendedPolls']}. Source emission epochs: {z['sourceEpochs']}",'',
 '| ET time | Nearest / phase | Pass / pinned | Diagnostic progress nearest / phase | Source / wait distance,m | Source release latch | Visit emissions |',
 '|---|---|---|---|---|---|---|']
 for r in z['timeline']:
  events='; '.join(f"{e['kind']} {e.get('stopIndex',str(e.get('fromIndex'))+'→'+str(e.get('toIndex')))} outcome={e.get('outcome')} arrival={e.get('arrivedAtET')} departure={e.get('departedAtET')} closest={e.get('closestM')}" for e in r['visitEvents'])
  lines.append(f"| {r['atET']} | {r['nearest']} /{r['phaseIndex']}{r['phase']} | {r['passIndex']} /{r['passPinnedAt'] is not None} | {r['diagnosticNearestAccumulation']} /{r['diagnosticPhaseAccumulation']} | {r['sourceDistanceM']:.1f} /{r['waitDistanceM']:.1f} | {r['released']} | {events} |")
(OUT/'REPORT.md').write_text('\n'.join(lines)+'\n')
print(json.dumps({k:{x:v[x] for x in ('polls','providers','routes','maxObservedGapSec','contendedPolls')} for k,v in result.items()}))
