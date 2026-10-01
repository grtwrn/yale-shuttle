"""Development-only follower progress screen; no production/model changes.
Latched departure order and observed stop-order sensitivity, without future
follower arrival or departure in a remaining-wait prediction.
"""
DOC=__doc__
import ast
from pathlib import Path
initial=Path(__file__).with_name('ahead-trigger-screen.py')
tree=ast.parse(initial.read_text());prefix=[]
for node in tree.body:
 if isinstance(node,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='datasets' for t in node.targets):break
 prefix.append(node)
exec(compile(ast.Module(body=prefix,type_ignores=[]),str(initial),'exec'))
from functools import lru_cache
day=lru_cache(maxsize=131072)(day)
ARMS=['baseline','identity_controls','progress','progress_clock','arrival_pulses','reached','reached_clock']
IDENTITIES=['departure_order','stop_order'];OFFSETS=['lap_clock','lap_clock_ahead']
PLAN=dict(createdAtUTC=datetime.datetime.now(datetime.timezone.utc).isoformat(),fitEnd=FIT,calibrationEnd=TEST,developmentEnd=END,stepSec=STEP,
 arms=ARMS,identities=IDENTITIES,offsets=OFFSETS,regimes=REGIMES,penalty=PENALTY,minFeatureTrainingEpisodes=5,minFeatureTrainingDates=2,
 departureOrder='At focal pin: latest own confirmed source departure within90min and same day, intervening unconditional opposite-stop anchor already known; first confirmed other departure after own. Reject intervening known focal source returns. Latch identity, not future next departure.',
 stopOrder='At focal pin: latest unconditional anchor+15s per other bus, physical anchor age<=10min, valid route index. Choose smallest positive backward stop-index gap; same-stop or nearest-gap ties yield unknown. Topological order, not metric GPS spacing. Identity remains latched.',
 features='Identity/origin availability, age of last source departure, initial backward stop gap; dynamic latest known relative stop progress and staleness, progress times15minclock;120s arrival pulses and persistent reached flags timesclock. All supported stops jointly, no chosen winner.',
 offsetComparison='Existing fixed age/lap/clock hazard, and separately the fixed training-only ahead reached-clock extension. Additional follower coefficients fit only on preSep10; same coefficient penalty.',
 uncertainty='No future peer paths in forward ETA. One-step next15s departure, chronology and existing curated valid cohort preserved. All families reported; exploratory on previously inspected development dates.')
planPath=D/'follower-progress-plan.json'
if planPath.exists():
 old=json.loads(planPath.read_text());assert all(old[k]==v for k,v in PLAN.items() if k!='createdAtUTC');PLAN=old
else:planPath.write_text(json.dumps(PLAN,indent=2)+'\n')

anchors=collections.defaultdict(list)
for v in visits:
 si=v['stop_index']
 if si is not None and 0<=si<N and seq[si]==v['stop_id']:
  anchors[v['bus_name']].append(dict(id=v['id'],physical=v['anchored_at'],known=v['anchored_at']+15000,index=si,stop=v['stop_id']))
for es in anchors.values():es.sort(key=lambda e:(e['known'],e['id']))
anchorTimes={b:[e['known'] for e in es]for b,es in anchors.items()}
def known_anchors(bus,at):
 es=anchors.get(bus,[]);return es[:bisect.bisect_right(anchorTimes.get(bus,[]),at)]
def latest_anchor(bus,at,maxAge=None):
 es=known_anchors(bus,at)
 if not es:return None
 e=es[-1]
 return e if day(e['physical'])==day(at) and (maxAge is None or at-e['physical']<=maxAge) else None
def known_source(r,bus=None):
 return [v for v in departures[r['stop'],r['day']] if v['known']<=r['a'] and r['a']-5400000<=v['departed_at'] and (bus is None or v['bus_name']==bus)]
