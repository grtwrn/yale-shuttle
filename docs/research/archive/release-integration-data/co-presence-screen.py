"""Exploratory same-stop Red interactions; old development data only.
Stop-zone arrival visibility = unconditional anchor+15s; departure = endpoint+5s+confirmation.
These are causal-availability approximations, not receipt-time reconstructions.
Completed and passed peer visits both count; no future peer outcome as a feature.
"""
import collections,datetime,json,math,pathlib,sqlite3
import numpy as np
from scipy.optimize import minimize
from scipy.special import expit
D=pathlib.Path(__file__).resolve().parent;R=D.parent
cut=1789665240913
source=json.loads((R/'red-window-data/operating-pattern-screen.json').read_text())
original=json.loads((R/'red-window-data/release-survival-screen.json').read_text())
rows=[r for r in source['featureRows'] if r['ready']<=cut]
FIT=1789012800000 # Sep10 04:00Z
TEST=1789358400000 # Sep14 04:00Z
assert datetime.datetime.fromtimestamp(FIT/1000,datetime.timezone.utc).isoformat().startswith('2026-09-10')
db=sqlite3.connect('file:'+str(R/'conditional-replay-data/outcomes.db')+'?mode=ro',uri=True);db.row_factory=sqlite3.Row
visits=[dict(v) for v in db.execute("select * from stop_visits where route_id=3 and stop_id in (11,121) and anchored_at<=? and how!='gap' and closest_m<=75",(cut,))]
for v in visits:
 v['knownArrival']=v['anchored_at']+15000
 v['knownDeparture']=max(v['knownArrival'],v['departed_at']+5000+max(15,v['confirm_sec']or 0)*1000) if v['departed_at'] is not None else math.inf
FEATURES=['earlier_peer_present','later_peer_present','peer_reached_last_120s','peer_left_last_120s']
results=[];events=[]
for stop in [11,121]:
 ref=next(s['referenceLap'] for s in source['results'] if s['stop']==stop)
 xx=[];zz=[];yy=[];meta=[]
 for r in rows:
  if r['stop']!=stop:continue
  peers=[v for v in visits if v['stop_id']==stop and v['bus_name']!=r['bus'] and r['a']-3600000<v['anchored_at']<r['d']+120000]
  available=r['lap']is not None and .65*ref<=r['lap']<=1.65*ref
  bins=max(1,math.ceil(r['y']/15))
  for i in range(bins):
   t=(i+.5)*15;at=r['a']+i*15000
   angle=2*math.pi*(r['hour']*3600+t)/900
   x=[1,math.log1p(t/60),t/600,max(t-300,0)/600,max(t-600,0)/600,(r['lap']-ref)/600 if available else 0,float(not available),math.sin(angle),math.cos(angle)]
   present=[v for v in peers if v['knownArrival']<=at<v['knownDeparture']]
   z=[any(v['knownArrival']<r['a'] for v in present),any(v['knownArrival']>=r['a'] for v in present),any(0<=at-v['knownArrival']<120000 for v in peers),any(0<=at-v['knownDeparture']<120000 for v in peers)]
   xx.append(x);zz.append(z);yy.append(int(i==bins-1));meta.append(dict(id=r['id'],day=r['day'],at=at,ready=r['ready'],a=r['a'],age=i*15))
   if any(z):events.append(dict(stop=stop,bus=r['bus'],**meta[-1],features=z,departureNextBin=yy[-1]))
 X=np.array(xx);Z=np.array(zz,dtype=float);y=np.array(yy)
 train=np.array([m['ready']<FIT for m in meta]);test=np.array([m['a']>=TEST for m in meta]);cal=np.array([m['a']>=FIT and m['ready']<TEST for m in meta])
 arms={};testPred={}
 for arm,A in [('baseline',X),('peer_interactions',np.c_[X,Z])]:
  penalty=np.r_[0,np.full(8,4),np.full(A.shape[1]-9,10)]
  def loss(b):
   q=A[train]@b
   return float(np.sum(np.logaddexp(0,q)-y[train]*q)+.5*np.sum(penalty*b*b)),A[train].T@(expit(q)-y[train])+penalty*b
  initial=np.zeros(A.shape[1]);initial[0]=math.log(y[train].mean()/(1-y[train].mean()))
  fit=minimize(loss,initial,jac=True,method='L-BFGS-B',options={'maxiter':1000,'gtol':1e-8});assert fit.success,fit.message
  p=expit(A@fit.x);testPred[arm]=p
  def score(mask):
   q=np.clip(p[mask],1e-12,1-1e-12);v=y[mask]
   return dict(bins=int(mask.sum()),visits=len({m['id']for m,yes in zip(meta,mask)if yes}),departures=int(v.sum()),meanPredicted=float(q.mean())if len(q)else None,eventRate=float(v.mean())if len(v)else None,logLoss=float(-(v*np.log(q)+(1-v)*np.log1p(-q)).mean())if len(q)else None,brier=float(((q-v)**2).mean())if len(q)else None)
  arms[arm]=dict(coefficients=fit.x.tolist(),test=score(test),testByDay={day:score(test&np.array([m['day']==day for m in meta]))for day in sorted({m['day']for m,yes in zip(meta,test)if yes})},exposedTest=score(test&Z.any(axis=1)))
 exposure={}
 for j,label in enumerate(FEATURES):
  exposure[label]={}
  for labelSplit,mask in [('train',train),('cal',cal),('test',test)]:
   hit=mask&(Z[:,j]>0)
   exposure[label][labelSplit]=dict(bins=int(hit.sum()),visits=len({m['id']for m,yes in zip(meta,hit)if yes}),departures=int(y[hit].sum()),expectedUnderBaseline=float(testPred['baseline'][hit].sum()))
 results.append(dict(stop=stop,arms=arms,exposure=exposure))
