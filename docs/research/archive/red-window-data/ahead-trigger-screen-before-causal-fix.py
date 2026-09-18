"""Retrospective predecessor-stop trigger screen, development recordings only.

One-step departure hazards use only predecessor evidence available at bin start.
Future predecessor events enter the labeled event-study negative control ONLY.
No app changes, no remaining-wait CDF using realized future predecessor motion.
"""
import bisect,collections,datetime,hashlib,json,math,pathlib,sqlite3,statistics
import numpy as np
from scipy.optimize import minimize,brentq
from scipy.special import expit
from zoneinfo import ZoneInfo
D=pathlib.Path(__file__).resolve().parent; ROOT=D.parent; TZ=ZoneInfo('America/New_York')
OP=D/'operating-pattern-screen.json';BASE=D/'release-survival-screen.json'
op=json.loads(OP.read_text());base=json.loads(BASE.read_text())
cut=lambda s:datetime.datetime.fromisoformat(s).replace(tzinfo=TZ).timestamp()*1000
FIT,TEST=cut('2026-09-10'),cut('2026-09-14')
END=1789665240913;STEP=15;WINDOW=120;PENALTY=10
ARMS=['baseline','predecessor_control','progress','arrival_pulses','clearance_pulses','joint']
REGIMES=['arrival15_clear30_proxy','completed120']
plan=dict(createdAtUTC=datetime.datetime.now(datetime.timezone.utc).isoformat(),fitEnd=FIT,calibrationEnd=TEST,developmentEnd=END,
  stepSec=STEP,pulseWindowSec=WINDOW,newCoefficientL2=PENALTY,minFeatureTrainingEpisodes=5,minFeatureTrainingDates=2,
  arms=ARMS,regimes=REGIMES,predecessor='Most recently completed OTHER bus departure from same regulator, same local date, within preceding60min; completion+120s known before focal pin; identity latched throughout hold.',
  mainOutcome='One-step departure hazard log loss per episode and Brier score, calibrated separately by intercept on Sep10-11.',
  exclusions='Reuse existing valid completed focal hold cohort; only confirmed corruption65237 was excluded there. No residual-tail trimming. No records after developmentEnd.',
  predictionRestriction='No forward survival/remaining-time calculation from realized future predecessor events.',
  negativeControl='Events becoming observable during next120s, descriptive only; never predictor input.',
  arrivalProxy='All recorded attributed visits including passes/unresolved: pin if available else anchor, plus15s. Proxy is not an exact event receipt log.',
  clearanceProxy='Non-gap completed departure plus30s. Assumes confirmation by then; not exact receipt. Completed120 sensitivity uses max(departure+120s,first_moved+confirm_sec).',
  eventStudy='Report every route stop, raw and baseline-expected event rates; do not select a winning stop from development results.')
planPath=D/'ahead-trigger-plan.json'
if planPath.exists():
 previous=json.loads(planPath.read_text());assert all(previous[k]==v for k,v in plan.items()if k!='createdAtUTC')
 plan=previous
else:planPath.write_text(json.dumps(plan,indent=2)+'\n')
rows=[dict(r)for r in op['featureRows'] if r['ready']<=END]
assert all(r['a']<=r['d']<=r['ready']<=END for r in rows)
refs={r['stop']:r['referenceLap']for r in op['results']}
coefs={r['stop']:np.array(r['coefficients'])for r in base['fits']if r['arm']=='hazard_age_lap_clock15'}
db=sqlite3.connect('file:'+str(ROOT/'conditional-replay-data/outcomes.db')+'?mode=ro',uri=True);db.row_factory=sqlite3.Row
seq=json.loads(db.execute('select stops_json from routes where id=3').fetchone()[0]);N=len(seq);index={s:i for i,s in enumerate(seq)}
stops={r['id']:dict(r)for r in db.execute('select * from stops')}
visits=[dict(v)for v in db.execute('select * from stop_visits where route_id=3 and anchored_at<=? order by anchored_at',(END,))];db.close()
def day(t):return datetime.datetime.fromtimestamp(t/1000,TZ).date().isoformat()
def ready(v):
 d=v['departed_at']
 return max(d+120000,(v['first_moved_at']or d)+(v['confirm_sec']or 0)*1000)if d is not None and v['how']!='gap' else None
