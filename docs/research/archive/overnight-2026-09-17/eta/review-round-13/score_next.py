"""Read-only second-upcoming-arrival audit with exact one-lap outcome links.
The capture's occurrence field is always zero; second occurrence is inferred
from h>N only, at checkpoints before the first observed target arrival.
"""
import bisect,collections,datetime,hashlib,json,math,pathlib,sqlite3,statistics
from zoneinfo import ZoneInfo
D=pathlib.Path(__file__).resolve().parent;TZ=ZoneInfo('America/New_York');P=D/'full-pairs.jsonl'
db=sqlite3.connect('file:'+str(pathlib.Path('/home/gwarren/projects/yale-shuttle-watcher/release-integration-data/outcomes-complete.db'))+'?mode=ro',uri=True);db.row_factory=sqlite3.Row
seq=json.loads(db.execute('SELECT stops_json FROM routes WHERE id=3').fetchone()[0]);N=len(seq);assert N==29 and len(set(seq))==N
second={};meta={};rowCounts=collections.Counter();lo=math.inf;hi=0
for line in P.open():
 r=json.loads(line);at=r['at'];bus=r['bus'].lstrip('#');lo=min(lo,at);hi=max(hi,at);meta[(bus,at)]=r
 rowCounts['all']+=1
 if r['stopsAhead']==N:rowCounts['hEqualsN_ambiguous']+=1
 if r['stopsAhead']<=N:continue
 key=(bus,r['target'],at)
 assert key not in second,'Ambiguous second-occurrence row'
 second[key]=r;rowCounts['second']+=1
 for a in ['baseline','candidate']:
  if r[a]is None:rowCounts[a+'UnavailableSecondRows']+=1
# Raw recorded frame clock: choose first eligible observed frame, regardless of
# whether one/both arms emitted a second-occurrence forecast there.
frames=[];freshAt=collections.defaultdict(list)
for line in(pathlib.Path('/home/gwarren/projects/yale-shuttle-watcher/release-integration-data/raw-complete-frames.jsonl')).open():
 f=json.loads(line);at=round(datetime.datetime.fromisoformat(f['at'].replace('Z','+00:00')).timestamp()*1000)
 if not lo<=at<=hi:continue
 frames.append(at)
 for b in f['buses']:
  if b.get('observed_at')==at:freshAt[b['bus_name'].lstrip('#')].append(at)
frames=sorted(set(frames));visits=[dict(r)for r in db.execute('SELECT * FROM stop_visits WHERE route_id=3 AND anchored_at BETWEEN ? AND ? ORDER BY anchored_at',(lo-7200000,hi+10800000))]
legs=[dict(r)for r in db.execute('SELECT * FROM legs WHERE route_id=3 AND departed_at BETWEEN ? AND ?',(lo-7200000,hi+10800000))]
byLeg=collections.defaultdict(list);byVisit=collections.defaultdict(list);byTarget=collections.defaultdict(list)
for l in legs:byLeg[(l['bus_name'],l['from_index'],l['departed_at'])].append(l)
for v in visits:
 if v['arrived_at']is not None:byVisit[(v['bus_name'],v['stop_id'],v['stop_index'],v['arrived_at'])].append(v)
 if v['outcome']=='passed'and v['departed_at']is not None and v['departed_at']!=v['arrived_at']:byVisit[(v['bus_name'],v['stop_id'],v['stop_index'],v['departed_at'])].append(v)
 if v['stop_id']in[48,4]and v['arrived_at']is not None:byTarget[(v['bus_name'],v['stop_id'])].append(v)