# Distinct co-locations, using physical overlap only for descriptive validation.
encounters=[]
for i,a in enumerate(visits):
 if a['departed_at']is None:continue
 for b in visits[i+1:]:
  if a['stop_id']!=b['stop_id']or a['bus_name']==b['bus_name']or b['departed_at']is None:continue
  start=max(a['pinned_at']or a['anchored_at'],b['pinned_at']or b['anchored_at']);end=min(a['departed_at'],b['departed_at'])
  if end<=start:continue
  earlier,later=sorted([a,b],key=lambda v:v['pinned_at']or v['anchored_at'])
  encounters.append(dict(stop=a['stop_id'],earlierId=earlier['id'],laterId=later['id'],earlierBus=earlier['bus_name'],laterBus=later['bus_name'],metAt=start,overlapSec=(end-start)/1000,earlierLeavesSecAfterMeet=(earlier['departed_at']-start)/1000,laterLeavesSecAfterMeet=(later['departed_at']-start)/1000,departureGapSec=abs(a['departed_at']-b['departed_at'])/1000,outcomes=[a['outcome'],b['outcome']]))
out=dict(method=__doc__,cutoff=cut,features=FEATURES,fitBefore=FIT,testAfter=TEST,limitations=['Exploratory development replay, no reservedafternoon data.','Modern event times plus assumed visibility delays; not exact reception logs.','Co-presence is not proof drivers coordinate; elapsedwait/lap/clock controlled but traffic and unobserved dispatch confound.','Risk bins within visits are dependent; counts are not independent sample sizes.','Long waits and real short waits retained; single independently verified restart truncation follows original curated source.'],results=results,encounters=encounters,exposedEvents=events)
(D/'co-presence-screen.json').write_text(json.dumps(out,indent=2)+'\n')
for r in results:
 print('STOP',r['stop'])
 for arm,v in r['arms'].items():print(arm,v['test'],'exposed',v['exposedTest'])
 print('EXPOSURE',r['exposure'])
print('encounters',len(encounters));print(encounters[:15])
