"""Post-first-screen mechanistic extension: persistent reached/cleared barriers.

All stops jointly; no development-selected stop. Fixed L2=10, same chronological
splits and one-step outcome. This is an exploratory extension, not prespecified
before the first pulse-screen results. Reserved afternoon recordings excluded.
"""
BARRIER_DOC=__doc__
import ast
from pathlib import Path
initial=Path(__file__).with_name('ahead-trigger-screen.py')
tree=ast.parse(initial.read_text());prefix=[]
for node in tree.body:
 if isinstance(node,ast.Assign)and any(isinstance(t,ast.Name)and t.id=='datasets'for t in node.targets):break
 prefix.append(node)
exec(compile(ast.Module(body=prefix,type_ignores=[]),str(initial),'exec'))
NEW_ARMS=['reached_barrier','cleared_barrier','reached_clock_interactions']
extension=dict(createdAtUTC=datetime.datetime.now(datetime.timezone.utc).isoformat(),arms=NEW_ARMS,
  motivation='User says wait UNTIL predecessor reaches X: latch already-observed events from its selected prior-source departure, rather than only recent120s pulses.',
  postFirstScreen=True,penalty=PENALTY,features='Presence/headway controls plus all-stop reached or cleared flags; final family also interacts reached flags with first-harmonic current15min clock.',
  noForwardLeakage='Latch uses event known<=risk-bin start and physical event>=selected already-confirmed predecessor source departure. Never uses whether predecessor eventually serves another stop.',
  selection='Support at least5trainingepisodes and2trainingdates; exact duplicate training columns collapsed; all family results reported.')
planPath=D/'ahead-trigger-barrier-plan.json'
if not planPath.exists():planPath.write_text(json.dumps(extension,indent=2)+'\n')
else:
 old=json.loads(planPath.read_text());assert all(old[k]==v for k,v in extension.items()if k!='createdAtUTC')
 extension=old
fits=[];scores=[];perEpisode=[]
for reg in REGIMES:
 bundles=[]
 for r in rows:
  bins=max(1,math.ceil(r['y']/STEP));age=np.arange(bins)*STEP;xx=[];pp=r['predecessor']
  for elapsed in age:
   at=r['a']+elapsed*1000;ctrl=[float(pp is not None),pp['gapSec']/600 if pp else 0];flags=[]
   for kind in ['arrival','clearance']:
    f=np.zeros(N)
    if pp:
     es=events[reg].get((pp['bus'],kind),[]);ts=times[reg].get((pp['bus'],kind),[]);hi=bisect.bisect_right(ts,at)
     for e in es[:hi]:
      if e['physical']>=pp['departedAt'] and day(e['physical'])==r['day']:f[e['index']]=1
    flags.append(f)
   phi=2*np.pi*(r['hour']*3600+elapsed+STEP/2)/900
   xx.append(ctrl+flags[0].tolist()+flags[1].tolist()+(flags[0]*math.sin(phi)).tolist()+(flags[0]*math.cos(phi)).tolist())
  y=np.zeros(bins);y[-1]=1
  bundles.append(dict(r=r,X=np.array(xx),offset=base_design(r,age+STEP/2)@coefs[r['stop']],y=y))
 for stop in [11,121]:
  groups={s:[b for b in bundles if b['r']['stop']==stop and (b['r']['ready']<FIT if s=='train'else b['r']['a']>=FIT and b['r']['ready']<TEST if s=='calibration'else b['r']['a']>=TEST)]for s in ['train','calibration','development']}
  allX=np.vstack([b['X']for b in groups['train']]);eligible=[]
  for col in range(2+4*N):
   touched=[b['r']for b in groups['train']if np.any(abs(b['X'][:,col])>1e-10)]
   if col<2 or len(touched)>=5 and len({r['day']for r in touched})>=2:eligible.append(col)
  colsByArm={'reached_barrier':[0,1]+list(range(2,2+N)),
             'cleared_barrier':[0,1]+list(range(2+N,2+2*N)),
             'reached_clock_interactions':[0,1]+list(range(2,2+N))+list(range(2+2*N,2+4*N))}
  for arm in NEW_ARMS:
   cols=[]
   for c in colsByArm[arm]:
    if c in eligible and not any(np.array_equal(allX[:,c],allX[:,k])for k in cols):cols.append(c)
   X=allX[:,cols];off=np.concatenate([b['offset']for b in groups['train']]);y=np.concatenate([b['y']for b in groups['train']])
   def obj(co):
    z=off+X@co
    return float((np.logaddexp(0,z)-y*z).sum()+.5*PENALTY*(co@co)),X.T@(expit(z)-y)+PENALTY*co
   opt=minimize(obj,np.zeros(len(cols)),jac=True,method='L-BFGS-B',options={'maxiter':1500,'gtol':1e-8});assert opt.success,opt.message
   co=opt.x;cz=np.concatenate([b['offset']+b['X'][:,cols]@co for b in groups['calibration']]);cy=np.concatenate([b['y']for b in groups['calibration']])
   intercept=brentq(lambda v:float((expit(cz+v)-cy).sum()),-20,20)
   fits.append(dict(regime=reg,sourceStop=stop,arm=arm,columns=cols,coefficients=co.tolist(),calibrationIntercept=intercept))
   for calibrated in [False,True]:
    hs=[]
    for b in groups['development']:
     r=b['r'];z=b['offset']+b['X'][:,cols]@co+(intercept if calibrated else 0);p=expit(z);y=b['y']
     hs.append(dict(id=r['id'],day=r['day'],hasPredecessor=r['predecessor']is not None,riskBins=len(y),logLoss=float((np.logaddexp(0,z)-y*z).sum()),brier=float(((p-y)**2).mean()),expectedDepartures=float(p.sum())))
    perEpisode.append(dict(regime=reg,stop=stop,arm=arm,calibrated=calibrated,episodes=hs))
    for group in ['all']+sorted({h['day']for h in hs}):
     ss=[h for h in hs if group=='all'or h['day']==group]
     scores.append(dict(regime=reg,stop=stop,arm=arm,calibrated=calibrated,group=group,n=len(ss),meanLogLossPerHold=statistics.mean(h['logLoss']for h in ss),meanBrierPerHold=statistics.mean(h['brier']for h in ss),pooledBrier=sum(h['brier']*h['riskBins']for h in ss)/sum(h['riskBins']for h in ss),expectedDepartures=sum(h['expectedDepartures']for h in ss)))
out=dict(method=BARRIER_DOC,extension=extension,fits=fits,scores=scores,perEpisodeScores=perEpisode,initialPlan=plan,
 limitations=['Sparse stop events may miss an intermediate crossing. This is an observed-event latch, not a guaranteed physical threshold crossing.',
 'Relative order is fixed at focal pin; overtaking and same-stop co-presence are not represented.',
 'All columns are regularized; a weak average result does not rule out a conditional dispatch rule with a different predecessor, landmark, clock regime or mode.',
 'Causal receipt remains approximated; completed120s can remove immediate-trigger information. No remaining-time or rider-safety claim.'],
 inputHashes={p.name:hashlib.sha256(p.read_bytes()).hexdigest()for p in [initial,OP,BASE,planPath,Path(__file__)]})
(D/'ahead-trigger-barrier.json').write_text(json.dumps(out,indent=2)+'\n')
print(json.dumps([s for s in scores if s['group']=='all'],indent=2))
