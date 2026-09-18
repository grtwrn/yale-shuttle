import urllib.request,json,time,pathlib,math
out=pathlib.Path('/home/gwarren/projects/yale-shuttle-watcher/ranking-data')
base='https://yale-shuttle.fly.dev'
def get(path):
 return json.load(urllib.request.urlopen(base+path,timeout=20))
for i in range(48):
 try:
  h=get('/healthz')
  if h.get('build')=='9e7b48b5b060' and h['serverEta']['steps']>0:break
 except Exception:pass
 time.sleep(5)
else:raise RuntimeError('New deployment not observed within four minutes')
health=[]
for i in range(5):
 h=get('/healthz');assert h['ok'] and h['build']=='9e7b48b5b060';assert h['serverEta']['failures']==0;assert h['serverEta']['restored']>0;health.append(h)
 if i<4:time.sleep(5)
assert health[-1]['serverEta']['steps']>health[0]['serverEta']['steps']
feed=get('/api/buses');(out/'production-feed.json').write_text(json.dumps(feed))
assert len(feed['server_eta']['rows'])>0
body={'from':{'lat':41.324769,'lon':-72.923522},'to':{'lat':41.314701,'lon':-72.924551}}
r=urllib.request.Request(base+'/api/plan',data=json.dumps(body).encode(),headers={'Content-Type':'application/json'},method='POST')
plan=json.load(urllib.request.urlopen(r,timeout=20));(out/'production-plan.json').write_text(json.dumps(plan,indent=2))
walk=next(p['totalSec'] for p in plan['plans'] if all(l['mode']=='walk' for l in p['legs']))
for p in plan['plans']:
 if all(l['mode']=='walk' for l in p['legs']):continue
 walking=sum(l['seconds'] for l in p['legs'] if l['mode']=='walk')
 assert walk-walking+1e-6>=min(walk*.2,max(120,walk*.1)),(walking,walk)
report={'health':health,'planCount':len(plan['plans']),'rows':len(feed['server_eta']['rows']),'directWalkSec':walk}
(out/'production-verification.json').write_text(json.dumps(report,indent=2));print(json.dumps(report))
