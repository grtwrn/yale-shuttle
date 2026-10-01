from pathlib import Path
import hashlib,json,subprocess
repo=Path('/home/gwarren/projects/yale-shuttle-watcher/overnight-ux-2026-09-17')
root=Path('/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/ux-09-map')
entry=json.loads((root/'entry-integrity.json').read_text())
def git(*args):return subprocess.check_output(['git',*args],cwd=repo).decode()
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
assert git('rev-parse','HEAD').strip()==entry['head']
assert git('ls-files','-s')==entry['index']
changed=[p for p,h in entry['tracked'].items() if sha(repo/p)!=h]
app='services/shuttle-v2/web/src/TransitMap.tsx'
script='services/shuttle-v2/scripts/map-lifecycle-check.mjs'
assert changed==[app],changed
assert git('ls-files','--others','--exclude-standard').splitlines()==[script]
source=(repo/app).read_text();original=(root/'TransitMap.baseline.tsx').read_text()
restored=source.replace('    // Filters rebuild this map and changing tabs removes it. As on trip maps,\n    // disable CSS zoom: map.stop() does not cancel its delayed completion.\n','').replace('    // Done can remove the map during a zoom. Keep zoom immediate, as on trip\n    // maps, so a delayed CSS transition cannot run after teardown.\n','').replace('{ zoomControl: true, scrollWheelZoom: true, zoomAnimation: false }','{ zoomControl: true, scrollWheelZoom: true }')
assert restored==original,'Any change beyond two map options/comments'
diag=json.loads((root.parent/'ux-09/map-diagnostic.json').read_text())
assert sha(root/'TransitMap.baseline.tsx')==diag['baseline']['TransitMapSHA256']==diag['current']['TransitMapSHA256']
match=[]
for p in (repo/'services/shuttle-v2/web/dist/assets').glob('*.js.map'):
 d=json.loads(p.read_text())
 for name,content in zip(d['sources'],d['sourcesContent']):
  if name.endswith('/TransitMap.tsx'):
   assert content==source
   match.append(str(p.relative_to(repo)))
assert len(match)==1
reports=[]
for rel in ['browser-second/mobile/map-lifecycle.json','browser-second/desktop/map-lifecycle.json','browser-second/original-repro/map-stress.json','browser-second/feed/empty-service.json','browser-second/fullscreen/after-browser.json','gestures/mobile/map-lifecycle.json','gestures/desktop/map-lifecycle.json']:
 d=json.loads((root/rel).read_text());assert d['completed'] and d['resourcesClosed'] and d['errors']==[],rel
 if 'scenarios' in d:assert len(d['scenarios'])==2 and all(s['iterations']==6 and s['passed'] for s in d['scenarios'])
 reports.append(rel)
baseline=json.loads((root/'baseline-ride-second/map-lifecycle.json').read_text())
assert baseline['resourcesClosed'] and len(baseline['errors'])==1 and baseline['scenarios'][0]['iterations']==1
images=[]
for team in ['ux','eta']:
 images.extend(p for p in (root.parent.parent/team).rglob('*') if p.is_file() and p.suffix.lower() in {'.png','.jpg','.jpeg','.webp'})
size=sum(p.stat().st_size for p in images);assert size<100*1024*1024
subprocess.run(['git','diff','--check'],cwd=repo,check=True)
(root/'proposal.patch').write_text(git('diff','--',app))
result={'head':entry['head'],'indexPreserved':True,'changedTracked':changed,'newScript':script,'sourceBundleParity':match,'runtimeOnlyTwoMapOptionsAndComments':True,'priorSystemBaselineProvenance':True,'passingBrowserReports':reports,'newRideBaselineErrors':baseline['errors'],'screenshots':{'count':len(images),'bytes':size},'hashes':{app:sha(repo/app),script:sha(repo/script)}}
(root/'integrity.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps(result,indent=2))
