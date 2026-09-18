from pathlib import Path
import json,gzip,sqlite3,collections,bisect,statistics,math,datetime,heapq
from zoneinfo import ZoneInfo
O=Path(__file__).resolve().parent;A=O.parents[2]
db=sqlite3.connect('file:'+str(A/'release-integration-data/outcomes-complete.db')+'?mode=ro',uri=True);db.row_factory=sqlite3.Row
meta=json.loads((O/'current-meta.json').read_text());top={int(k):v['stops'] for k,v in meta['routeMeta'].items()}
visits={};bybus=collections.defaultdict(list);toVisit=collections.defaultdict(list)
for raw in db.execute('select * from stop_visits order by anchored_at,id'):
 v=dict(raw);visits[v['id']]=v;bybus[(v['route_id'],v['bus_name'].lstrip('#'))].append(v)
 if v['arrived_at'] is not None:toVisit[(v['route_id'],v['bus_name'].lstrip('#'),v['stop_index'],v['arrived_at'])].append(v)
 elif v['outcome']=='passed' and v['departed_at'] is not None:toVisit[(v['route_id'],v['bus_name'].lstrip('#'),v['stop_index'],v['departed_at'])].append(v)
times={k:[v['anchored_at'] for v in vs] for k,vs in bybus.items()};legs=collections.defaultdict(list)
for raw in db.execute('select * from legs'):
 l=dict(raw);legs[(l['route_id'],l['bus_name'].lstrip('#'),l['from_index'],l['departed_at'])].append(l)
db.close();chainCache={};chainChecks=0;edgeChecks=set();chainReasons=collections.Counter()
def chain(source):
 global chainChecks
 if source['id'] in chainCache:return chainCache[source['id']]
 route=source['route_id'];seq=top[route];N=len(seq);vs=[source];ls=[];hops=0;cur=source;reason='two-laps-complete'
 for _ in range(2*N+2):
  if cur['how']=='gap' or cur['departed_at'] is None:reason='gap-or-no-departure';break
  possible=legs.get((route,cur['bus_name'].lstrip('#'),cur['stop_index'],cur['departed_at']),[])
  if len(possible)!=1:reason='missing-or-ambiguous-leg';break
  l=possible[0];idx=l['to_index']
  if not l['reached'] or l['hops']<=0 or idx>=N or cur['stop_index']>=N:reason='unreached-or-invalid-leg';break
  if seq[cur['stop_index']]!=l['from_stop_id'] or seq[idx]!=l['to_stop_id'] or (idx-cur['stop_index'])%N!=l['hops']:reason='sequence-mismatch';break
  vs2=[v for v in toVisit.get((route,cur['bus_name'].lstrip('#'),idx,l['arrived_at']),[]) if cur['anchored_at']<=v['anchored_at']<=l['arrived_at'] and v['how']!='gap' and v['id']!=cur['id']]
  if len(vs2)!=1:reason='missing-or-ambiguous-visit';break
  cur=vs2[0];vs.append(cur);ls.append(l['id']);hops+=l['hops'];edgeChecks.add(l['id'])
  if hops>=2*N:break
 chainChecks+=1;chainReasons[reason]+=1;chainCache[source['id']]=(vs,ls,reason);return vs,ls,reason

def keyed(f):
 result={};unknown=[]
 if not f['wire']:return result,unknown
 rows=collections.defaultdict(list);byVehicle=collections.defaultdict(list)
 for row in f['wire']['rows']:byVehicle[row[0]].append(row)
 for bi,vehicleRows in byVehicle.items():
  b=f['wire']['buses'][bi];key=b[1]+'|'+b[0];t=f['tracking'].get(key)
  if not t:
   unknown.extend([[b,row,'no-tracking'] for row in vehicleRows]);continue
  seq=top[t[0]];N=len(seq)
  # startChain can move its priced leg from the belief's leg to a standing or
  # repositioning stop. Infer the unique chain origin from ALL served hops.
  origins=[j for j in range(N) if all(seq[(j+row[5])%N]==row[1] for row in vehicleRows)]
  if len(origins)!=1:
   unknown.extend([[b,row,'ambiguous-price-origin'] for row in vehicleRows]);continue
  for row in vehicleRows:
   idx=(origins[0]+row[5])%N
   rows[(t[0],b[0],idx)].append((row,t))
 for key,rr in rows.items():
  for occ,(row,t) in enumerate(sorted(rr,key=lambda x:x[0][5])):
   assert occ<2,(key,rr)
   result[key+(occ,)]=(row,t)
 return result,unknown

