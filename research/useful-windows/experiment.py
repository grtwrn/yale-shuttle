"""Fixed conditional-wait experiment; prediction output precedes label attachment."""
import collections,gzip,json,math,statistics as st,sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'k-sweep'))
from evaluate import IN,ROUTES,Models,Quality,read,clock,weekend,q,TEST,date,CUTOFF
DEST=Path(__file__).resolve().parent/'results';DEST.mkdir(exist_ok=True)
SCOPES={3:(10,14,list(range(15,29))),1:(10,24,None),16:(10,0,None),14:(10,0,None),15:(8,0,None)}
ARMS=['checkpoint_refit','hold_survival','hold_pace120','hold_pace240','hold_pace120_keep_early']
quality=Quality(read(IN/'raw_positions.jsonl.gz'));visits=read(IN/'stop_visits.jsonl.gz');model=Models(visits,quality)
by_id={v['id']:v for v in visits};by_bus=collections.defaultdict(list)
for v in visits:
 if v['arrived_at'] is not None and v['arrived_at']<CUTOFF:by_bus[v['bus_name'],v['route_id']].append(v)
for vs in by_bus.values():vs.sort(key=lambda v:v['arrived_at'])
training={};support={}
for rid,(k,w,targets) in SCOPES.items():
 seq=ROUTES[rid]['stops'];targets=targets if targets is not None else [i for i in range(len(seq)) if i!=w];SCOPES[rid]=(k,w,targets)
 cells={ti:{e['sourceId']:e for e in model.paths[rid,k,w,ti] if rid!=3 or e['duration']<=2700} for ti in targets}
 common=set.intersection(*(set(es) for es in cells.values()));trips=[]
 for sid in sorted(common):
  source=by_id[sid];start=source['departed_at'];first_end=min(cells[ti][sid]['end'] for ti in targets)
  waits=[v for v in by_bus[source['bus_name'],rid] if v['stop_index']==w and v['arrived_at']>=start and v['departed_at'] is not None and v['departed_at']<=first_end and v['how']!='gap' and v['outcome'] in ('passed','stopped')]
  if len(waits)!=1:continue
  wait=waits[0];elapsed=(wait['arrived_at']-start)/1000;hold=(wait['departed_at']-wait['arrived_at'])/1000
  if hold<0:continue
  paths={seq[ti]:cells[ti][sid]['duration'] for ti in targets}
  assert all(start+duration*1000<CUTOFF for duration in paths.values())
  trips.append(dict(source=sid,bus=source['bus_name'],start=start,day=date(start),clock=clock(start),weekend=weekend(start),pre=elapsed,hold=hold,total=paths,post={target:total-elapsed-hold for target,total in paths.items()}))
 training[rid]=trips;support[rid]=dict(completeTrips=len(trips),dates=sorted({t['day'] for t in trips}))
cache={}
def group(r,arm):
 e=r['deployedEvidence'];rid=r['route'];k,w,targets=SCOPES[rid];origin=e['origin']['departed']
 began=r['began'];elapsed=(r['at']-origin)/1000;held=(r['at']-began)/1000;pre=(began-origin)/1000
 key=(rid,arm,origin,began,r['at'])
 if key in cache:return cache[key]
 assert origin<=began<=r['asof'] and e['origin']['knownAt']<=r['asof']
 clock_now=clock(origin);endpoints=[];weights=[];days=[]
 mode='hold_pace120' if arm=='hold_pace120_keep_early' else arm
 for t in training[rid]:
  if t['weekend']!=weekend(origin):continue
  delta=abs(t['clock']-clock_now);delta=min(delta,1440-delta)
  weight=math.exp(-.5*(delta/120)**2)
  if mode!='checkpoint_refit':
   if t['hold']<held:continue
   if mode.startswith('hold_pace'):
    scale=120 if mode=='hold_pace120' else 240
    weight*=math.exp(-.5*((t['pre']-pre)/scale)**2)
  if weight<1e-12:continue
  endpoints.append(t);weights.append(weight);days.append(t['day'])
 total=sum(weights);eff=total*total/sum(v*v for v in weights) if total else 0
 dw=collections.defaultdict(float)
 for day,weight in zip(days,weights):dw[day]+=weight
 if eff<12 or sum(weight>=total*.05 for weight in dw.values())<3:
  cache[key]=(None,'insufficient conditional group support');return cache[key]
 forecasts={}
 for ti in targets:
  target=ROUTES[rid]['stops'][ti]
  values=[max(0,t['total'][target]-elapsed) if mode=='checkpoint_refit' else max(0,t['hold']-held+t['post'][target]) for t in endpoints]
  mean=sum(v*weight for v,weight in zip(values,weights))/total
  if mean<=60:
   cache[key]=(None,'whole group near expiry');return cache[key]
  forecasts[target]=dict(eta=mean,low=min(mean,q(values,.1,weights)),high=max(mean,q(values,.9,weights)))
 cache[key]=(forecasts,'conditional wait');return cache[key]
