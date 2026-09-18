from pathlib import Path
import hashlib,json,subprocess
root=Path('/home/gwarren/projects/yale-shuttle-watcher/overnight-ux-2026-09-17')
art=Path('/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux')
out=art/'review-ux08'
base='7e29064475315c2d621b77cdca130c05737d1ab8'
head='48651d63165bc4cddd7160a73fa6933583ecb856'
def git(*args):return subprocess.check_output(['git',*args],cwd=root,text=True)
assert git('rev-parse','HEAD').strip()==head
assert git('merge-base',base,head).strip()==base
assert git('show','-s','--format=%P',head).strip()==base
assert not git('status','--porcelain=v1').strip()
files=['services/shuttle-v2/scripts/stop-alert-controls-check.mjs','services/shuttle-v2/web/src/TransitMap.tsx']
assert git('diff','--name-only',base,head).splitlines()==files
subprocess.run(['git','diff','--check',base,head],cwd=root,check=True)
subprocess.run(['node','--check',files[0]],cwd=root,check=True)
source=files[1];old=git('show',base+':'+source);new=git('show',head+':'+source)
assert new==(root/source).read_text()
assert old==(art/'ux-08/TransitMap.baseline.tsx').read_text()
assert old.split('const StopList:')[0]==new.split('const StopList:')[0]
assert old.split('const RideRouteMap:')[1]==new.split('const RideRouteMap:')[1]
assert old.split('// ── ONE estimator, one anchor, for the whole page')[1].split('const chooserKey')[0]==new.split('// ── ONE estimator, one anchor, for the whole page')[1].split('const chooserKey')[0]
unchanged=['web/src/stopAlerts.ts','web/src/leaveAlert.ts','web/src/planner.ts','web/src/arrivals.ts','web/src/etaSource.ts','web/src/liveUpdates.ts','web/src/journeyArrival.ts','web/src/mapFilter.ts','web/src/schedule.ts','src/server/serverEta.ts','Dockerfile']
for p in unchanged:
 name='services/shuttle-v2/'+p
 assert (root/name).read_text()==git('show',base+':'+name),p
for dist,expected in [(art/'ux-08/baseline-dist',old),(root/'services/shuttle-v2/web/dist',new)]:
 contents=[]
 for p in dist.glob('assets/*.js.map'):
  m=json.loads(p.read_text())
  contents += [c for s,c in zip(m['sources'],m['sourcesContent']) if s.endswith('/TransitMap.tsx')]
 assert contents==[expected],str(dist)
recorded=json.loads((art/'ux-08/integrity.json').read_text())['sourceSha256']
hashes={p:hashlib.sha256((root/p).read_bytes()).hexdigest() for p in files}
assert recorded==hashes,'builder tested identical candidate source'
preserved=json.loads((out/'prior-evidence-sha256.json').read_text())
for p,h in preserved.items():assert hashlib.sha256(Path(p).read_bytes()).hexdigest()==h,p
for name in ['browser/stop-alert-controls.json','browser/desktop/stop-alert-controls.json','lifecycle.json']:
 d=json.loads((out/name).read_text());assert d['completed'] and d['resourcesClosed'] and not d['errors']
images=[p for team in ['ux','eta'] for p in (art.parent/team).rglob('*') if p.is_file() and p.suffix.lower() in ['.png','.jpg','.jpeg','.webp']]
imagebytes=sum(p.stat().st_size for p in images)
assert imagebytes<100*1024*1024
result={'head':head,'base':base,'cleanHeadIndexCheckout':True,'exactTwoFileDiff':True,'builderSourceHashesMatch':True,'bundleSourceMatch':True,'plannerMapCardEstimatorAlertEngineRideUnchanged':True,'unchangedModules':unchanged,'sourceSha256':hashes,'priorEvidencePreserved':len(preserved),'images':len(images),'imageBytes':imagebytes}
(out/'integrity.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps(result,indent=2))
