"""Retrospective stand-component experiment; no production estimator changes.
Train < Aug 15; interval calibration Aug 15-28; score Aug 29 onward.
Only event timestamps are available: receipt-time causality is NOT established.
"""
import sys,json,math,statistics as st,hashlib,heapq,collections,datetime,random
from zoneinfo import ZoneInfo
src,out=sys.argv[1:3]
delay_ms=int(sys.argv[3])*1000 if len(sys.argv)>3 else 0
assert delay_ms>=0
raw=open(src,'rb').read(); rows=[json.loads(l) for l in raw.splitlines() if l]
zone=ZoneInfo('America/New_York')
def day(t):return datetime.datetime.fromtimestamp(t/1000,zone).date().isoformat()
cut=lambda s:int(datetime.datetime.fromisoformat(s).replace(tzinfo=zone).timestamp()*1000)
FIT,CAL=cut('2026-08-15'),cut('2026-08-29')
audit=collections.Counter(input_rows=len(rows)); grouped=collections.defaultdict(list)
for r in rows:
 vals=[r.get('arrived_at'),r.get('departed_at')]
 if not all(isinstance(t,(float,int)) and math.isfinite(t) for t in vals) or vals[1]<=vals[0]:audit['invalid_timestamp']+=1;continue
 if r.get('route_id')!=3 or r.get('stop_id') not in (11,121) or not r.get('bus_name'):audit['wrong_cell_or_identity']+=1;continue
 grouped[(r['bus_name'],r['stop_id'],r['arrived_at'])].append(r)
clean=[]
for rs in grouped.values():
 if len({r['departed_at'] for r in rs})>1:audit['conflicting_visit_rows']+=len(rs);continue
 audit['exact_duplicate_rows']+=len(rs)-1;clean.append(rs[0])
clean.sort(key=lambda r:r['arrived_at'])
# Reject overlaps within the same vehicle/cell; both intervals are suspect.
by=collections.defaultdict(list)
for r in clean:by[(r['bus_name'],r['stop_id'])].append(r)
bad=set()
for vs in by.values():
 max_end=-1;owner=None
 for r in vs:
  if r['arrived_at']<max_end:bad.update((id(r),id(owner)))
  if r['departed_at']>max_end:max_end=r['departed_at'];owner=r
clean=[r for r in clean if id(r) not in bad];audit['overlap_rows']=len(bad)
audit['valid_closed_visits']=len(clean);audit['stands_over_40_min_retained']=sum(r['departed_at']-r['arrived_at']>2400000 for r in clean)
# Chronological event sweep. A row's own departure is never a feature of that row.
pending=[];past={};data=[]
for seq,r in enumerate(clean):
 a,d,b,s=r['arrived_at'],r['departed_at'],r['bus_name'],r['stop_id']
 while pending and pending[0][0]<=a:
  dep,_,old=heapq.heappop(pending);past[(old['bus_name'],old['stop_id'])]=old['departed_at']
 p=past.get((b,s)); opposite=past.get((b,121 if s==11 else 11)); same_day=p is not None and day(p)==day(a)
 full_loop=same_day and opposite is not None and p<opposite<a
 head=[v for (bus,stop),v in past.items() if stop==s and bus!=b and day(v)==day(a) and 0<=a-v<=7200000]
 data.append(dict(stop=s,bus=b,a=a,d=d,day=day(a),y=(d-a)/1000,lap=(a-p)/1000 if full_loop else None,
                  period=(d-p)/1000 if full_loop else None,h=(a-max(head))/1000 if head else None))
 if not full_loop:audit['no_confirmed_same_day_loop']+=1
 heapq.heappush(pending,(d+delay_ms,seq,r))
def quant(a,q):
 a=sorted(a);p=(len(a)-1)*q;i=int(p);return a[i]+(a[min(i+1,len(a)-1)]-a[i])*(p-i)
def fit(rs,cols):
 xs=[[1]+[r[c] for c in cols] for r in rs];n=len(cols)+1
 mat=[[sum(x[i]*x[j] for x in xs) for j in range(n)]+[sum(x[i]*r['y'] for x,r in zip(xs,rs))] for i in range(n)]
 for i in range(n):
  pivot=max(range(i,n),key=lambda j:abs(mat[j][i]));mat[i],mat[pivot]=mat[pivot],mat[i]
  if abs(mat[i][i])<1e-8:return None
  scale=mat[i][i];mat[i]=[v/scale for v in mat[i]]
  for j in range(n):
   if j!=i:
    scale=mat[j][i];mat[j]=[v-scale*w for v,w in zip(mat[j],mat[i])]
 coef=[mat[i][-1] for i in range(n)]
 # Median-center residuals on training only for absolute-error prediction.
 coef[0]+=st.median(r['y']-sum(x*c for x,c in zip(x,coef)) for x,r in zip(xs,rs))
 return coef