def predict(r,arm):
 old=r['deployed'];e=r['deployedEvidence'];rid=r['route']
 if not r['deployedChanged'] or rid not in SCOPES or not e:return old,'outside deployed checkpoint section'
 _,w,_=SCOPES[rid]
 if e['released'] or e['phase']!='hold' or e['index']!=w or r['index']!=w or r['phase']!='hold':return old,'outside confirmed major wait'
 if not r['ready'] or r['began']>r['asof'] or r['began']<e['origin']['departed']:return old,'inconsistent causal phase'
 forecasts,reason=group(r,arm)
 if forecasts is None:return old,reason
 candidate=dict(forecasts[r['target']])
 if arm=='hold_pace120_keep_early':candidate['low']=min(old['low'],candidate['low'])
 return candidate,reason
# No labels enter fitting or prediction. Persist these before reading scored rows.
generated=[]
for r in read(DEST/'deployed.jsonl.gz'):
 candidates={};reasons={}
 for arm in ARMS:candidates[arm],reasons[arm]=predict(r,arm)
 generated.append(dict(r,candidates=candidates,candidateReasons=reasons))
def write(file,rows):
 with gzip.open(DEST/file,'wt') as f:
  for r in rows:f.write(json.dumps(r,separators=(',',':'))+'\n')
write('unscored.jsonl.gz',generated)
def key(r):return r['at'],r['bus'],r['route'],r['target']
labels={key(r):r for r in read(IN/'long90/scored.jsonl.gz') if r['at']>=TEST}
scored=[dict(r,label=labels[key(r)]['label'],truth=labels[key(r)]['truth']) for r in generated if key(r) in labels]
write('forecasts.jsonl.gz',scored)
def forecast(r,arm):return r['deployed'] if arm=='deployed' else r['candidates'][arm]
def metrics(rows,arm):
 grouped=collections.defaultdict(list);early60=set();introduced=set()
 for r in rows:
  f=forecast(r,arm);truth=r['truth'];grouped[r['label']['id']].append(dict(mae=abs(f['eta']-truth),width=f['high']-f['low'],coverage=float(f['low']<=truth<=f['high']),early=float(truth<f['low']),early30=float(truth<f['low']-30),early60=float(truth<f['low']-60),early120=float(truth<f['low']-120),late=float(truth>f['high'])))
  if truth<f['low']-60:
   early60.add(r['label']['id'])
   if truth>=r['deployed']['low']-60:introduced.add(r['label']['id'])
 if not rows:return dict(snapshots=0,visits=0)
 return dict(snapshots=len(rows),visits=len(grouped),days=len({date(r['at']) for r in rows}),sourceTrips=len({(r['bus'],r['deployedEvidence']['origin']['departed']) for r in rows if r['deployedChanged'] and r['deployedEvidence']}),severeEarlyVisits=len(early60),introducedSevereEarlyVisits=len(introduced),falseNow=sum(forecast(r,arm)['eta']<=15 and r['truth']>120 for r in rows),**{k:st.mean(st.mean(v[k] for v in vs) for vs in grouped.values()) for k in next(iter(grouped.values()))[0]})
def ordering(rows,arm):
 groups=collections.defaultdict(list)
 for r in rows:groups[r['at'],r['bus'],r['route']].append(r)
 pairs=0;new=0
 for rs in groups.values():
  rs=sorted(rs,key=lambda r:r['stopsAhead'])
  for a,b in zip(rs,rs[1:]):
   if not 0<a['stopsAhead']<b['stopsAhead']:continue
   pairs+=1
   new+=forecast(a,arm)['eta']>forecast(b,arm)['eta']+30 and a['deployed']['eta']<=b['deployed']['eta']+30
 return dict(pairs=pairs,introducedReversals=int(new))
summary=dict(training=support,routes={},note='Diagnostic reused dates; promotion requires new temporal data and action-risk checks')
for rid in ROUTES:
 rs=[r for r in scored if r['route']==rid];arms={}
 for arm in ARMS:
  changed=[r for r in rs if r['candidates'][arm]!=r['deployed']]
  arms[arm]=dict(all=metrics(rs,arm),deployedAll=metrics(rs,'deployed'),changed=metrics(changed,arm),deployedOnChanged=metrics(changed,'deployed'),fallbacks=dict(collections.Counter(r['candidateReasons'][arm] for r in rs)),ordering=ordering(rs,arm),days={d:dict(candidate=metrics([r for r in changed if date(r['at'])==d],arm),deployed=metrics([r for r in changed if date(r['at'])==d],'deployed')) for d in sorted({date(r['at']) for r in rs})})
 summary['routes'][rid]=arms
(DEST/'summary.json').write_text(json.dumps(summary,indent=2))
print(json.dumps(dict(training=support,routes={rid:{a:{k:v for k,v in v.items() if k in ['changed','deployedOnChanged','ordering']} for a,v in arms.items()} for rid,arms in summary['routes'].items() if rid in SCOPES})))