departures=collections.defaultdict(list)
for v in visits:
 known=ready(v)
 if v['stop_id'] in [11,121] and known is not None and known<=END and v['pinned_at'] is not None and v['closest_m'] is not None and v['closest_m']<=75:
  departures[v['stop_id'],day(v['departed_at'])].append(dict(v,known=known))
for r in rows:
 eligible=[v for v in departures[r['stop'],r['day']]if v['bus_name']!=r['bus']and v['known']<=r['a']and r['a']-3600000<=v['departed_at']]
 p=max(eligible,key=lambda v:v['departed_at'])if eligible else None
 r['predecessor']=None if p is None else dict(bus=p['bus_name'],visitId=p['id'],departedAt=p['departed_at'],known=p['known'],gapSec=(r['a']-p['departed_at'])/1000)
 if p:assert p['known']<=r['a'] and p['bus_name']!=r['bus']

events={reg:collections.defaultdict(list)for reg in REGIMES}
for v in visits:
 if v['stop_id']not in index:continue
 a=v['pinned_at']if v['pinned_at'] is not None else v['anchored_at'];rd=ready(v)
 arrival=dict(id=v['id'],stop=v['stop_id'],index=index[v['stop_id']],physical=a,outcome=v['outcome'],pinned=v['pinned_at']is not None)
 if a+15000<=END:events[REGIMES[0]][v['bus_name'],'arrival'].append(dict(arrival,known=a+15000))
 if rd is not None and rd<=END:
  events[REGIMES[1]][v['bus_name'],'arrival'].append(dict(arrival,known=rd))
  events[REGIMES[1]][v['bus_name'],'clearance'].append(dict(arrival,physical=v['departed_at'],known=rd))
 if rd is not None and v['departed_at']+30000<=END:
  events[REGIMES[0]][v['bus_name'],'clearance'].append(dict(arrival,physical=v['departed_at'],known=v['departed_at']+30000))
for ev in events.values():
 for es in ev.values():es.sort(key=lambda e:(e['known'],e['physical'],e['id']))
times={reg:{key:[e['known']for e in es]for key,es in ev.items()}for reg,ev in events.items()}
def base_design(r,t):
 t=np.asarray(t);available=r['lap']is not None and .65*refs[r['stop']]<=r['lap']<=1.65*refs[r['stop']]
 lap=(r['lap']-refs[r['stop']])/600 if available else 0
 phase=2*np.pi*(r['hour']*3600+t)/900
 return np.stack([np.ones_like(t),np.log1p(t/60),t/600,np.maximum(t-300,0)/600,np.maximum(t-600,0)/600,
  np.full_like(t,lap),np.full_like(t,float(not available)),np.sin(phase),np.cos(phase)],axis=-1)
def history(r,t,reg):
 p=r['predecessor']; pulse={};future={};latest=None
 for kind in ['arrival','clearance']:
  z=np.zeros(N);f=np.zeros(N)
  if p:
   es=events[reg].get((p['bus'],kind),[]);ts=times[reg].get((p['bus'],kind),[])
   lo=bisect.bisect_left(ts,max(r['a']-3600000,t-WINDOW*1000));hi=bisect.bisect_right(ts,t)
   for e in es[lo:hi]:z[e['index']]=1
   # Explicitly labeled future-event negative control. Not copied into X.
   end=bisect.bisect_right(ts,min(t+WINDOW*1000,END))
   for e in es[hi:end]:f[e['index']]=1
   if kind=='arrival'and hi:
    e=es[hi-1]
    if e['physical']>=p['departedAt'] and day(e['physical'])==r['day']:latest=e
  pulse[kind]=z;future[kind]=f
 return pulse,future,latest