def pred(coef,r,cols):return max(0,coef[0]+sum(c*r[k] for c,k in zip(coef[1:],cols)))
results=[]
for stop in (11,121):
 ds=[r for r in data if r['stop']==stop];train=[r for r in ds if r['d']<FIT];cal=[r for r in ds if FIT<=r['a'] and r['d']<CAL];test=[r for r in ds if r['a']>=CAL]
 # Period/eligibility are fitted before the scoring dates, unlike lap90.mjs.
 P=st.median(r['period'] for r in train if r['period'] is not None and 900<r['period']<7200)
 valid=lambda r:r['lap'] is not None and .65*P<=r['lap']<=1.65*P
 tr=[r for r in train if valid(r)];th=[r for r in tr if r['h'] is not None];M=st.median(r['y'] for r in train)
 L=fit(tr,['lap']);H=fit(th,['lap','h'])
 base=lambda r:M
 lap=lambda r:pred(L,r,['lap']) if valid(r) else M
 head=lambda r:pred(H,r,['lap','h']) if valid(r) and r['h'] is not None else lap(r)
 funcs={'pooled':base,'lap':lap,'lap_plus_prior_departure_headway':head};metrics={};predictions={}
 for name,f in funcs.items():
  residuals=[r['y']-f(r) for r in cal];lo,hi=quant(residuals,.1),quant(residuals,.9)
  ps=[f(r) for r in test];predictions[name]=ps;err=[p-r['y'] for p,r in zip(ps,test)]
  intervals=[(max(0,p+lo),max(0,p+hi)) for p in ps]
  metrics[name]={'mae_sec':st.mean(map(abs,err)),'overpredict_gt120_pct':100*sum(e>120 for e in err)/len(err),'underpredict_gt120_pct':100*sum(e< -120 for e in err)/len(err),'coverage80_pct':100*sum(l<=r['y']<=h for (l,h),r in zip(intervals,test))/len(test),'mean_width_sec':st.mean(h-l for l,h in intervals)}
 def boot_diff(first,second):
  days=collections.defaultdict(list)
  for r,p,q in zip(test,predictions[first],predictions[second]):days[r['day']].append(abs(q-r['y'])-abs(p-r['y']))
  blocks=list(days.values());rng=random.Random(184+stop);vals=[]
  for _ in range(400):
   sel=[blocks[rng.randrange(len(blocks))] for _ in blocks];vals.append(sum(map(sum,sel))/sum(map(len,sel)))
  return [quant(vals,.025),quant(vals,.975)]
 results.append({'stop':stop,'train':len(train),'calibration':len(cal),'test':len(test),'test_days':len({r['day'] for r in test}),'loop_minutes':P/60,'lap_training_n':len(tr),'headway_training_n':len(th),'test_lap_available':sum(valid(r) for r in test),'test_headway_available':sum(valid(r) and r['h'] is not None for r in test),'lap_coefficients':L,'lap_headway_coefficients':H,'metrics':metrics,'lap_minus_pooled_mae_ci':boot_diff('pooled','lap'),'headway_minus_lap_mae_ci':boot_diff('lap','lap_plus_prior_departure_headway')})
report={'input':src,'history_delay_sec':delay_ms/1000,'sha256':hashlib.sha256(raw).hexdigest(),'audit':dict(audit),'fit_before':'2026-08-15 ET','interval_calibration_before':'2026-08-29 ET','test_from':'2026-08-29 ET','results':results,'limits':['Retrospective previously inspected archive, not untouched confirmation.','Historical closed geofence visits are not independently validated physical stand labels; no censoring or receipt-time metadata is available.','Headway is elapsed time since another bus departed this stop, not live road distance to either neighbor. Following-bus distance requires synchronized GPS.','Component predictions at arrival only; no whole-trip, remaining-wait, countdown-stability or deployment claim.','Long closed visits retained in scoring; unavailable/out-of-band lap uses pooled fallback; no test-based window or model selection.']}
open(out,'w').write(json.dumps(report,indent=2));print(json.dumps(report,indent=2))
