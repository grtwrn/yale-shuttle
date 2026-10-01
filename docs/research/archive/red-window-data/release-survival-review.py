"""Read-only numerical and sequential audit of the five-arm survival screen."""
import collections,hashlib,json,math,pathlib,statistics
import numpy as np
from scipy.special import expit
D=pathlib.Path(__file__).resolve().parent;P=D/'release-survival-screen-five-arms.json';x=json.loads(P.read_text());s=json.loads((D/'operating-pattern-screen.json').read_text());rows={r['id']:r for r in s['featureRows']};models={r['stop']:r for r in s['results']}
assert x['inputSha256']==hashlib.sha256((D/'operating-pattern-screen.json').read_bytes()).hexdigest()
fits={(r['stop'],r['arm']):r for r in x['fits']};cal={(r['stop'],r['arm'],r['age']):r for r in x['calibration']};STEP=x['spec']['step'];GRID=np.arange(0,x['spec']['horizon']+STEP,STEP,dtype=float)
def metrics(rs):
 if not rs:return {'n':0}
 ae=[abs(r['point']-r['truth'])for r in rs]
 return dict(n=len(rs),MAE=statistics.mean(ae),WIS=statistics.mean((.5*abs(r['point']-r['truth'])+.1*(r['high']-r['low'])+max(0,r['low']-r['truth'])+max(0,r['truth']-r['high']))/1.5 for r in rs),early=sum(r['truth']<r['low']for r in rs),late=sum(r['truth']>r['high']for r in rs),over120=sum(r['point']-r['truth']>120 for r in rs),width=statistics.mean(r['high']-r['low']for r in rs))
for r in x['predictions']:
 assert r['id'] in rows and r['truth']==rows[r['id']]['y']-r['age'] and r['truth']>0
 assert 0<=r['low']<=r['point']<=r['high']
for z in x['scores']:
 rr=[r for r in x['predictions']if all(r[k]==z[k]for k in ['stop','arm','age','calibrated'])];m=metrics(rr)
 assert m['n']==z['summary']['n'] and abs(m['MAE']-z['summary']['mae'])<1e-8 and abs(m['WIS']-z['summary']['WIS'])<1e-8
support=[]
for z in x['scores']:
 if not z['calibrated']:continue
 rr=[r for r in x['predictions']if all(r[k]==z[k]for k in ['stop','arm','age','calibrated'])]
 support.append(dict(stop=z['stop'],arm=z['arm'],age=z['age'],supported=metrics([r for r in rr if r['lapAvailable']]),missingLap=metrics([r for r in rr if not r['lapAvailable']])))

def cdf(r,arm):
 fit=fits[(r['stop'],arm)];ref=models[r['stop']]['referenceLap'];valid=r['lap']is not None and .65*ref<=r['lap']<=1.65*ref
 if arm.endswith('_residual'):
  co=fit['coefficients'];vec=[1,(r['lap']-ref)/600]if valid else None
  if valid and 'clock15'in arm:vec += [math.sin(2*math.pi*r['hour']*60/15),math.cos(2*math.pi*r['hour']*60/15)]
  tr=[v for v in rows.values()if v['stop']==r['stop']and v['day']<'2026-09-10']
  # Every selected preSep10 source completes that day, already checked by parent.
  center=max(0,float(np.array(vec)@co))if valid else statistics.median(v['y']for v in tr)
  f=expit((GRID[:,None]-center-np.array(fit['residuals'])[None,:])/x['spec']['residualBandwidth']).mean(axis=1)
  return (f-f[0])/(1-f[0])
 t=GRID[1:]-STEP/2;lap=(r['lap']-ref)/600 if valid else 0
 cols=[np.ones_like(t),np.log1p(t/60),t/600,np.maximum(t-300,0)/600,np.maximum(t-600,0)/600,np.full_like(t,lap),np.full_like(t,float(not valid))]
 if 'clock15'in arm:
  phase=2*np.pi*(r['hour']*3600+t)/900;cols += [np.sin(phase),np.cos(phase)]
  if arm.endswith('_h2'):cols += [np.sin(2*phase),np.cos(2*phase)]
 h=np.clip(expit(np.stack(cols,axis=-1)@np.array(fit['coefficients'])),1e-9,1-1e-9)
 return np.r_[0,-np.expm1(np.cumsum(np.log1p(-h)))]
