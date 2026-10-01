import json,datetime as dt,sqlite3,bisect,statistics
from pathlib import Path
root=Path('/home/gwarren/projects/yale-shuttle-watcher/red-eta-data')
base=[json.loads(s) for s in (root/'baseline-watcher.jsonl').open()];candidate=[json.loads(s) for s in (root/'smooth-watcher.jsonl').open()]
assert len(base)==len(candidate)
for a,b in zip(base,candidate):
 assert (a['at'],a['runId'],a['bus']['bus_name'])==(b['at'],b['runId'],b['bus']['bus_name'])
 assert [(x['stopId'],x['eta']) for x in a['arrivals']]==[(x['stopId'],x['eta']) for x in b['arrivals']]
truth={}
for bus,t in sqlite3.connect(root/'replay.db').execute('SELECT bus_name,arrived_at FROM arrivals WHERE route_id=3 AND stop_id=48 ORDER BY arrived_at'):
 truth.setdefault(bus,[]).append(t)
result={'busFrames':len(base),'pointPredictionsIdentical':True,'targetStop':48}
for label,frames in [('baseline',base),('candidate',candidate)]:
 prev={};jumps=[];inside=0;widths=[]
 for f in frames:
  t=dt.datetime.fromisoformat(f['at']).timestamp()*1000; bus=f['bus']['bus_name']; key=f['runId'],bus
  arrivals=[a for a in f['arrivals'] if a['stopId']==48 and 0<a['eta']<=1800]
  if not arrivals:prev.pop(key,None);continue
  a=arrivals[0]; ts=truth.get(bus,[]);i=bisect.bisect_left(ts,t)
  if i<len(ts) and ts[i]-t<2700000:
   actual=(ts[i]-t)/1000;inside+=a['low']<=actual<=a['high']; widths.append(a['high']-a['low'])
  if key in prev:
   pt,pa=prev[key]; elapsed=(t-pt)/1000
   if 0<elapsed<=30:jumps.append(max(abs(a[q]-max(0,pa[q]-elapsed)) for q in ('low','high')))
  prev[key]=t,a
 result[label]={'matched':len(widths),'coveragePct':round(100*inside/len(widths),1),'medianWidthSec':round(statistics.median(widths),1),'endpointJumps60':sum(x>=60 for x in jumps),'endpointJumps120':sum(x>=120 for x in jumps),'comparisons':len(jumps)}
(root/'watcher-compare.json').write_text(json.dumps(result,indent=2));print(json.dumps(result,indent=2))
