from pathlib import Path
import json,sqlite3,collections,bisect,statistics,math
O=Path(__file__).resolve().parent;A=Path('/home/gwarren/projects/yale-shuttle-watcher')
db=sqlite3.connect('file:'+str(A/'release-integration-data/outcomes-complete.db')+'?mode=ro',uri=True);db.row_factory=sqlite3.Row
rows=collections.defaultdict(list)
for r in map(json.loads,(O/'full-pairs.jsonl').open()):
 if r['warmMs']>=600000 and r['baseline'] is not None and r['candidate'] is not None:rows[(r['bus'].lstrip('#'),r['target'],int(r['stopsAhead']>29))].append(r)
for rs in rows.values():rs.sort(key=lambda r:r['at'])
indices={k:[r['at'] for r in rs] for k,rs in rows.items()}
visits=collections.defaultdict(list)
for r in db.execute('select bus_name,stop_id,arrived_at from stop_visits where route_id=3 and stop_id in (48,4) and arrived_at is not null order by arrived_at'):visits[(r['bus_name'].lstrip('#'),r['stop_id'])].append(r['arrived_at'])
unique={};contexts=0
for name in ['full-development-score','full-reused-afternoon-score','full-next-occurrence-review']:
 x=json.loads((O/(name+'.json')).read_text());second='next-occurrence' in name
 for j in x['journeys']:
  first=j['firstArrival'] if second else j['targetArrivedAt'];arrival=j['nextArrival'] if second else first;pin=j['pin'] if second else j['pinnedAt'];bus=j['bus'];target=j['target'];vid=j['nextTargetId'] if second else j['targetVisitId'];times=visits[(bus,target)];i=bisect.bisect_left(times,first);prev=times[i-1] if i else -math.inf
  k=bus,target,int(second);ts=indices.get(k,[]);rs=rows.get(k,[]);start=bisect.bisect_right(ts,max(pin-600000,prev));end=bisect.bisect_left(ts,first)
  for r in rs[start:end]:
   key=bus,vid,r['at'],int(second);contexts+=1
   truth=(arrival-r['at'])/1000
   if key in unique:assert unique[key]['truthSec']==truth;unique[key]['sourceIds'].add(j['sourceId']);continue
   unique[key]={'bus':bus,'targetId':vid,'at':r['at'],'target':target,'occurrence':int(second),'sourceIds':{j['sourceId']},'truthSec':truth,'baseline':{c:max(0,v) for c,v in r['baseline'].items()},'candidate':{c:max(0,v) for c,v in r['candidate'].items()},'rawBaseline':r['baseline'],'rawCandidate':r['candidate']}
def q(xs,p):
 xs=sorted(xs);i=(len(xs)-1)*p;lo=math.floor(i);return xs[lo]+(xs[math.ceil(i)]-xs[lo])*(i-lo)
def metric(rs,a):
 ae=[abs(r[a]['eta']-r['truthSec']) for r in rs]
 return {'n':len(rs),'targets':len({r['targetId'] for r in rs}),'MAE':statistics.mean(ae),'p90':q(ae,.9),'WIS':statistics.mean((.5*abs(r[a]['eta']-r['truthSec'])+.1*(r[a]['high']-r[a]['low'])+max(0,r[a]['low']-r['truthSec'])+max(0,r['truthSec']-r[a]['high']))/1.5 for r in rs),'width':statistics.mean(r[a]['high']-r[a]['low'] for r in rs),'early':sum(r['truthSec']<r[a]['low'] for r in rs),'late':sum(r['truthSec']>r[a]['high'] for r in rs)}
summary={'method':'Supplemental all-poll connected trajectories using the same source/target chains and source-pin-minus600/previous-target lower limit as the checkpoint scorer. Second forecasts only before first target. Deduplicate shared source contexts by bus,target-visit,poll,occurrence. Unequal repeated-poll weighting; descriptive, not independent trips or substitute for fixed checkpoints. Same adapter zero clipping; raw retained.','sourceContexts':contexts,'uniquePollTargets':len(unique),'metrics':{},'boundStatusFlips':{}}
large=[]
for occ in [0,1]:
 rs=[r for r in unique.values() if r['occurrence']==occ];summary['metrics'][occ]={a:metric(rs,a) for a in ['baseline','candidate']};flips=collections.Counter()
 for r in rs:
  r['sourceIds']=sorted(r['sourceIds']);r['maxBandDelta']=max(abs(r['baseline'][c]-r['candidate'][c]) for c in ['eta','low','high']);r['absErrorIncrease']=abs(r['candidate']['eta']-r['truthSec'])-abs(r['baseline']['eta']-r['truthSec'])
  for tail,fn in [('early',lambda p:r['truthSec']<p['low']),('late',lambda p:r['truthSec']>p['high'])]:
   a,b=fn(r['baseline']),fn(r['candidate'])
   if a!=b:flips[tail+('_introduced' if b else '_resolved')]+=1
  if r['maxBandDelta']>60:large.append(r)
 summary['boundStatusFlips'][occ]=flips
summary['bandChangesOver60']=len(large);summary['largestBandChanges']=sorted(large,key=lambda r:r['maxBandDelta'],reverse=True)[:20];summary['largestPointRegressions']=sorted(unique.values(),key=lambda r:r['absErrorIncrease'],reverse=True)[:20]
(O/'longitudinal.json').write_text(json.dumps(summary,indent=2)+'\n');(O/'connected-tail-changes.json').write_text(json.dumps(large,indent=2)+'\n');db.close();print(json.dumps({k:v for k,v in summary.items() if not k.startswith('largest')},indent=2))
