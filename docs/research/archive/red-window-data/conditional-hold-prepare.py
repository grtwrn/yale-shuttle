"""Prepare a prespecified component screen, using pinned stand clocks and prior dates.
Current lap-scaled marginal, lap-normalized prior shape, and additive lap residuals.
No test-date coefficient or threshold selection. Not a live end-to-end comparison.
"""
import ast,collections,datetime,heapq,json,math,pathlib,sqlite3,statistics
from zoneinfo import ZoneInfo
import numpy as np
ROOT=pathlib.Path('/home/gwarren/projects/yale-shuttle-watcher');HERE=ROOT/'red-window-data';TZ=ZoneInfo('America/New_York')
module=ast.parse((HERE/'covariate-followup.py').read_text())
exec(compile(ast.Module(body=[n for n in module.body if isinstance(n,ast.FunctionDef) and n.name in ['clock','cutoff','enrich','audit']],type_ignores=[]),'<covariate-functions>','exec'))
d=sqlite3.connect('file:'+str(ROOT/'red-eta-data/replay-lap.db')+'?mode=ro',uri=True);d.row_factory=sqlite3.Row
records=[]
for r in d.execute("SELECT * FROM stop_visits WHERE route_id=3 AND stop_id IN (11,121) AND how!='gap' AND arrived_at IS NOT NULL AND departed_at IS NOT NULL AND departed_at>=arrived_at ORDER BY arrived_at"):
 a=r['pinned_at'] if r['pinned_at'] is not None else r['arrived_at']
 records.append(dict(id=r['id'],stop=r['stop_id'],bus=r['bus_name'],a=a,d=r['departed_at'],ready=r['departed_at']+max(120000,(r['confirm_sec']or 0)*1000),target=r['outcome']=='stopped'and r['pinned_at'] is not None and r['closest_m']<=75))
inputAudit=audit(records);data=enrich(records);fitCut=cutoff('2026-09-10');testCut=cutoff('2026-09-14')
models=[]
for stop in [11,121]:
 cell=[r for r in data if r['stop']==stop]
 train=[r for r in cell if r['ready']<fitCut];cal=[r for r in cell if r['a']>=fitCut and r['ready']<testCut];test=[r for r in cell if r['a']>=testCut]
 reference=statistics.median(r['period']for r in train if r['period'] is not None and 900<r['period']<7200)
 valid=lambda r:r['lap']is not None and .65*reference<=r['lap']<=1.65*reference
 tr=[r for r in train if valid(r)];ca=[r for r in cal if valid(r)]
 X=np.array([[1,(r['lap']-reference)/600]for r in tr]);y=np.array([r['y']for r in tr]);coef=np.linalg.lstsq(X,y,rcond=None)[0]
 coef[0]+=statistics.median(r['y']-float(np.array([1,(r['lap']-reference)/600])@coef)for r in tr)
 def center(r):return max(0,float(np.array([1,(r['lap']-reference)/600])@coef))
 residuals=[r['y']-center(r)for r in ca]
 q=[float(np.quantile(residuals,(i+.5)/10))for i in range(10)]
 assert max(r['ready']for r in train)<min(r['a']for r in cal)
 assert max(r['ready']for r in cal)<min(r['a']for r in test)
 models.append(dict(stop=stop,reference=reference,coefficients=coef.tolist(),residualQuantiles=q,train=train,calibration=cal,test=test,prior=[r for r in cell if r['ready']<testCut],trainLapN=len(tr),calLapN=len(ca),testLapN=sum(valid(r)for r in test)))
out=dict(method='Prior frozen at2026-09-14 00:00ET. Additive model trainbeforeSep10; residuals Sep10–11; testSep14–16. Separate fixed elapsed clocks0/60/180/300/420/600, scored only when true stand survived. Normalized candidate learns prior shape after dividing each valid prior stand by current lap factor. Missing/out-of-band lap falls back to current component distribution. Positive hold duration conditional on stopped; no pass detection or state classification evaluated. No served conformal widening or running minimum. Component screen only.',audit=inputAudit,models=models)
(HERE/'conditional-hold-input.json').write_text(json.dumps(out,indent=2)+'\n')
print(json.dumps([{k:v for k,v in m.items()if k not in ['train','calibration','test','prior']}for m in models],indent=2))