def follower(r,mode):
 ds=known_source(r);fresh={b:e for b in anchors if b!=r['bus'] and (e:=latest_anchor(b,r['a'],600000)) is not None}
 detail=dict(freshPeers=len(fresh),coLocated=sum(e['index']==index[r['stop']]for e in fresh.values()))
 p=None;reason='known'
 if mode=='departure_order':
  own=[v for v in ds if v['bus_name']==r['bus']]
  prev=max(own,key=lambda v:v['departed_at']) if own else None
  if prev is None:reason='no prior own confirmed source departure'
  elif any(e['physical']>prev['departed_at'] and e['stop']==r['stop'] and e['id']!=r['id'] for e in known_anchors(r['bus'],r['a'])):reason='intervening known focal source return'
  elif not any(e['physical']>prev['departed_at'] and e['stop']==(121 if r['stop']==11 else 11) for e in known_anchors(r['bus'],r['a'])):reason='no observed intervening opposite stop'
  else:
   after=[v for v in ds if v['bus_name']!=r['bus'] and v['departed_at']>prev['departed_at']]
   if not after:reason='no confirmed follower yet'
   else:
    chosen=min(after,key=lambda v:v['departed_at']);same=[v for v in after if v['departed_at']==chosen['departed_at']]
    if len({v['bus_name']for v in same})>1:reason='departure order tie'
    else:
     # Identity comes from the original following departure; origin uses its
     # latest already-known source departure, including observable overtaking.
     origin=max([v for v in ds if v['bus_name']==chosen['bus_name']],key=lambda v:v['departed_at'])
     p=dict(bus=chosen['bus_name'],selectedId=chosen['id'],origin=origin['departed_at'],originId=origin['id'],known=chosen['known'],selectionDeparture=chosen['departed_at'],ownPrevious=prev['id'])
 else:
  candidates=[((index[r['stop']]-e['index'])%N,b,e)for b,e in fresh.items()]
  if detail['coLocated']:reason='same-stop ordering ambiguous'
  elif not candidates:reason='no fresh other-bus stop anchor'
  else:
   candidates.sort();gap,b,e=candidates[0]
   if sum(q[0]==gap for q in candidates)>1:reason='nearest stop-index tie'
   else:
    origin=max([v for v in ds if v['bus_name']==b],key=lambda v:v['departed_at'],default=None)
    p=dict(bus=b,selectedId=e['id'],origin=origin['departed_at']if origin else None,originId=origin['id']if origin else None,known=e['known'],selectionDeparture=None)
 if p:
  e=latest_anchor(p['bus'],r['a'],600000)
  p['initialBackwardStops']=(index[r['stop']]-e['index'])%N if e else None
  p['sameAsAhead']=r['predecessor'] is not None and r['predecessor']['bus']==p['bus']
  assert p['known']<=r['a'] and (p['origin'] is None or p['origin']<=r['a']) and p['bus']!=r['bus']
 return p,dict(reason=reason,**detail)
for r in rows:
 r['followers']={};r['followerSelection']={}
 for mode in IDENTITIES:r['followers'][mode],r['followerSelection'][mode]=follower(r,mode)

def peer_history(p,at,reg,kind,origin=None,recent=None):
 if not p:return []
 es=events[reg].get((p['bus'],kind),[]);ts=times[reg].get((p['bus'],kind),[])
 hi=bisect.bisect_right(ts,at);lo=0 if recent is None else bisect.bisect_left(ts,at-recent)
 return [e for e in es[lo:hi]if day(e['physical'])==day(at) and (origin is None or e['physical']>=origin)]
def ahead_addition(r,at,reg):
 p=r['predecessor'];flags=np.zeros(N)
 if p:
  for e in peer_history(p,at,reg,'arrival',p['departedAt']):flags[e['index']]=1
 phase=2*np.pi*(r['hour']*3600+(at-r['a'])/1000+STEP/2)/900
 return np.r_[[float(p is not None),p['gapSec']/600 if p else 0],flags,np.zeros(N),flags*np.sin(phase),flags*np.cos(phase)]
ahead=json.loads((D/'ahead-trigger-barrier.json').read_text())
aheadFits={(f['regime'],f['sourceStop']):f for f in ahead['fits'] if f['arm']=='reached_clock_interactions'}

