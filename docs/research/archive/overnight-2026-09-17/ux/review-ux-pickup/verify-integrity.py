from pathlib import Path
import hashlib,json,subprocess
R=Path('/home/gwarren/projects/yale-shuttle-watcher/overnight-ux-2026-09-17')
O=Path(__file__).resolve().parent
B=O.parent/'ux-pickup'
base='8aa67bd7f3883598f9458d825d97a52cbc004e0f'
head='7f681d92a7d30331728d637216dabecf9d9e356c'
def git(*args): return subprocess.check_output(['git',*args],cwd=R,text=True)
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
assert git('rev-parse','HEAD').strip()==head
assert git('rev-parse','HEAD^').strip()==base
assert git('merge-base',head,base).strip()==base
assert not git('status','--porcelain').strip()
subprocess.run(['git','diff','--check',base,head],cwd=R,check=True)
builder=json.loads((B/'integrity.json').read_text())
files=builder['sourceSha256']
assert set(git('diff','--name-only',base,head).splitlines())==set(files)
for p,h in files.items():
 assert sha(R/p)==h,p
 assert (R/p).read_text()==git('show',head+':'+p),p
for p in ['scripts/pickup-selection-check.mjs','scripts/trip-identity-check.mjs']:
 subprocess.run(['node','--check',str(R/'services/shuttle-v2'/p)],check=True)
planner=(R/'services/shuttle-v2/web/src/planner.ts').read_text().replace("import type { LivePickupSelection } from './livePickupSelection';\n",'').replace('  /** Existing countdown and selected boarding evidence, independent of destination availability. */\n  livePickupSelection?: LivePickupSelection;\n','')
assert planner==git('show',base+':services/shuttle-v2/web/src/planner.ts')
assert not git('diff','--name-only',base,head,'--','services/shuttle-v2/src','services/shuttle-v2/Dockerfile').strip()
for p in ['arrivals.ts','journeyArrival.ts','arriveBy.ts','arriveByMessage.ts','ArriveBy.tsx','TripBoardingActions.tsx','etaSource.ts','liveUpdates.ts','mapFilter.ts','schedule.ts','stopAlerts.ts','leaveAlert.ts','tripRanking.ts','rideEnd.ts','RideFinish.tsx']:
 path='services/shuttle-v2/web/src/'+p
 assert (R/path).read_text()==git('show',base+':'+path),p
for name in ['TransitMap.tsx','tripBusIdentity.ts','livePickupSelection.ts','planner.ts']:
 contents=[]
 for path in (R/'services/shuttle-v2/web/dist/assets').glob('*.js.map'):
  m=json.loads(path.read_text());contents += [c for s,c in zip(m['sources'],m['sourcesContent']) if s.endswith('/'+name)]
 assert contents==[(R/'services/shuttle-v2/web/src'/name).read_text()],name
for p in ['browser/browser-mobile.json','browser/desktop/browser-desktop.json','browser/identity/trip-identity.json','browser/identity-desktop/trip-identity.json','lifecycle-mobile/browser-mobile.json','lifecycle-desktop/browser-desktop.json']:
 d=json.loads((O/p).read_text());assert d['completed'] and d['resourcesClosed'] and not d['errors'],p
 if p.startswith('lifecycle-'):assert len(d['checks'])==5 and len(d['states'])==9
 elif 'states' in d:assert len(d['states'])==17 and d['futurePlanCleared']
before=json.loads((O/'evidence-before.json').read_text())
for p,h in before.items():assert sha(B/p)==h,p
for p in ['audit-summary.json','paired-metadata.jsonl']:
 assert (O/p).read_bytes()==(B/p).read_bytes(),p
images=[p for team in ['ux','eta'] for p in (O.parents[1]/team).rglob('*') if p.is_file() and p.suffix.lower() in ['.png','.jpg','.jpeg','.webp']]
image_bytes=sum(p.stat().st_size for p in images);assert image_bytes<100*1024*1024
result={'head':head,'base':base,'parentAndMergeBaseExact':True,'cleanCheckoutAndIndex':True,'builderTestedSourcesExact':True,'builtSourcesMatch':True,'plannerRuntimeUnchanged':True,'serverAndDockerUnchanged':True,'browserReports':6,'pairedStates':9376,'builderEvidencePreserved':len(before),'imageFiles':len(images),'imageBytes':image_bytes,'sourceSha256':files}
(O/'integrity.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result,indent=2))
