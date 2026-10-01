from pathlib import Path
import hashlib,json,subprocess
repo=Path('/home/gwarren/projects/yale-shuttle-watcher/overnight-ux-2026-09-17')
art=repo.parent/'overnight-2026-09-17/ux'
out=art/'review-ux09-pinch'
entry=json.loads((out/'entry.json').read_text())
base='98e535b99649e74ca599d2e33bcfdc46df83d30d'
head='a5966b1e87a9f4fbecf3888456fbd272f186fcb8'
prior='e7e9063df1fb15a364529075a702789e2bf348c7'
prefix='services/shuttle-v2/'
def git(*args):return subprocess.check_output(['git',*args],cwd=repo,text=True)
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
assert git('rev-parse','HEAD').strip()==head==entry['head']
assert git('merge-base',base,'HEAD').strip()==base
assert git('write-tree').strip()==entry['index']
assert not git('status','--porcelain') and not git('diff','--cached')
for f,h in entry['tracked'].items():assert sha(repo/f)==h,f
for f,h in entry['builder'].items():assert sha(Path(f))==h,f
expected=['scripts/crash-recovery-check.mjs','scripts/map-lifecycle-check.mjs','scripts/map-touch-teardown-check.mjs','web/src/CrashRecovery.tsx','web/src/TransitMap.tsx','web/src/main.tsx','web/src/mapLifecycle.ts']
assert git('diff','--name-only',base,'HEAD').splitlines()==[prefix+f for f in expected]
for f in ['web/src/CrashRecovery.tsx','web/src/main.tsx','scripts/crash-recovery-check.mjs']:
 assert git('show','da51fcb0af70f554ef0b141aa07d4a390f3c7de0:'+prefix+f)==(repo/prefix/f).read_text(),f
assert git('show',prior+':'+prefix+'scripts/map-lifecycle-check.mjs')==(repo/prefix/'scripts/map-lifecycle-check.mjs').read_text()
current=(repo/prefix/'web/src/TransitMap.tsx').read_text()
without_helper=current.replace('import { cancelMapTouchZoom } from "./mapLifecycle";\n','').replace('      cancelMapTouchZoom(map);\n','')
assert current.count('      cancelMapTouchZoom(map);')==2
assert without_helper==git('show',prior+':'+prefix+'web/src/TransitMap.tsx')
for comment in ['    // Filters rebuild this map and changing tabs removes it. As on trip maps,\n    // disable CSS zoom: map.stop() does not cancel its delayed completion.\n','    // Done can remove the map during a zoom. Keep zoom immediate, as on trip\n    // maps, so a delayed CSS transition cannot run after teardown.\n']:
 assert comment in without_helper
 without_helper=without_helper.replace(comment,'')
line='const map = L.map(ref.current, { zoomControl: true, scrollWheelZoom: true, zoomAnimation: false });'
assert without_helper.count(line)==2
without_helper=without_helper.replace(line,'const map = L.map(ref.current, { zoomControl: true, scrollWheelZoom: true });')
assert without_helper==git('show',base+':'+prefix+'web/src/TransitMap.tsx')
parity={}
for label,dist,ref,names in [('candidate',repo/prefix/'web/dist',head,['main.tsx','CrashRecovery.tsx','TransitMap.tsx','mapLifecycle.ts']),('frozen-entry',art/'ux-09-pinch/entry-dist',prior,['main.tsx','CrashRecovery.tsx','TransitMap.tsx']),('frozen-base',art/'ux-09/baseline-dist',base,['main.tsx','TransitMap.tsx'])]:
 found={}
 for p in dist.rglob('*.js.map'):
  d=json.loads(p.read_text())
  for src,content in zip(d['sources'],d['sourcesContent']):
   for name in names:
    if src=='../../src/'+name or src.endswith('/web/src/'+name):
     assert content==git('show',ref+':'+prefix+'web/src/'+name),(label,name)
     found[name]=hashlib.sha256(content.encode()).hexdigest()
 assert set(found)==set(names),(label,found)
 parity[label]=found
reports=['verified/touch/map-touch-teardown.json','verified/reviewer-manual/interrupt-pinch.json','verified/reviewer-expiry/interrupt-pinch.json','verified/mobile/map-lifecycle.json','verified/desktop/map-lifecycle.json','verified/original-repro/map-stress.json','verified/feed/empty-service.json','verified/fullscreen/after-browser.json','recovery-mobile/crash-recovery.json','recovery-desktop/crash-recovery.json','recovery-real-trip/lifecycle.json','offline/offline-shell.json','isolation-corrected/isolation.json']
for rel in reports:
 d=json.loads((out/rel).read_text())
 assert d['completed'] and d['resourcesClosed'] and not d['errors'],rel
d=json.loads((out/reports[0]).read_text())
assert len(d['cases'])==8
for case in d['cases']:
 assert case['completed'] and not case['errors']
 assert case['listenersDuring']['touchmove']>case['listenersBefore']['touchmove']
 assert case['listenersAfterRemoval']==case['listenersBefore']
images=[p for team in ['ux','eta'] for p in (art.parent/team).rglob('*') if p.is_file() and p.suffix.lower() in {'.png','.jpg','.jpeg','.webp'}]
imagebytes=sum(p.stat().st_size for p in images)
assert imagebytes<100*1024*1024
result={'head':head,'base':base,'checkoutIndexUnchanged':True,'trackedFilesPreserved':len(entry['tracked']),'builderFilesPreserved':len(entry['builder']),'priorRecoveryUnchanged':True,'mapScopeVerifiedAgainstExactBase':True,'sourceBundleParity':parity,'passingBrowserReports':reports,'heldGestureCases':8,'screenshots':{'count':len(images),'bytes':imagebytes}}
(out/'integrity.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps(result,indent=2))