def features(r,p,at,reg):
 origin=p['origin']if p else None
 ctrl=[float(p is not None),float(origin is not None),(r['a']-origin)/3600000 if origin is not None else 0,
       p['initialBackwardStops']/N if p and p['initialBackwardStops'] is not None else 0]
 progress=peer_history(p,at,reg,'progress',origin)
 latest=progress[-1]if progress else None
 phi=2*np.pi*(r['hour']*3600+(at-r['a'])/1000+STEP/2)/900
 angle=2*np.pi*((latest['index']-index[r['stop']])%N)/N if latest else 0
 dyn=np.array([float(latest is not None),math.sin(angle)if latest else 0,math.cos(angle)if latest else 0,
       min(6,math.log1p((at-latest['physical'])/60000))if latest else 0])
 pulse=np.zeros(N);reached=np.zeros(N)
 for e in peer_history(p,at,reg,'arrival',recent=120000):pulse[e['index']]=1
 if origin is not None:
  for e in peer_history(p,at,reg,'arrival',origin):reached[e['index']]=1
 return np.r_[ctrl,dyn,dyn*np.sin(phi),dyn*np.cos(phi),pulse,reached,reached*np.sin(phi),reached*np.cos(phi)]
colsByArm={'baseline':[],'identity_controls':list(range(4)),'progress':list(range(8)),
 'progress_clock':list(range(16)),'arrival_pulses':list(range(4))+list(range(16,16+N)),
 'reached':list(range(4))+list(range(16+N,16+2*N)),
 'reached_clock':list(range(4))+list(range(16+N,16+4*N))}
fits=[];scores=[];perEpisode=[];support=[]
for mode in IDENTITIES:
 for reg in REGIMES:
  bundles=[]
  for r in rows:
   bins=max(1,math.ceil(r['y']/STEP));ages=np.arange(bins)*STEP;ats=r['a']+ages*1000
   x=np.vstack([features(r,r['followers'][mode],at,reg)for at in ats]);y=np.zeros(bins);y[-1]=1
   off=base_design(r,ages+STEP/2)@coefs[r['stop']]
   fit=aheadFits[reg,r['stop']];ax=np.vstack([ahead_addition(r,at,reg)for at in ats])
   aheadOff=off+ax[:,fit['columns']]@np.array(fit['coefficients'])
   bundles.append(dict(r=r,X=x,y=y,offsets={'lap_clock':off,'lap_clock_ahead':aheadOff}))
  for stop in [11,121]:
   groups={s:[b for b in bundles if b['r']['stop']==stop and (b['r']['ready']<FIT if s=='train'else b['r']['a']>=FIT and b['r']['ready']<TEST if s=='calibration'else b['r']['a']>=TEST)]for s in ['train','calibration','development']}
   tx=np.vstack([b['X']for b in groups['train']]);yy=np.concatenate([b['y']for b in groups['train']])
   eligible=[]
   for col in range(tx.shape[1]):
    hit=[b['r']for b in groups['train']if np.any(abs(b['X'][:,col])>1e-10)]
    if col<16 or len(hit)>=5 and len({r['day']for r in hit})>=2:eligible.append(col)
   support.append(dict(identity=mode,regime=reg,stop=stop,split={s:dict(n=len(bs),known=sum(b['r']['followers'][mode]is not None for b in bs),sameAsAhead=sum(bool(b['r']['followers'][mode] and b['r']['followers'][mode]['sameAsAhead'])for b in bs),reasons=dict(collections.Counter(b['r']['followerSelection'][mode]['reason']for b in bs)))for s,bs in groups.items()}))
   for offsetName in OFFSETS:
    off=np.concatenate([b['offsets'][offsetName]for b in groups['train']])
    for arm in ARMS:
     cols=[]
     for col in colsByArm[arm]:
      if col in eligible and not any(np.array_equal(tx[:,col],tx[:,other])for other in cols):cols.append(col)
     X=tx[:,cols]
     if cols:
      def objective(co):
       z=off+X@co
       return float((np.logaddexp(0,z)-yy*z).sum()+.5*PENALTY*(co@co)),X.T@(expit(z)-yy)+PENALTY*co
      opt=minimize(objective,np.zeros(len(cols)),jac=True,method='L-BFGS-B',options={'maxiter':1500,'gtol':1e-8});assert opt.success,opt.message;co=opt.x
     else:co=np.zeros(0)
     cz=np.concatenate([b['offsets'][offsetName]+b['X'][:,cols]@co for b in groups['calibration']]);cy=np.concatenate([b['y']for b in groups['calibration']])
     intercept=brentq(lambda v:float((expit(cz+v)-cy).sum()),-20,20)
     key=dict(identity=mode,regime=reg,stop=stop,offset=offsetName,arm=arm)
     fits.append(dict(**key,columns=cols,coefficients=co.tolist(),calibrationIntercept=intercept))
     for calibrated in [False,True]:
      hs=[]
      for b in groups['development']:
       r=b['r'];p=r['followers'][mode];z=b['offsets'][offsetName]+b['X'][:,cols]@co+(intercept if calibrated else 0);prob=expit(z);y=b['y']
       hs.append(dict(id=r['id'],bus=r['bus'],day=r['day'],known=p is not None,sameAsAhead=bool(p and p['sameAsAhead']),riskBins=len(y),logLoss=float((np.logaddexp(0,z)-y*z).sum()),brier=float(((prob-y)**2).mean())))
      perEpisode.append(dict(**key,calibrated=calibrated,episodes=hs))
      for group in ['all','known','unknown','same_as_ahead','distinct_from_ahead']+sorted({h['day']for h in hs}):
       ss=[h for h in hs if group=='all' or group=='known' and h['known'] or group=='unknown' and not h['known'] or group=='same_as_ahead' and h['known'] and h['sameAsAhead'] or group=='distinct_from_ahead' and h['known'] and not h['sameAsAhead'] or h['day']==group]
       if ss:scores.append(dict(**key,calibrated=calibrated,group=group,n=len(ss),dates=len({h['day']for h in ss}),meanLogLossPerHold=statistics.mean(h['logLoss']for h in ss),meanBrierPerHold=statistics.mean(h['brier']for h in ss)))
  print('Finished',mode,reg,flush=True)
