"""Exploratory point-forecast hour/bus screen for the ride AFTER Winchester departure.
Prompted by all-day descriptive results, so this is not untouched confirmation.
"""
import collections,datetime,json,math,pathlib,statistics
from zoneinfo import ZoneInfo
import numpy as np
HERE=pathlib.Path('/home/gwarren/projects/yale-shuttle-watcher/red-window-data');TZ=ZoneInfo('America/New_York')
rows=[r for r in json.loads((HERE/'short-trip-hours.json').read_text())['observations']if r['clock']=='departure']
cut=lambda s:datetime.datetime.fromisoformat(s).replace(tzinfo=TZ).timestamp()*1000
fitCut=cut('2026-09-10');testCut=cut('2026-09-14');out=[]
for target in [48,4]:
 cell=[r for r in rows if r['target']==target]
 for r in cell:
  r['ready']=r['at']+1000*r['seconds']+120000
  t=datetime.datetime.fromtimestamp(r['at']/1000,TZ);r['hourFloat']=t.hour+t.minute/60+t.second/3600
 train=[r for r in cell if r['ready']<fitCut];cal=[r for r in cell if r['at']>=fitCut and r['ready']<testCut];test=[r for r in cell if r['at']>=testCut]
 buses=sorted(b for b,n in collections.Counter(r['bus']for r in train).items()if n>=10 and len({r['date']for r in train if r['bus']==b})>=2)
 arms={}
 def design(r,arm):
  a=[1.]
  if 'hour'in arm:a += [math.sin(2*math.pi*r['hourFloat']/24),math.cos(2*math.pi*r['hourFloat']/24)]
  if 'bus'in arm:a += [float(r['bus']==b)for b in buses]
  return np.array(a)
 for arm in ['pooled','hour','bus','hour_bus']:
  if arm=='pooled':co=np.array([statistics.median(r['seconds']for r in train)])
  else:
   X=np.array([design(r,arm)for r in train]);y=np.array([r['seconds']for r in train]);pen=[0]
   if 'hour'in arm:pen += [1,1]
   if 'bus'in arm:pen += [20]*len(buses)
   co=np.linalg.solve(X.T@X+np.diag(pen),X.T@y);co[0]+=statistics.median(r['seconds']-float(design(r,arm)@co)for r in train)
  predict=lambda r:max(0,float(design(r,arm)@co))
  # Same independent calibration-center correction and interval for every arm.
  res=[r['seconds']-predict(r)for r in cal];qs=np.quantile(res,[.1,.5,.9])
  scored=[]
  for r in test:
   p=predict(r);lo,pt,hi=[max(0,float(p+v))for v in qs]
   scored.append(dict(id=r['journeyId'],date=r['date'],bus=r['bus'],hour=r['hourFloat'],truth=r['seconds'],point=pt,low=lo,high=hi))
  def score(rs):
   return dict(n=len(rs),maeSec=statistics.mean(abs(r['point']-r['truth'])for r in rs),widthSec=statistics.mean(r['high']-r['low']for r in rs),early=sum(r['truth']<r['low']for r in rs),late=sum(r['truth']>r['high']for r in rs),overBy120=sum(r['point']-r['truth']>120 for r in rs),underBy120=sum(r['truth']-r['point']>120 for r in rs))
  arms[arm]=dict(coefficients=co.tolist(),calibrationResidualQuantiles=qs.tolist(),summary=score(scored),byDate={day:score([r for r in scored if r['date']==day])for day in sorted({r['date']for r in scored})},outcomes=scored)
 out.append(dict(target=target,trainN=len(train),calN=len(cal),testN=len(test),eligibleBuses=buses,arms=arms))
report=dict(method='Same calendar split as hold screen: fitbeforeSep10,calSep10–11,testSep14–16. Only exact connected stopped-target journeys; no laps mixed into ride. Hour is departure-time sin/cos ridge1; bus intercepts ridge20 guarded10visits/2dates. All models get separate calibration residual center/band. Exploratory test on previously inspected dates, not full live forecasts, not pickup/waiting predictions. Short-trip extraction may select against non-stops and broken tracks. Does not assess forecast-hour uncertainty before departure.',results=out)
(HERE/'journey-hour-screen.json').write_text(json.dumps(report,indent=2)+'\n')
for r in out:print(json.dumps(dict(target=r['target'],trainN=r['trainN'],calN=r['calN'],testN=r['testN'],arms={a:v['summary']for a,v in r['arms'].items()}),indent=2))
