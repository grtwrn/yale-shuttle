from pathlib import Path
import json,hashlib,subprocess
repo=Path('/home/gwarren/projects/yale-shuttle-watcher/overnight-ux-2026-09-17')
root=repo.parent/'overnight-2026-09-17/ux/ux-09-pinch'
entry=json.loads((root/'entry.json').read_text())
def git(*args):return subprocess.check_output(['git',*args],cwd=repo,text=True)
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
assert git('rev-parse','HEAD').strip()==entry['head']
assert sha(Path(git('rev-parse','--git-path','index').strip()))==entry['index']
assert not git('diff','--cached')
prefix='services/shuttle-v2/'
app=prefix+'web/src/TransitMap.tsx'
new=[prefix+'scripts/map-touch-teardown-check.mjs',prefix+'web/src/mapLifecycle.ts']
assert git('diff','--name-only').splitlines()==[app]
assert git('ls-files','--others','--exclude-standard').splitlines()==new
original=(root/'TransitMap.entry.tsx').read_text(); current=(repo/app).read_text()
assert current.replace('import { cancelMapTouchZoom } from "./mapLifecycle";\n','').replace('      cancelMapTouchZoom(map);\n','')==original
assert current.count('      cancelMapTouchZoom(map);')==2
for file in ['web/src/main.tsx','web/src/CrashRecovery.tsx','scripts/crash-recovery-check.mjs','scripts/map-lifecycle-check.mjs']:
 assert git('show',entry['head']+':'+prefix+file)==(repo/prefix/file).read_text(),file
parity={}
for label,dist,expected in [('entry',root/'entry-dist',{app:original}),('candidate',repo/prefix/'web/dist',{app:current,new[1]:(repo/new[1]).read_text()})]:
 matches={}
 for p in (dist/'assets').glob('*.js.map'):
  d=json.loads(p.read_text())
  for source,content in zip(d['sources'],d['sourcesContent']):
   for file,want in expected.items():
    if source == '../../src/' + Path(file).name:
     assert content==want,(label,file)
     matches[file]=hashlib.sha256(content.encode()).hexdigest()
 assert set(matches)==set(expected),(label,matches)
 parity[label]=matches
reports=[]
for rel in ['touch/map-touch-teardown.json','reviewer-manual/interrupt-pinch.json','reviewer-expiry/interrupt-pinch.json','mobile/map-lifecycle.json','desktop/map-lifecycle.json','original-repro/map-stress.json','feed/empty-service.json','fullscreen/after-browser.json']:
 d=json.loads((root/'release'/rel).read_text());assert d['completed'] and d['resourcesClosed'] and not d['errors'],rel
 reports.append(rel)
touch=json.loads((root/'release/touch/map-touch-teardown.json').read_text())
assert len(touch['cases'])==8
for case in touch['cases']:
 assert case['completed'] and not case['errors']
 assert case['listenersDuring']['touchmove']>case['listenersBefore']['touchmove']
 assert case['listenersAfterRemoval']==case['listenersBefore']
failed=json.loads((root/'entry-system-outcome.json').read_text())
assert failed['expected_failure'] and failed['exit']==1
images=[p for team in ['ux','eta'] for p in (root.parent.parent/team).rglob('*') if p.is_file() and p.suffix.lower() in {'.png','.jpg','.jpeg','.webp'}]
imagebytes=sum(p.stat().st_size for p in images);assert imagebytes<100*1024*1024
subprocess.run(['git','diff','--check'],cwd=repo,check=True)
result={'head':entry['head'],'indexPreserved':True,'trackedDiffOnlyTwoCancelCallsAndImport':True,'priorRecoveryAndMapRegressionByteIdentical':True,'sourceBundleParity':parity,'passingBrowserReports':reports,'heldTouchCases':len(touch['cases']),'screenshots':{'count':len(images),'bytes':imagebytes},'hashes':{file:sha(repo/file) for file in [app]+new}}
(root/'integrity.json').write_text(json.dumps(result,indent=2));print(json.dumps(result,indent=2))
(root/'proposal.patch').write_text(git('diff','--',app))