for vs in byTarget.values():vs.sort(key=lambda v:v['arrived_at'])
def day(t):return datetime.datetime.fromtimestamp(t/1000,TZ).date().isoformat()
def connect(s,target,fullLap=False):
 if s['departed_at']is None:return None,'source lacks departure'
 index=s['stop_index'];dep=s['departed_at'];remaining=(seq.index(target)-index)%N
 if remaining==0:
  if not fullLap:return None,'same source occurrence'
  remaining=N
 total=0;path=[]
 for _ in range(N):
  ls=byLeg[(s['bus_name'],index,dep)]
  if len(ls)!=1:return None,'missing or ambiguous leg'
  l=ls[0]
  if not(l['reached']==1 and l['from_stop_id']==seq[index]and l['to_stop_id']==seq[l['to_index']]and l['arrived_at']>dep and 1<=l['hops']<=remaining and(l['to_index']-index)%N==l['hops']):return None,'invalid route/time or skipped target'
  vs=byVisit[(s['bus_name'],l['to_stop_id'],l['to_index'],l['arrived_at'])]
  vs=[v for v in vs if s['anchored_at']<=v['anchored_at']<=l['arrived_at']]
  if len(vs)!=1:return None,'missing or ambiguous visit'
  v=vs[0];path.append((l,v));remaining-=l['hops'];total+=l['hops']
  if v['how']=='gap':return None,'gap-resolved visit'
  if remaining==0:
   if v['stop_id']!=target or v['arrived_at']is None or v['outcome']not in['stopped','passed']or v['closest_m']is None or v['closest_m']>75:return None,'unsupported target'
   if fullLap:assert total==N
   return path,None
  if v['departed_at']is None or v['departed_at']<l['arrived_at']:return None,'missing intermediate departure'
  index=l['to_index'];dep=v['departed_at']
 return None,'uncompleted ring'
def q(xs,p):
 xs=sorted(xs);i=(len(xs)-1)*p;l=math.floor(i);return xs[l]+(xs[math.ceil(i)]-xs[l])*(i-l)
def metric(rs,a):
 rs=[r for r in rs if r.get(a)is not None]
 if not rs:return {'n':0}
 e=[r[a]['eta']-r['truthSec']for r in rs];ae=list(map(abs,e));w=[r[a]['high']-r[a]['low']for r in rs]
 early=[r['truthSec']<r[a]['low']for r in rs];late=[r['truthSec']>r[a]['high']for r in rs]
 wis=[(.5*abs(r[a]['eta']-r['truthSec'])+.1*(r[a]['high']-r[a]['low'])+max(0,r[a]['low']-r['truthSec'])+max(0,r['truthSec']-r[a]['high']))/1.5 for r in rs]
 return dict(n=len(rs),sourceVisits=len({r['sourceId']for r in rs}),targetVisits=len({r['nextTargetId']for r in rs}),dates=len({r['day']for r in rs}),maeSec=statistics.mean(ae),medianAbsSec=statistics.median(ae),p90AbsSec=q(ae,.9),signedSec=statistics.mean(e),widthSec=statistics.mean(w),WIS=statistics.mean(wis),early=sum(early),late=sum(late),covered=len(rs)-sum(early)-sum(late),over120=sum(x>120 for x in e),under120=sum(x< -120 for x in e),over300=sum(x>300 for x in e),under300=sum(x< -300 for x in e))