# Confirm that introducing the fixed ahead offset reproduces the saved result.
for reg in REGIMES:
 for stop in [11,121]:
  got=next(s for s in scores if s['identity']=='departure_order' and s['regime']==reg and s['stop']==stop and s['offset']=='lap_clock_ahead' and s['arm']=='baseline' and not s['calibrated'] and s['group']=='all')
  expected=next(s for s in ahead['scores']if s['regime']==reg and s['stop']==stop and s['arm']=='reached_clock_interactions' and not s['calibrated'] and s['group']=='all')
  assert abs(got['meanLogLossPerHold']-expected['meanLogLossPerHold'])<1e-9,(got,expected)
out=dict(method=DOC,plan=PLAN,support=support,fits=fits,scores=scores,perEpisode=perEpisode,
 identityRows=[{k:r[k]for k in ['id','bus','stop','a','d','ready','day','predecessor','followers','followerSelection']}for r in rows],
 limitations=['All developmental results, not untouched confirmation. No future follower path in a forward ETA.','Stop visibility uses timestamp proxies, not exact receipt logs. Stop-order sensitivity uses sparse discrete topology, not precise position or predicted arrival.','Latched follower order can differ from actual present order; overtaking and a two-bus loop can make the ahead/behind identities identical. All corresponding strata retained.','Completion-based cohort and risk bins share buses/days; these are component hazards, not rider ETA or connection scores.','No legitimate short/long waits removed; same audited source cohort and old development cutoff.'],
 inputHashes={p.name:hashlib.sha256(p.read_bytes()).hexdigest()for p in [initial,OP,BASE,D/'ahead-trigger-barrier.json',planPath,Path(__file__)]})
(D/'follower-progress-screen.json').write_text(json.dumps(out,indent=2)+'\n')
for s in scores:
 if s['group']=='all' and not s['calibrated']:print(json.dumps(s))
