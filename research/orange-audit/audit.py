import bisect,collections,copy,json,math,statistics as st,sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'k-sweep'))
from evaluate import IN,OUT,ROUTES,Models,Quality,read,metrics,ARMS,WAITS,TEST,date,clock,weekend,distance
DEST=IN/'orange-audit'
raw=read(IN/'raw_positions.jsonl.gz');visits=read(IN/'stop_visits.jsonl.gz')
quality=Quality(raw);model=Models(visits,quality)
vs={v['id']:v for v in visits}
rebuilt=read(DEST/'rebuilt-visits.jsonl.gz');by_event=collections.defaultdict(list);by_route=collections.defaultdict(list)
for e in rebuilt:
 if e['arrivedAt'] is not None:
  by_event[e['busName'],e['routeId'],e['stopIndex']].append(e)
  by_route[e['busName'],e['routeId']].append(e)
for es in by_event.values():es.sort(key=lambda e:e['arrivedAt'])
for es in by_route.values():es.sort(key=lambda e:e['arrivedAt'])
times={k:[e['arrivedAt'] for e in es] for k,es in by_event.items()}
rtimes={k:[e['arrivedAt'] for e in es] for k,es in by_route.items()}
def match(v,departure=False):
 key=v['bus_name'],v['route_id'],v['stop_index'];ts=times.get(key,[]);es=by_event.get(key,[])
 i=bisect.bisect_left(ts,v['arrived_at']);candidates=es[max(0,i-1):i+1]
 if not candidates:return None
 e=min(candidates,key=lambda e:abs(e['arrivedAt']-v['arrived_at']))
 if abs(e['arrivedAt']-v['arrived_at'])>15000 or e['how']=='gap' or e['outcome']=='unresolved':return None
 if departure and (e['departedAt'] is None or abs(e['departedAt']-v['departed_at'])>15000):return None
 return e
# Prefix sums allow an independent audit of every accepted training interval.
rg=collections.defaultdict(list)
for r in raw:rg[r['bus_name']].append(r)
flags={}
for bus,rs in rg.items():
 rs.sort(key=lambda r:(r['collected_at'],r['bus_id']))
 prefixes={k:[0] for k in ['idChange','coincident','gap','routeChange','speed']}
 for a,b in zip(rs,rs[1:]):
  sec=(b['collected_at']-a['collected_at'])/1000
  metres=math.hypot((b['lat']-a['lat'])*111195,(b['lon']-a['lon'])*111195*math.cos(math.radians(a['lat'])))
  bad=dict(idChange=a['bus_id']!=b['bus_id'],coincident=sec<=0,gap=sec>60,routeChange=a['route_id']!=b['route_id'],speed=sec>0 and metres/sec>22)
  for k,p in prefixes.items():p.append(p[-1]+int(bad[k]))
 flags[bus]=([r['collected_at'] for r in rs],prefixes)
def interval_flags(e):
 ts,ps=flags[e['bus']];lo=max(0,bisect.bisect_right(ts,e['start'])-1);hi=min(len(ts)-1,bisect.bisect_left(ts,e['end']))
 return [k for k,p in ps.items() if p[hi]>p[lo]]
path_cache={}
def path_flags(rid,k,w,ti,e):
 key=(e['sourceId'],e['targetId'])
 if key in path_cache:return path_cache[key]
 reasons=interval_flags(e);source,target=vs[e['sourceId']],vs[e['targetId']]
 if not match(source,True):reasons.append('sourceReplayMismatch')
 if not match(target):reasons.append('targetReplayMismatch')
 es=by_route.get((e['bus'],rid),[]);ts=rtimes.get((e['bus'],rid),[])
 seq=es[bisect.bisect_right(ts,e['start']):bisect.bisect_right(ts,e['end']+15000)]
 seq=[v for v in seq if v['arrivedAt']<=e['end'] or abs(v['arrivedAt']-e['end'])<=15000 and v['stopIndex']==ti]
 progress=0;prev=source['stop_index'];n=len(ROUTES[rid]['stops'])
 for v in seq:
  hop=distance(prev,v['stopIndex'],n);progress+=hop;prev=v['stopIndex']
  if hop>5 and 'largeRebuiltHop' not in reasons:reasons.append('largeRebuiltHop')
 if progress!=k+distance(w,ti,n):reasons.append('rebuiltOccurrenceMismatch')
 path_cache[key]=reasons
 return reasons