def q(xs,p):
 xs=sorted(xs);i=(len(xs)-1)*p;lo=math.floor(i);return xs[lo]+(xs[math.ceil(i)]-xs[lo])*(i-lo)
metrics=collections.defaultdict(lambda: {'current':[],'canonical':[],'source':set(),'target':set()});counts=collections.Counter();availability=collections.Counter();flips=collections.Counter();stability=collections.Counter();previous={};unpairedFile=(O/'unpaired-arrivals.jsonl').open('w');trackingFile=(O/'tracking-changes.jsonl').open('w');tailFile=(O/'large-tail-changes.jsonl').open('w');scoredFile=(O/'connected-pairs.jsonl').open('w');worst=[];progress=collections.Counter();lastTrack={};sampleCases=[];identityFile=(O/'unresolved-source-identities.jsonl').open('w')
for aa,bb in zip(gzip.open(O/'current-wire.jsonl.gz','rt'),gzip.open(O/'canonical-wire.jsonl.gz','rt'),strict=True):
 a,b=json.loads(aa),json.loads(bb);assert(a['i'],a['at'],a['sample'])==(b['i'],b['at'],b['sample']);at=a['at'];counts['polls']+=1;ka,ua=keyed(a);kb,ub=keyed(b);counts['currentIndexUnresolved']+=len(ua);counts['canonicalIndexUnresolved']+=len(ub);counts['currentRows']+=len(ka);counts['canonicalRows']+=len(kb)
 for k in a['tracking'].keys()|b['tracking'].keys():
  if a['tracking'].get(k)!=b['tracking'].get(k):trackingFile.write(json.dumps({'at':at,'key':k,'current':a['tracking'].get(k),'canonical':b['tracking'].get(k)})+'\n')
 for label,f in [('current',a),('canonical',b)]:
  for k,t in f['tracking'].items():
   prev=lastTrack.get((label,k));N=len(top[t[0]])
   if prev and at-prev[0]<=15000:
    d=(t[1]-prev[1])%N
    if d>N/2:progress[label+'BackwardNumericalLead']+=1
   lastTrack[(label,k)]=(at,t[1])
 for key in ka.keys()|kb.keys():
  route,bus,idx,occ=key;ra,ta=ka.get(key,(None,None));rb,tb=kb.get(key,(None,None));availability[str(route)+':'+('paired' if ra and rb else 'current-only' if ra else 'canonical-only')]+=1
  for arm,r,t in [('current',ra,ta),('canonical',rb,tb)]:
   if r:
    if r[3]<0:counts[arm+'NegativeLow']+=1
    prev=previous.get((arm,key));absolute=at/1000+r[2]
    if prev and at-prev[0]<=15000 and r[5]<=prev[2] and math.ceil(r[5]/len(top[route]))==math.ceil(prev[2]/len(top[route])):
     delta=absolute-prev[1]
     if abs(delta)>60:stability[f'{route}:{arm}:'+('up' if delta>0 else 'down')]+=1
    previous[(arm,key)]=(at,absolute,r[5])
  if not ra or not rb:
   unpairedFile.write(json.dumps({'at':at,'key':key,'current':ra,'canonical':rb,'currentTracking':ta,'canonicalTracking':tb})+'\n');continue
  if ra[1:]!=rb[1:]:counts['changedRows']+=1
  band=max(abs(ra[j]-rb[j]) for j in [2,3,4]);truth=None;source=None;target=None;legIds=[];reason='unsampled'
  if a['sample'] or band>60:
   times0=times.get((route,bus),[]);si=bisect.bisect_right(times0,at)-1
   if si<0:reason='no-source'
   else:
    source=bybus[(route,bus)][si];vs,ls,reason=chain(source)
    # Identity is determined separately per arm. A zero-hop source row stays
    # current after recorded departure; a full-lap row is the next return.
    # Positive sub-lap source rows lack enough evidence for current-vs-next.
    matched=[]
    for arm,kk in [('current',ka),('canonical',kb)]:
     first=kk.get((route,bus,idx,0));firstHop=first[0][5] if first else None
     sameSource=source['stop_index']==idx
     if sameSource and firstHop is not None and 0<firstHop<len(top[route]):
      matched.append(None);continue
     keepSource=sameSource and firstHop==0
     eligible=[(i,v) for i,v in enumerate(vs) if v['stop_index']==idx and (i>0 or keepSource)]
     matched.append(eligible[occ] if len(eligible)>occ else None)
    if all(x is not None for x in matched) and matched[0][1]['id']==matched[1][1]['id']:
     ti,target=matched[0];arrival=target['arrived_at'] if target['arrived_at'] is not None else target['departed_at'];legIds=ls[:ti]
     if arrival is not None:truth=(arrival-at)/1000;reason='connected' if ti else 'current-source-transition'
    elif source['stop_index']==idx:
     reason='source-target-identity-unresolved'
     identityFile.write(json.dumps({'at':at,'key':key,'sourceId':source['id'],'firstHops':[ka.get((route,bus,idx,0),(None,None))[0][5] if (route,bus,idx,0) in ka else None,kb.get((route,bus,idx,0),(None,None))[0][5] if (route,bus,idx,0) in kb else None],'possibleTargetIds':[x[1]['id'] if x else None for x in matched],'chainVisitIds':[v['id'] for v in vs if v['stop_index']==idx]})+'\n')
  record={'at':at,'poll':a['i'],'route':route,'bus':bus,'targetIndex':idx,'targetStop':top[route][idx],'occurrence':occ,'sourceId':source['id'] if source else None,'targetId':target['id'] if target else None,'legIds':legIds,'truthSec':truth,'current':ra[2:6],'canonical':rb[2:6],'maxBandDelta':band,'reason':reason}
  if band>60:tailFile.write(json.dumps(record)+'\n');counts['largeBandChanges']+=1
  if not a['sample']:continue
  counts['minutePairedRows']+=1
  if min(ta[5],tb[5])<600000:counts['unscoredWarmup']+=1;continue
  if truth is None:counts['unscored:'+reason]+=1;continue
  if truth<0:counts['postArrivalTransition']+=1;continue
  if not legIds:counts['noConnectedLeg']+=1;continue
  counts['scored']+=1;scoredFile.write(json.dumps(record)+'\n');date=datetime.datetime.fromtimestamp(at/1000,ZoneInfo('America/New_York')).date().isoformat();outcome=target['outcome'];groups=['all',f'route:{route}',f'route:{route}:occ:{occ}',f'route:{route}:date:{date}',f'outcome:{outcome}',f'occ:{occ}']
  for g in groups:
   m=metrics[g];m['source'].add(source['id']);m['target'].add(target['id'])
   for arm,r in [('current',ra),('canonical',rb)]:
    eta,low,high=[max(0,r[j]) for j in [2,3,4]];ae=abs(eta-truth);wis=(.5*ae+.1*(high-low)+max(0,low-truth)+max(0,truth-high))/1.5;m[arm].append([ae,wis,high-low,int(truth<low),int(truth>high)])
  for tail,j,fn in [('early',3,lambda t,v:t<v),('late',4,lambda t,v:t>v)]:
   x,y=fn(truth,max(0,ra[j])),fn(truth,max(0,rb[j]))
   if x!=y:flips[f'{route}:{tail}:'+('introduced' if y else 'resolved')]+=1
  record['errorIncrease']=abs(max(0,rb[2])-truth)-abs(max(0,ra[2])-truth)
  if len(worst)<25:worst.append(record)
  elif record['errorIncrease']>min(r['errorIncrease'] for r in worst):worst.remove(min(worst,key=lambda r:r['errorIncrease']));worst.append(record)
 if counts['polls']%1000==0:print(json.dumps({'polls':counts['polls'],'scored':counts['scored']}),flush=True)
