from pathlib import Path
import hashlib,json,subprocess
root=Path('/home/gwarren/projects/yale-shuttle-watcher/overnight-ux-2026-09-17')
out=Path('/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/ux-08')
base='7e29064475315c2d621b77cdca130c05737d1ab8'
def git(*args): return subprocess.check_output(['git',*args],cwd=root,text=True)
assert git('rev-parse','HEAD').strip()==base
assert not git('diff','--cached','--name-only').strip()
subprocess.run(['git','diff','--check'],cwd=root,check=True)
source='services/shuttle-v2/web/src/TransitMap.tsx'
old=git('show',base+':'+source)
new=(root/source).read_text()
assert old==(out/'TransitMap.baseline.tsx').read_text()
assert old.split('const StopList:')[0]==new.split('const StopList:')[0], 'planner/map/trip unchanged'
assert old.split('const RideRouteMap:')[1]==new.split('const RideRouteMap:')[1], 'ride/main/alert engine unchanged'
assert old.split('// ── ONE estimator, one anchor, for the whole page')[1].split('const chooserKey')[0]==new.split('// ── ONE estimator, one anchor, for the whole page')[1].split('const chooserKey')[0], 'card estimator unchanged'
for name in ['stopAlerts.ts','leaveAlert.ts','planner.ts','arrivals.ts','etaSource.ts','liveUpdates.ts','journeyArrival.ts','mapFilter.ts','schedule.ts']:
 p='services/shuttle-v2/web/src/'+name
 assert (root/p).read_text()==git('show',base+':'+p),name
for dist,expected in [(out/'baseline-dist',old),(root/'services/shuttle-v2/web/dist',new)]:
 contents=[]
 for p in dist.glob('assets/*.js.map'):
  m=json.loads(p.read_text())
  contents += [c for s,c in zip(m['sources'],m['sourcesContent']) if s.endswith('/TransitMap.tsx')]
 assert contents==[expected], str(dist)+' bundle must match exact source'
reports=[]
for p in [out/'release/stop-alert-controls.json',out/'release/desktop/stop-alert-controls.json']:
 d=json.loads(p.read_text()); assert d['completed'] and d['resourcesClosed'] and not d['errors']
 assert [s['permission'] for s in d['states']]==['denied','unsupported','default','granted']
 for s in d['states']:
  assert s['expanded']=='true' and all(s[k] for k in ['escapeClosed','escapeFocus','cancelFocus','armFocus'])
 reports.append(str(p))
images=[p for team in ['ux','eta'] for p in (out.parents[1]/team).rglob('*') if p.is_file() and p.suffix.lower() in ['.png','.jpg','.jpeg','.webp']]
image_bytes=sum(p.stat().st_size for p in images)
assert image_bytes<100*1024*1024
files=[source,'services/shuttle-v2/scripts/stop-alert-controls-check.mjs']
changed=set(git('diff','--name-only').splitlines())|set(git('ls-files','--others','--exclude-standard').splitlines())
assert changed==set(files), changed
result={'head':base,'indexUnchanged':True,'numericalAndEngineUnchanged':True,'baselineAndCandidateBundlesMatch':True,'reports':reports,'images':len(images),'imageBytes':image_bytes,'sourceSha256':{p:hashlib.sha256((root/p).read_bytes()).hexdigest() for p in files}}
(out/'integrity.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps(result,indent=2))
