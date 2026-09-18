"""Exploratory diagnostics accompanying the fixed-checkpoint second-lap audit.
These static commitments are not a rider simulation: no updated decisions,
walking feasibility, capacity, notifications, or guaranteed door-open times.
"""
import collections,json,pathlib,sqlite3,statistics,math,bisect
D=pathlib.Path(__file__).resolve().parent
x=json.loads((D/'joint-next-occurrence-review.json').read_text())
c=sqlite3.connect('file:'+str(D/'outcomes.db')+'?mode=ro',uri=True);c.row_factory=sqlite3.Row
vis={r['id']:dict(r) for r in c.execute('select * from stop_visits where route_id=3')}
rs=[r for r in x['checkpoints'] if r['availability']=='paired']
misses={}
for label,fn in [('newEarly',lambda r:r['truthSec']>=r['baseline']['low'] and r['truthSec']<r['candidate']['low']),('newLate',lambda r:r['truthSec']<=r['baseline']['high'] and r['truthSec']>r['candidate']['high'])]:
 rr=[r for r in rs if fn(r)]
 misses[label]=dict(checkpoints=len(rr),targets=len({r['nextTargetId'] for r in rr}),sourceVisits=len({r['sourceId'] for r in rr}),rows=[{k:r[k] for k in ['sourceId','nextTargetId','sourceStop','target','targetOutcome','phase','checkpointSec','truthSec','baseline','candidate']}|dict(targetDwellSec=(vis[r['nextTargetId']]['departed_at']-vis[r['nextTargetId']]['arrived_at'])/1000 if vis[r['nextTargetId']]['departed_at'] else None) for r in rr])
policies=[('eta_minus_120s','eta',120),('low_minus_60s','low',60)]
policyRows=[]
for r in rs:
 t=vis[r['nextTargetId']]
 if t['outcome']!='stopped' or t['departed_at'] is None:continue
 for policy,field,buffer in policies:
  rr={k:r[k] for k in ['day','sourceId','nextTargetId','sourceStop','target','phase','checkpointSec']};rr['policy']=policy
  for a in ['baseline','candidate']:
   # Arrival-at-stop plan, not leave-origin time. Records with negative plans
   # would mean already at the stop; these second-occurrence plans are positive.
   plan=r['at']+max(0,r[a][field]-buffer)*1000
   rr[a]=dict(afterRecordedDeparture=plan>t['departed_at'],secondsAfter=(plan-t['departed_at'])/1000)
  policyRows.append(rr)
groups=collections.defaultdict(list)
for r in policyRows:groups[(r['sourceStop'],r['target'],r['phase'],r['checkpointSec'],r['policy'])].append(r)
policy=[]
for key,rr in sorted(groups.items()):
 policy.append(dict(key=key,n=len(rr),baselineAfterDeparture=sum(r['baseline']['afterRecordedDeparture'] for r in rr),candidateAfterDeparture=sum(r['candidate']['afterRecordedDeparture'] for r in rr),newlyAfterDeparture=sum(not r['baseline']['afterRecordedDeparture'] and r['candidate']['afterRecordedDeparture'] for r in rr),newlyBeforeDeparture=sum(r['baseline']['afterRecordedDeparture'] and not r['candidate']['afterRecordedDeparture'] for r in rr)))
# Full observed source-approach-to-first-arrival traces, labelled by their
# connected second physical target, never carrying across first-target arrival.
intervals=collections.defaultdict(list)
for j in x['journeys']:
 prior=[v['arrived_at'] for v in vis.values() if v['bus_name'].lstrip('#')==j['bus'] and v['stop_id']==j['target'] and v['arrived_at'] is not None and v['arrived_at']<j['firstArrival']]
 lower=max(j['pin']-120000,max(prior) if prior else -math.inf)
 intervals[(j['bus'],j['target'])].append((lower,j['firstArrival'],j['nextTargetId']))
traces=collections.defaultdict(dict)
for line in (D/'joint-release-pairs.jsonl').open():
 r=json.loads(line);at=r['at'];key=(r['bus'].lstrip('#'),r['target'])
 if r['stopsAhead']<=29 or r['warmMs']<600000 or at-r['observedAt']>=45000 or not r['baseline'] or not r['candidate']:continue
 ids={target for lo,hi,target in intervals[key] if lo<at<hi}
 assert len(ids)<=1,(key,at,ids)
 if ids:traces[(key[0],key[1],ids.pop())][at]=r
jumps=[]
for key,frames in traces.items():
 ordered=sorted(frames.items())
 for (pa,p),(at,r) in zip(ordered,ordered[1:]):
  if at-pa>15000 or r['segmentId']!=p['segmentId']:continue
  row=dict(bus=key[0],target=key[1],nextTargetId=key[2],at=at,deltaSec=(at-pa)/1000)
  for a in ['baseline','candidate']:
   row[a]={k:r[a][k]-p[a][k]+(at-pa)/1000 for k in ['eta','low','high']}
  jumps.append(row)
def jump_summary(rr,a):
 return dict(pairs=len(rr),targets=len({r['nextTargetId'] for r in rr}),up60=sum(r[a]['eta']>60 for r in rr),up180=sum(r[a]['eta']>180 for r in rr),down60=sum(r[a]['eta']< -60 for r in rr),down180=sum(r[a]['eta']< -180 for r in rr),targetsUp60=len({r['nextTargetId'] for r in rr if r[a]['eta']>60}),maxUpSec=max((r[a]['eta'] for r in rr),default=None),lowUp60=sum(r[a]['low']>60 for r in rr),highDown60=sum(r[a]['high']< -60 for r in rr))
summary={str(t):{a:jump_summary([r for r in jumps if r['target']==t],a) for a in ['baseline','candidate']} for t in [48,4]}
newjump=[r for r in jumps if r['candidate']['eta']>60 and r['baseline']['eta']<=60]
policyNew=[r for r in policyRows if not r['baseline']['afterRecordedDeparture'] and r['candidate']['afterRecordedDeparture']]
out=dict(method=__doc__,tailMisses=misses,policy=policy,newlyAfterDeparture=policyNew,pointJumps=summary,newUp60=sorted(newjump,key=lambda r:r['candidate']['eta'],reverse=True),policyCohort=dict(rows=len(policyRows),targetVisits=len({r['nextTargetId'] for r in policyRows}),dates=len({r['day'] for r in policyRows})))
(D/'joint-next-occurrence-tails.json').write_text(json.dumps(out,indent=2)+'\n')
print(json.dumps({k:v for k,v in out.items() if k not in ['tailMisses','policy','newUp60']},indent=2))
for g in policy:
 if g['key'][2:4] in [('standing',0),('departure',0)]:print(g)
print('newUp60',len(newjump), 'newlyAfter',len(policyNew))