def remaining(f,age):
 old=np.interp(age,GRID,f);return np.clip((np.interp(age+GRID,GRID,f)-old)/max(1-old,1e-12),0,1)
sequential=[];predictionLookup={(r['id'],r['arm'],r['age'],r['calibrated']):r for r in x['predictions']}
for r in rows.values():
 if r['day']<'2026-09-14':continue
 for arm in x['spec']['arms']:
  f=cdf(r,arm);assert np.all(np.diff(f)>=-1e-12)
  for age in x['spec']['ages']:
   if r['y']<=age:continue
   fc=remaining(f,age)
   for calibrated in [False,True]:
    levels=cal[r['stop'],arm,age]['levels']if calibrated else [.1,.5,.9]
    values=np.interp(levels,fc,GRID);expected=predictionLookup[r['id'],arm,age,calibrated]
    assert max(abs(values[i]-expected[k])for i,k in enumerate(['low','point','high']))<1e-7,(r['id'],arm,age,calibrated,values,[expected[k]for k in ['low','point','high']])
  for calibrated in [False,True]:
   totals=[]
   for age in np.arange(0,min(r['y'],900),STEP):
    levels=[np.interp(age,x['spec']['ages'],[cal[r['stop'],arm,a]['levels'][i]for a in x['spec']['ages']])for i in range(3)]if calibrated else [.1,.5,.9]
    totals.append(age+np.interp(levels,remaining(f,age),GRID))
   delta=np.diff(np.array(totals),axis=0)
   if not len(delta):continue
   sequential.append(dict(id=r['id'],stop=r['stop'],arm=arm,calibrated=calibrated,updates=len(delta),absolutePointUp60=int(sum(delta[:,1]>60)),absolutePointUp120=int(sum(delta[:,1]>120)),maxAbsolutePointUp=float(max(delta[:,1])),pointTotalDropsOver1s=int(sum(delta[:,1]<-1)),lowTotalDropsOver1s=int(sum(delta[:,0]<-1)),highTotalDropsOver1s=int(sum(delta[:,2]<-1)),mostNegativeTotalDelta=[float(min(delta[:,i]))for i in range(3)]))
summary=[]
for arm in x['spec']['arms']:
 for calibrated in[False,True]:
  rr=[r for r in sequential if r['arm']==arm and r['calibrated']==calibrated]
  summary.append(dict(arm=arm,calibrated=calibrated,episodes=len(rr),updates=sum(r['updates']for r in rr),pointUp60=sum(r['absolutePointUp60']for r in rr),pointUp120=sum(r['absolutePointUp120']for r in rr),maxPointUp=max(r['maxAbsolutePointUp']for r in rr),pointDropsOver1s=sum(r['pointTotalDropsOver1s']for r in rr),episodesWithPointDrop=len({r['id']for r in rr if r['pointTotalDropsOver1s']}),lowDropsOver1s=sum(r['lowTotalDropsOver1s']for r in rr),highDropsOver1s=sum(r['highTotalDropsOver1s']for r in rr)))
report=dict(method=__doc__,inputSha256=hashlib.sha256(P.read_bytes()).hexdigest(),checks='All forecast truth/eligibility, scores, CDF monotonicity and every saved quantile reproduced from saved fit coefficients; no refitting or changes to parent data.',supportScores=support,sequentialSummary=summary,sequentialRows=sequential,tailMax=max(r['remainingTail']for r in x['predictions']))
(D/'release-survival-review.json').write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps(summary,indent=2))
