from pathlib import Path
import hashlib, json, subprocess
R=Path('/home/gwarren/projects/yale-shuttle-watcher/overnight-ux-2026-09-17')
O=Path(__file__).resolve().parent
base='8aa67bd7f3883598f9458d825d97a52cbc004e0f'
def git(*args):return subprocess.check_output(['git',*args],cwd=R,text=True)
assert git('rev-parse','HEAD').strip()==base
assert not git('diff','--cached','--name-only').strip()
subprocess.run(['git','diff','--check'],cwd=R,check=True)
files=['services/shuttle-v2/'+p for p in ['web/src/TransitMap.tsx','web/src/planner.ts','web/src/livePickupSelection.ts','web/src/livePickupSelection.test.ts','web/src/tripBusIdentity.ts','web/src/tripBusIdentity.test.ts','scripts/trip-identity-check.mjs','scripts/pickup-selection-check.mjs']]
assert set(git('diff','--name-only').splitlines())|set(git('ls-files','--others','--exclude-standard').splitlines())==set(files)
planner=(R/files[1]).read_text().replace("import type { LivePickupSelection } from './livePickupSelection';\n",'').replace('  /** Existing countdown and selected boarding evidence, independent of destination availability. */\n  livePickupSelection?: LivePickupSelection;\n','')
assert planner==git('show',base+':'+files[1]), 'planner runtime unchanged'
for name in ['arrivals.ts','journeyArrival.ts','arriveBy.ts','TripBoardingActions.tsx','etaSource.ts','liveUpdates.ts','mapFilter.ts','schedule.ts','stopAlerts.ts','leaveAlert.ts']:
 p='services/shuttle-v2/web/src/'+name
 assert (R/p).read_text()==git('show',base+':'+p), name
subprocess.run(['python3',str(O/'prepare-parity.py')],cwd=R,check=True)
for name in ['TransitMap.tsx','tripBusIdentity.ts','livePickupSelection.ts','planner.ts']:
 contents=[]
 for path in (R/'services/shuttle-v2/web/dist/assets').glob('*.js.map'):
  m=json.loads(path.read_text())
  contents += [c for s,c in zip(m['sources'],m['sourcesContent']) if s.endswith('/'+name)]
 assert contents==[(R/'services/shuttle-v2/web/src'/name).read_text()], name+' source/bundle mismatch'
for sub in ['release/browser-mobile.json','release/desktop/browser-desktop.json','release/identity/trip-identity.json','release/identity-desktop/trip-identity.json']:
 d=json.loads((O/sub).read_text());assert d['completed'] and d['resourcesClosed'] and not d['errors'], sub
 if 'states' in d:
  assert len(d['states'])==17 and d['futurePlanCleared']
  assert d['states'][2]['option']['livePickupSelection']['boarding']['busName']=='309'
  assert '⏳ 17 min' in d['states'][2]['text']
  assert '⏳ 41 min' in d['states'][4]['text']
  assert 'livePickupSelection' not in d['states'][6]['option']
audit=json.loads((O/'audit-summary.json').read_text())
for name in ['pairedDecisions','pairedTraces','pairedRankings','metadataMatches']:assert audit[name]==9376
assert audit['oldProductionMatches']==4688 and audit['inputFramesUnchanged']==4688
images=[p for team in ['ux','eta'] for p in (O.parents[1]/team).rglob('*') if p.is_file() and p.suffix.lower() in ['.png','.jpg','.jpeg','.webp']]
image_bytes=sum(p.stat().st_size for p in images);assert image_bytes<100*1024*1024
patch=git('diff','--binary')
for p in git('ls-files','--others','--exclude-standard').splitlines():
 result=subprocess.run(['git','diff','--no-index','--','/dev/null',p],cwd=R,text=True,capture_output=True)
 assert result.returncode==1
 patch+=result.stdout
(O/'proposal.patch').write_text(patch)
result={'base':base,'headPreserved':True,'indexUnchanged':True,'plannerRuntimeUnchanged':True,'reviewedProjectionExact':True,'builtSourcesMatch':True,'pairedStates':9376,'images':len(images),'imageBytes':image_bytes,'sourceSha256':{p:hashlib.sha256((R/p).read_bytes()).hexdigest() for p in files}}
(O/'integrity.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result,indent=2))