identityFile.close();tailFile.close();scoredFile.close();unpairedFile.close();trackingFile.close();summary={}
for g,m in metrics.items():
 summary[g]={'sources':len(m['source']),'targets':len(m['target'])}
 for arm in ['current','canonical']:
  rs=m[arm];summary[g][arm]={'n':len(rs),'MAE':statistics.mean(r[0] for r in rs),'median':statistics.median(r[0] for r in rs),'p90':q([r[0] for r in rs],.9),'WIS':statistics.mean(r[1] for r in rs),'width':statistics.mean(r[2] for r in rs),'early':sum(r[3] for r in rs),'late':sum(r[4] for r in rs)}
result={'counts':counts,'availability':availability,'tailFlips':flips,'stability':stability,'numericalProgress':progress,'metrics':summary,'chainSources':chainChecks,'uniqueLegsValidated':len(edgeChecks),'chainEndReasons':chainReasons,'largestPointRegressions':sorted(worst,key=lambda r:r['errorIncrease'],reverse=True),'limitations':'Minute samples are repeated dependent route/visit observations. Truth follows exact physical stop-index connected chains; skipped intermediate targets and broken chains unresolved. Current source arrivals before forecast are separate transitions; no detector label adjustment. Adapter zero normalization only for scores; raw negative bounds retained. No rider-decision or calibrated coverage claim.'}
(O/'score.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps({k:v for k,v in result.items() if k not in ['metrics','largestPointRegressions']},indent=2))