source=[v for v in visits if v['stop_id']in[11,121]and v['outcome']=='stopped'and v['how']!='gap'and v['pinned_at']is not None and v['departed_at']is not None and v['pinned_at']<=hi and v['departed_at']>=lo]
status=collections.Counter();journeys=[];checks=[]
for s in source:
 for target in[48,4]:
  path,err=connect(s,target)
  if err:status['first: '+err]+=1;continue
  first=path[-1][1];later=[v for v in byTarget[(s['bus_name'],target)]if first['arrived_at']<v['arrived_at']and day(v['arrived_at'])==day(s['pinned_at'])]
  if not later:status['next target absent: right-censored or service-ended']+=1;continue
  secondPath,err=connect(first,target,True)
  if err:status['next: '+err]+=1;continue
  secondTarget=secondPath[-1][1]
  if secondTarget['id']!=later[0]['id']:status['connected target skips earlier observed target']+=1;continue
  assert day(secondTarget['arrived_at'])==day(s['pinned_at'])
  bus=s['bus_name'].lstrip('#');jid=f"{s['id']}:{first['id']}:{secondTarget['id']}";j=dict(journeyId=jid,sourceId=s['id'],sourceStop=s['stop_id'],firstTargetId=first['id'],nextTargetId=secondTarget['id'],target=target,bus=bus,day=day(s['pinned_at']),pin=s['pinned_at'],departure=s['departed_at'],firstArrival=first['arrived_at'],nextArrival=secondTarget['arrived_at'],targetOutcome=secondTarget['outcome'],legIds=[l['id']for l,v in path+secondPath])
  journeys.append(j);prev=[v['arrived_at']for v in byTarget[(s['bus_name'],target)]if v['arrived_at']<first['arrived_at']];prev=max(prev)if prev else -math.inf
  clocks=[('approach',e,s['pinned_at']+e*1000)for e in[-120,-60]]+[('standing',e,s['pinned_at']+e*1000)for e in[0,60,180,300,420,600]if s['pinned_at']+e*1000<s['departed_at']]+[('departure',e,s['departed_at']+e*1000)for e in[0,5,15,30,60]]
  for phase,e,t in clocks:
   if not prev<t<first['arrived_at']:continue
   i=bisect.bisect_left(frames,t)
   if i==len(frames)or frames[i]>t+15000:status['checkpoint missing frame']+=1;continue
   at=frames[i]
   if at>=first['arrived_at']or(phase=='standing'and at>=s['departed_at'])or(phase=='approach'and at>=s['pinned_at']):continue
   m=meta.get((bus,at))
   if not m or m.get('warmMs',0)<600000 or at-m.get('observedAt',at)>=45000:status['checkpoint unavailable/stale/unwarmed bus']+=1;continue
   r=second.get((bus,target,at));rec=dict(j,at=at,phase=phase,checkpointSec=e,truthSec=(secondTarget['arrived_at']-at)/1000,baseline=None,candidate=None,stopsAhead=r['stopsAhead']if r else None)
   for a in['baseline','candidate']:
    if r and r[a]is not None:rec[a]={k:max(0,r[a][k])for k in['eta','low','high']}
   # All checkpoint values are retained, including a missing baseline or both.
   rec['availability']='paired'if rec['baseline']and rec['candidate']else'candidate_only'if rec['candidate']else'baseline_only'if rec['baseline']else'both_absent'
   checks.append(rec)
groups=collections.defaultdict(list)
for r in checks:groups[(r['sourceStop'],r['target'],r['phase'],r['checkpointSec'])].append(r)
scores=[]
for key,rs in sorted(groups.items()):
 paired=[r for r in rs if r['availability']=='paired']
 scores.append(dict(key=key,availability=dict(collections.Counter(r['availability']for r in rs)),paired={a:metric(paired,a)for a in['baseline','candidate']},stoppedTargetsOnly={a:metric([r for r in paired if r['targetOutcome']=='stopped'],a)for a in['baseline','candidate']},candidateOnly=metric([r for r in rs if r['availability']=='candidate_only'],'candidate'),byDate={date:{a:metric([r for r in paired if r['day']==date],a)for a in['baseline','candidate']}for date in sorted({r['day']for r in rs})}))
paired=[r for r in checks if r['availability']=='paired'];new=[r for r in checks if r['availability']=='candidate_only']
out=dict(method='Retrospective exact connected first-target then one-full-lap second-target outcomes. Fixed raw observation checkpoints before first arrival; second rows inferred by stopsAhead>N because capture occurrence=0 is not usable. Same-day complete chains only; absence is retained separately. Not calibrated or independent repeated-checkpoint evidence.',input=dict(pairs=str(P),sha256=hashlib.sha256(P.read_bytes()).hexdigest(),minWarmSec=600,N=N),counts=dict(rows=rowCounts,sourceVisits=len(source),connectedJourneys=len(journeys),checkpoints=len(checks),scoredSources=len({r['sourceId']for r in paired}),scoredNextTargets=len({r['nextTargetId']for r in paired}),availability=dict(collections.Counter(r['availability']for r in checks)),excluded=dict(status)),scores=scores,journeys=journeys,checkpoints=checks,candidateOnly=metric(new,'candidate'),largestPairedRegressions=sorted(paired,key=lambda r:abs(r['candidate']['eta']-r['truthSec'])-abs(r['baseline']['eta']-r['truthSec']),reverse=True)[:12])
(D/'full-next-occurrence-review.json').write_text(json.dumps(out,indent=2)+'\n');print(json.dumps({'counts':out['counts'],'candidateOnly':out['candidateOnly']},indent=2));db.close()
