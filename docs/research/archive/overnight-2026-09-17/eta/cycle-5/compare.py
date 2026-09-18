"""Paired current-production versus candidate; retrospective labels never enter replay."""
import collections,gzip,json,math,statistics,hashlib,subprocess
from pathlib import Path
O=Path(__file__).resolve().parent;B=O.parent/'cycle-4'
def load(p):return json.loads(p.read_text())
def frames(p):return {r['at']:r for r in map(json.loads,gzip.open(p/'fleet-wire.jsonl.gz','rt'))}
a=frames(B);b=frames(O);assert a.keys()==b.keys()
def rows(f):
 out={}
 for i,r in enumerate(f['server_eta']['rows']):
  key=(f['server_eta']['buses'][r[0]][0],r[1],r[5]);assert key not in out
  q=f['server_eta']['distributions'][i];assert len(q)==50 and q==sorted(q)
  assert r[3]<=r[2]<=r[4] and r[2]>=0 and all(math.isfinite(v) for v in r)
  out[key]={'eta':r[2],'low':max(0,r[3]),'high':r[4],'departNow':r[7],'lowFloor':r[8],'distribution':q,'row':r[1:]}
 return out
ar={at:rows(f) for at,f in a.items()};br={at:rows(f) for at,f in b.items()}
changed=[];zeros=collections.Counter();same=0
for at in a:
 assert a[at]['buses']==b[at]['buses'] and a[at]['warmMs']==b[at]['warmMs']
 assert sorted(a[at]['server_eta']['buses'])==sorted(b[at]['server_eta']['buses']) # served tracking/identity
 assert ar[at].keys()==br[at].keys() # both occurrences and availability
 for key,x in ar[at].items():
  y=br[at][key]
  assert x['departNow']==y['departNow'] and x['lowFloor']==y['lowFloor']
  if key[2]==0:
   zeros['total']+=1;zeros['baselinePositive']+=x['eta']>0;zeros['candidatePositive']+=y['eta']>0
   assert all(y[k]==0 for k in ['eta','low','high']) and all(v==0 for v in y['distribution'])
   if x['eta']>0:zeros[f'fixedStop{key[1]}']+=1
  if x!=y:changed.append(dict(at=at,bus=key[0],stop=key[1],hops=key[2],baseline=x,candidate=y))
  else:same+=1
prior=load(O.parent/'cycle-2/trace-scores.json');checks=[];outside=[]
for r in prior['checkpoints']:
 if r['at'] not in ar:outside.append(r);continue
 key=(next(c['bus'] for c in load(O.parent/'cycle-2/trace-outcomes.json')['cases'] if c['sourceId']==r['sourceId']).lstrip('#'),r['target'],r['current']['stopsAhead'])
 x=ar[r['at']][key];y=br[r['at']][key]
 for k in ['eta','low','high','departNow']:assert abs(x[k]-round(r['current'][k]))<=1
 rec={k:r[k] for k in ['sourceId','sourceStop','target','occurrence','targetVisitId','targetOutcome','phase','checkpointSec','at','truthSec']}
 rec.update(baseline=x,candidate=y,deltaAbsError=abs(y['eta']-r['truthSec'])-abs(x['eta']-r['truthSec']))
 checks.append(rec)
def metrics(rs,arm):
 if not rs:return {'n':0}
 es=sorted(abs(r[arm]['eta']-r['truthSec']) for r in rs)
 p=(len(es)-1)*.9;i=int(p)
 return dict(n=len(rs),sources=len({r['sourceId'] for r in rs}),targets=len({r['targetVisitId'] for r in rs}),mae=statistics.mean(es),medianAbs=statistics.median(es),p90Abs=es[i]+(es[min(i+1,len(es)-1)]-es[i])*(p-i),WIS=statistics.mean((.5*abs(r[arm]['eta']-r['truthSec'])+.1*(r[arm]['high']-r[arm]['low'])+max(0,r[arm]['low']-r['truthSec'])+max(0,r['truthSec']-r[arm]['high']))/1.5 for r in rs),width=statistics.mean(r[arm]['high']-r[arm]['low'] for r in rs),early=sum(r['truthSec']<r[arm]['low'] for r in rs),late=sum(r['truthSec']>r[arm]['high'] for r in rs))
groups={}
for key in sorted({(r['target'],r['occurrence'],r['phase']) for r in checks}):
 rs=[r for r in checks if (r['target'],r['occurrence'],r['phase'])==key]
 groups[str(key)]={arm:metrics(rs,arm) for arm in ['baseline','candidate']}
for key in sorted({(r['target'],r['occurrence'],r['targetOutcome']) for r in checks}):
 rs=[r for r in checks if (r['target'],r['occurrence'],r['targetOutcome'])==key]
 groups[str(key)]={arm:metrics(rs,arm) for arm in ['baseline','candidate']}
# Same physical endpoint/occurrence while first target still ahead; retain hop transitions.
jumps={}
for c in load(O.parent/'cycle-2/trace-outcomes.json')['cases']:
 for ep in c['endpoints']:
  first=next(e for e in c['endpoints'] if e['target']==ep['target'] and e['occurrence']==0)
  bus=c['bus'].lstrip('#');prev=None
  for at in sorted(a):
   if not c['source']['pinned_at']<=at<first['outcome']['arrived_at'] or c['sourceId'] not in a[at]['contexts']:continue
   def get(d):
    found=[v for (bn,s,h),v in d[at].items() if bn==bus and s==ep['target'] and (0<h<29 if ep['occurrence']==0 else 29<h<58)]
    assert len(found)<=1
    return found[0] if found else None
   x=get(ar);y=get(br)
   if x is None or y is None:prev=None;continue
   if prev and 0<at-prev[0]<=15000:
    dt=(at-prev[0])/1000;k=(bus,ep['outcome']['id'],at)
    jumps[k]=dict(bus=bus,targetVisitId=ep['outcome']['id'],target=ep['target'],occurrence=ep['occurrence'],at=at,baseline=dt+x['eta']-prev[1]['eta'],candidate=dt+y['eta']-prev[2]['eta'])
   prev=(at,x,y)
jumpSummary={str(o):{arm:dict(pairs=sum(j['occurrence']==o for j in jumps.values()),upGT60=sum(j['occurrence']==o and j[arm]>60 for j in jumps.values()),downLT60=sum(j['occurrence']==o and j[arm]<-60 for j in jumps.values())) for arm in ['baseline','candidate']} for o in [0,1]}
summary=dict(frames=len(a),rows=same+len(changed),unchangedRows=same,changedRows=len(changed),zeros=dict(zeros),selectedCheckpoints=len(checks),outsideFrozenWindows=len(outside),priorMissingForecasts=len(prior['missingForecasts']),unconnectedEndpoints=len(prior['unconnectedEndpoints']),groups=groups,jumpSummary=jumpSummary,scope='Selected reused historical Red windows, same continuous-prefix calibration and raw inputs, rounded production wire. No population, new holdout or calibrated coverage claim. Checkpoint selection reused cycle2; no outcome exclusion.')
(O/'comparison.json').write_text(json.dumps(dict(summary=summary,checkpoints=checks,largestRegressions=sorted(checks,key=lambda r:r['deltaAbsError'],reverse=True)[:10],largestImprovements=sorted(checks,key=lambda r:r['deltaAbsError'])[:10],changedRows=changed,jumps=list(jumps.values())),indent=2)+'\n')
print(json.dumps(summary,indent=2))