datasets={};eventStudy=[];outputFits=[];predictions=[];scores=[];support=[]
for reg in REGIMES:
 # Every feature is constructed at the START of its risk bin; deterministic
 # age/clock baseline uses the same midpoint convention as the earlier model.
 bundles=[]
 for r in rows:
  bins=max(1,math.ceil(r['y']/STEP));ages=np.arange(bins)*STEP;t=r['a']+ages*1000
  X=[];P=[];F=[];progs=[]
  for at in t:
   pulses,future,latest=history(r,at,reg);p=r['predecessor']
   controls=[float(p is not None),p['gapSec']/600 if p else 0]
   angle=2*math.pi*((latest['index']-index[r['stop']])%N)/N if latest else 0
   progress=[float(latest is not None),math.sin(angle)if latest else 0,math.cos(angle)if latest else 0,
             min(6,math.log1p((at-latest['known'])/60000))if latest else 0]
   X.append(controls+progress+pulses['arrival'].tolist()+pulses['clearance'].tolist())
   P.append(np.stack([pulses['arrival'],pulses['clearance']]))
   F.append(np.stack([future['arrival'],future['clearance']]))
   progs.append(latest['id']if latest else None)
  y=np.zeros(bins);y[-1]=1
  bundles.append(dict(row=r,X=np.array(X),pulse=np.array(P),future=np.array(F),offset=base_design(r,ages+STEP/2)@coefs[r['stop']],y=y,at=t,latestIds=progs))
 datasets[reg]=bundles
 for stop in [11,121]:
  groups={split:[b for b in bundles if b['row']['stop']==stop and (
   b['row']['ready']<FIT if split=='train'else b['row']['a']>=FIT and b['row']['ready']<TEST if split=='calibration'else b['row']['a']>=TEST)]for split in ['train','calibration','development']}
  for kind,ki in [('arrival',0),('clearance',1)]:
   for partition in ['train','calibration','development']:
    bs=groups[partition]
    for si,sid in enumerate(seq):
     item=dict(regime=reg,sourceStop=stop,triggerStop=sid,triggerName=stops[sid].get('name'),eventKind=kind,split=partition)
     for title,field in [('afterKnownEvent','pulse'),('beforeFutureKnownEvent_NEGATIVE_CONTROL','future')]:
      exposures=[];cases=[]
      for b in bs:
       mask=b[field][:,ki,si]>0
       if np.any(mask):exposures.append((b,mask));cases.append(b['row'])
      n=sum(int(m.sum())for b,m in exposures);observed=sum(float(b['y'][m].sum())for b,m in exposures);expected=sum(float(expit(b['offset'][m]).sum())for b,m in exposures)
      item[title]=dict(riskBins=n,exposureMinutes=n*STEP/60,holdEpisodes=len(cases),dates=len({r['day']for r in cases}),departures=int(observed),baselineExpectedDepartures=expected,observedToExpected=observed/expected if expected else None)
     eventStudy.append(item)
  # Stop-specific coefficients are supported by training exposure only, never
  # by whether a development stop has an appealing outcome association.
  eligible=[]
  for col in range(6+2*N):
   exposed=[b['row']for b in groups['train']if np.any(np.abs(b['X'][:,col])>0)]
   if col<6 or (len(exposed)>=5 and len({r['day']for r in exposed})>=2):eligible.append(col)
  columns={
   'baseline':[], 'predecessor_control':[0,1], 'progress':list(range(6)),
   'arrival_pulses':[0,1]+list(range(6,6+N)),
   'clearance_pulses':[0,1]+list(range(6+N,6+2*N)),
   'joint':list(range(6+2*N))}
  for arm in ARMS:
   cols=[c for c in columns[arm]if c in eligible]
   # Conservative arrival/clearance reports can be identical. Exact duplicate
   # columns are collapsed using TRAINING X only, to avoid halving ridge cost.
   if cols:
    tx=np.vstack([b['X']for b in groups['train']]);unique=[]
    for c in cols:
     if not any(np.array_equal(tx[:,c],tx[:,k])for k in unique):unique.append(c)
    cols=unique
   xx=np.vstack([b['X'][:,cols]for b in groups['train']]);yy=np.concatenate([b['y']for b in groups['train']]);off=np.concatenate([b['offset']for b in groups['train']])
   if cols:
    def objective(co):
     z=off+xx@co
     return float((np.logaddexp(0,z)-yy*z).sum()+.5*PENALTY*(co@co)),xx.T@(expit(z)-yy)+PENALTY*co
    opt=minimize(objective,np.zeros(len(cols)),jac=True,method='L-BFGS-B',options={'maxiter':1500,'gtol':1e-8});assert opt.success,opt.message;co=opt.x
   else:co=np.zeros(0)
   for bs in groups.values():
    for b in bs:b.setdefault('logits',{})[arm]=b['offset']+b['X'][:,cols]@co
   cz=np.concatenate([b['logits'][arm]for b in groups['calibration']]);cy=np.concatenate([b['y']for b in groups['calibration']])
   intercept=brentq(lambda v:float((expit(cz+v)-cy).sum()),-20,20)
   outputFits.append(dict(regime=reg,stop=stop,arm=arm,columns=cols,coefficients=co.tolist(),calibrationIntercept=intercept,trainEpisodes=len(groups['train']),trainRiskBins=len(yy),calibrationEpisodes=len(groups['calibration']),baselineCoefficients=coefs[stop].tolist()))
   for calibrated in [False,True]:
    held=[]
    for b in groups['development']:
     z=b['logits'][arm]+(intercept if calibrated else 0);p=expit(z);y=b['y'];rr=b['row']
     held.append(dict(id=rr['id'],day=rr['day'],bus=rr['bus'],hasPredecessor=rr['predecessor']is not None,holdSec=rr['y'],riskBins=len(y),
        logLoss=float((np.logaddexp(0,z)-y*z).sum()),brier=float(((p-y)**2).mean()),expectedDepartures=float(p.sum()),eventBinProbability=float(p[-1])))
    predictions.append(dict(regime=reg,stop=stop,arm=arm,calibrated=calibrated,episodes=held))
    for group in ['all','predecessor_known','predecessor_missing']+sorted({h['day']for h in held}):
     hs=[h for h in held if group=='all'or(group=='predecessor_known'and h['hasPredecessor'])or(group=='predecessor_missing'and not h['hasPredecessor'])or h['day']==group]
     if not hs:continue
     scores.append(dict(regime=reg,stop=stop,arm=arm,calibrated=calibrated,group=group,n=len(hs),dates=len({h['day']for h in hs}),
       meanLogLossPerHold=statistics.mean(h['logLoss']for h in hs),meanBrierPerHold=statistics.mean(h['brier']for h in hs),
       pooledBrier=sum(h['brier']*h['riskBins']for h in hs)/sum(h['riskBins']for h in hs),expectedDepartures=sum(h['expectedDepartures']for h in hs),observedDepartures=len(hs)))
  support.append(dict(regime=reg,stop=stop,bySplit={k:dict(episodes=len(bs),dates=sorted({b['row']['day']for b in bs}),predecessorKnown=sum(b['row']['predecessor']is not None for b in bs),riskBins=sum(len(b['y'])for b in bs))for k,bs in groups.items()},supportedColumns=eligible))
