"""Follow-up: one pin-time CDF calibration, then condition on surviving the wait.
Added after the per-elapsed calibration coherence issue was found. This is a
retrospective sensitivity experiment, not untouched model selection.
"""
import datetime, hashlib, json, pathlib
import numpy as np
from scipy.special import expit
from zoneinfo import ZoneInfo

D=pathlib.Path(__file__).resolve().parent
x=json.loads((D/'release-survival-screen.json').read_text())
source=json.loads((D/'operating-pattern-screen.json').read_text())
rows=source['featureRows']; TZ=ZoneInfo('America/New_York')
cut=lambda s:datetime.datetime.fromisoformat(s).replace(tzinfo=TZ).timestamp()*1000
FIT,TEST=cut('2026-09-10'),cut('2026-09-14')
ARM='hazard_age_lap_clock15';STEP=15;GRID=np.arange(0,3615,15,dtype=float)
AGES=[0,120,300,480]; LEVELS=np.array([0,.1,.25,.5,.75,.9,1])

def metric(rs):
 e=np.array([r['point']-r['truth']for r in rs]);w=np.array([r['high']-r['low']for r in rs])
 early=np.array([max(0,r['low']-r['truth'])for r in rs]);late=np.array([max(0,r['truth']-r['high'])for r in rs])
 return dict(n=len(rs),mae=float(np.abs(e).mean()),medianAbs=float(np.median(np.abs(e))),p90Abs=float(np.quantile(np.abs(e),.9)),
     width=float(w.mean()),WIS=float((.5*np.abs(e)+.1*w+early+late).mean()/1.5),
     early=int(sum(early>0)),late=int(sum(late>0)),signed=float(e.mean()))

predictions=[];maps=[];stability=[]
for stop in[11,121]:
 ref=next(r['referenceLap']for r in source['results']if r['stop']==stop)
 co=np.array(next(r['coefficients']for r in x['fits']if r['stop']==stop and r['arm']==ARM))
 rs=[r for r in rows if r['stop']==stop];ca=[r for r in rs if r['a']>=FIT and r['ready']<TEST];te=[r for r in rs if r['a']>=TEST]
 cdfs={}
 for r in ca+te:
  available=r['lap']is not None and .65*ref<=r['lap']<=1.65*ref
  t=GRID[1:]-STEP/2; phase=2*np.pi*(r['hour']*3600+t)/900
  X=np.stack([np.ones_like(t),np.log1p(t/60),t/600,np.maximum(t-300,0)/600,np.maximum(t-600,0)/600,
      np.full_like(t,(r['lap']-ref)/600 if available else 0),np.full_like(t,float(not available)),np.sin(phase),np.cos(phase)],axis=-1)
  h=np.clip(expit(X@co),1e-9,1-1e-9);cdfs[r['id']]=np.r_[0,-np.expm1(np.cumsum(np.log1p(-h)))]
 pits=[float(np.interp(r['y'],GRID,cdfs[r['id']]))for r in ca]
 knots=np.r_[0,np.quantile(pits,LEVELS[1:-1]),1]
 assert np.all(np.diff(knots)>0)
 maps.append(dict(stop=stop,n=len(ca),inputLevels=knots.tolist(),outputLevels=LEVELS.tolist(),calibrationIds=[r['id']for r in ca]))
 for r in te:
  raw=cdfs[r['id']]
  coherent=np.interp(raw,knots,LEVELS)
  for name,f in[('raw',raw),('coherent',coherent)]:
   last=None;drop=0;up60=0;maxup=0
   for age in range(0,min(900,int(np.ceil(r['y']))),STEP):
    old=np.interp(age,GRID,f);fc=np.clip((np.interp(age+GRID,GRID,f)-old)/max(1-old,1e-12),0,1)
    q=np.interp([.1,.5,.9],fc,GRID)+age
    if last is not None:
     drop+=int(np.any(q<last-1));up60+=int(q[1]-last[1]>60);maxup=max(maxup,float(q[1]-last[1]))
    last=q
   stability.append(dict(id=r['id'],stop=stop,arm=name,quantileBackwardsUpdates=drop,absolutePointUp60=up60,maxAbsolutePointUp=maxup))
   for age in AGES:
    if r['y']<=age:continue
    old=np.interp(age,GRID,f);fc=np.clip((np.interp(age+GRID,GRID,f)-old)/max(1-old,1e-12),0,1)
    lo,p,hi=np.interp([.1,.5,.9],fc,GRID)
    predictions.append(dict(id=r['id'],stop=stop,day=r['day'],age=age,arm=name,truth=r['y']-age,low=float(lo),point=float(p),high=float(hi)))
   # Check the raw distribution against the earlier saved results.
   if name=='raw':
    prior={p['age']:p for p in x['predictions']if p['id']==r['id'] and p['arm']==ARM and not p['calibrated']}
    for p in predictions:
     if p['id']==r['id'] and p['arm']==name:
      assert all(abs(p[k]-prior[p['age']][k])<1e-7 for k in['low','point','high'])
scores=[]
for stop in[11,121]:
 for age in AGES:
  for arm in['raw','coherent']:
   rs=[r for r in predictions if(r['stop'],r['age'],r['arm'])==(stop,age,arm)]
   scores.append(dict(stop=stop,age=age,arm=arm,summary=metric(rs),byDate={d:metric([r for r in rs if r['day']==d])for d in sorted({r['day']for r in rs})}))
out=dict(method=__doc__,modelSha256=hashlib.sha256((D/'release-survival-screen.json').read_bytes()).hexdigest(),
    candidate=ARM,probabilityKnots=LEVELS.tolist(),maps=maps,scores=scores,predictions=predictions,stability=stability,
    limitations=['Calibration fit from58/61 complete held visits across2days, so conditional coverage is not guaranteed.',
        'Coherent refers to one fixed visit CDF under continued survival only, not live state/filter/departure transitions.',
        'Early-tail errors and date changes remain; no assumption of normally distributed arrivals or hard scheduled slots.'])
(D/'release-coherent-calibration.json').write_text(json.dumps(out,indent=2)+'\n')
for r in scores:print(r['stop'],r['age'],r['arm'],{k:round(v,1)for k,v in r['summary'].items()})
for stop in[11,121]:
 for arm in['raw','coherent']:
  rs=[r for r in stability if r['stop']==stop and r['arm']==arm]
  print('stability',stop,arm,'backwards',sum(r['quantileBackwardsUpdates']for r in rs),'up60',sum(r['absolutePointUp60']for r in rs))