counts={};suspects=[]
strict=copy.copy(model);strict.paths=collections.defaultdict(list);strict.cache={}
for key,es in model.paths.items():
 rid,k,w,ti=key
 if rid not in (2,14):continue
 c=counts.setdefault(rid,collections.Counter())
 for e in es:
  c['paths']+=1;reasons=path_flags(*key,e)
  if reasons:
   c['suspectPaths']+=1;c.update(reasons)
   suspects.append(dict(route=rid,k=k,wait=w,target=ti,**e,flags=reasons))
  else:strict.paths[key].append(e)
rows=[r for r in read(OUT/'scored.jsonl.gz') if r['route'] in (2,14) and r['at']>=TEST]
result=dict(pathAudit={rid:dict(c) for rid,c in counts.items()},suspectSourceVisits=len({r['sourceId'] for r in suspects}),sensitivity={},leaveOneTrainingDateOut={},decomposition={},outcomeAudit={})
for rid in (2,14):
 rs=[r for r in rows if r['route']==rid];result['sensitivity'][rid]={}
 for arm in ARMS:
  changed=[r for r in rs if r['forecasts'][arm]['changed']]
  audited=[dict(r,forecasts={arm:strict.predict(r,arm)}) for r in changed]
  still=[r for r in audited if r['forecasts'][arm]['changed']]
  result['sensitivity'][rid][arm]=dict(original=metrics(changed,arm),baseline=metrics(changed,'usual'),strictOnOriginalCohort=metrics(audited,arm),strictChanged=metrics(still,arm),usualOnStrictChanged=metrics(still,'usual'))
 # Independent outcome timestamp check, never remove cases just because their error is large.
 outcomes={r['label']['id']:vs[r['label']['id']] for r in rs if r['forecasts']['K10']['changed']}
 bad=[v for v in outcomes.values() if not match(v)]
 result['outcomeAudit'][rid]=dict(targetVisits=len(outcomes),unmatchedReplay=len(bad),unmatchedIds=[v['id'] for v in bad])
 cohort=[r for r in rs if r['forecasts']['K10']['changed']]
 days=sorted({e['day'] for key,es in model.paths.items() if key[0]==rid for e in es})
 result['leaveOneTrainingDateOut'][rid]={}
 for day in days:
  m=copy.copy(model);m.cache={};m.paths={key:[e for e in es if e['day']!=day] for key,es in model.paths.items() if key[0]==rid}
  test=[dict(r,forecasts={'K10':m.predict(r,'K10')}) for r in cohort]
  result['leaveOneTrainingDateOut'][rid][day]=dict(metrics=metrics(test,'K10'),stillChanged=sum(r['forecasts']['K10']['changed'] for r in test),total=len(test))
 # Decompose complete matched journeys to the first stop after the wait.
 w=WAITS[rid][0];n=len(ROUTES[rid]['stops']);ti=(w+1)%n
 for k in (1,3,10):
  trips=[]
  for e in model.paths.get((rid,k,w,ti),[]):
   es=by_route.get((e['bus'],rid),[]);ws=[v for v in es if v['stopIndex']==w and v['arrivedAt']>=e['start'] and v['departedAt'] is not None and v['departedAt']<=e['end']]
   if len(ws)!=1:continue
   v=ws[0];trips.append(dict(**e,pre=(v['arrivedAt']-e['start'])/1000,hold=(v['departedAt']-v['arrivedAt'])/1000,post=(e['end']-v['departedAt'])/1000,flags=path_flags(rid,k,w,ti,e)))
  def desc(ts):
   out={'n':len(ts)}
   if len(ts)>2:
    for x in ['pre','hold','post','duration']:
     vals=sorted(t[x] for t in ts);out[x]=dict(mean=st.mean(vals),sd=st.stdev(vals),p10=vals[int((len(vals)-1)*.1)],p90=vals[int((len(vals)-1)*.9)])
    a=[t['pre'] for t in ts];b=[t['hold'] for t in ts];out['preHoldCorrelation']=st.correlation(a,b) if st.stdev(a)*st.stdev(b)>0 else None
   return out
  result['decomposition'][f'{rid}/K{k}']=dict(all=desc(trips),strict=desc([t for t in trips if not t['flags']]),days={d:desc([t for t in trips if t['day']==d]) for d in sorted({t['day'] for t in trips})},longest=sorted(trips,key=lambda t:t['duration'],reverse=True)[:8])
(DEST/'audit.json').write_text(json.dumps(result,indent=2))
(DEST/'suspect-paths.json').write_text(json.dumps(suspects,indent=2))
print(json.dumps(dict(pathAudit=result['pathAudit'],outcomeAudit=result['outcomeAudit'],sensitivity=result['sensitivity'])))