out=dict(method=__doc__,plan=plan,support=support,fits=outputFits,scores=scores,eventStudy=eventStudy,perEpisodeScores=predictions,
 featureRows=[{k:r[k]for k in ['id','stop','bus','a','d','ready','day','predecessor']}for r in rows],
 limitations=['Arrival+15s and clearance+30s are proxies, not exact receipt reconstruction; pin fallback to anchor includes unpinned passes and may precede reaching the marker.',
 'Predecessor is prior confirmed-departure order at pin, not oracle future order or continuous nearest-forward GPS; overtaking/co-presence is a different covariate.',
 'Completed120s can erase a real immediate trigger; it is a latency sensitivity, not proof that triggers cannot work.',
 'Latest known stop is sparse route progress, not exact physical projected headway. All stop pulses share a path and are highly correlated.',
 'One-step hazard improvement is not validated remaining-time/ETA improvement; future predecessor motion must be forecast causally before integration.',
 'Four development dates previously inspected; repeated bins share holds, buses and days. Event-study ratios are descriptive, not causal estimates or independent p-values.',
 'Neither the later Sep17 holdout nor any observation after the declared development end is used. All fixed feature families are reported; no test-selected trigger stop.'],
 inputs={p.name:hashlib.sha256(p.read_bytes()).hexdigest()for p in [OP,BASE,planPath,pathlib.Path(__file__)]})
(D/'ahead-trigger-screen.json').write_text(json.dumps(out,indent=2)+'\n')
print(json.dumps(dict(support=support,allScores=[s for s in scores if s['group']=='all']),indent=2))
