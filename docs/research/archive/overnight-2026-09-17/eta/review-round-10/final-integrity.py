from pathlib import Path
import hashlib,json,subprocess
O=Path(__file__).resolve().parent
A=O.parent
S=A/'cycle-11'
repo=Path('/home/gwarren/projects/yale-shuttle-watcher/overnight-eta-2026-09-17')
sha='d5a392f533e8684320259ff0d323a3b0da75cc50'
read=lambda p:json.loads(p.read_text())
digest=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
assert subprocess.check_output(['git','rev-parse','HEAD'],cwd=repo,text=True).strip()==sha
assert subprocess.check_output(['git','rev-parse',sha],cwd=repo,text=True).strip()==sha
assert not subprocess.check_output(['git','status','--porcelain'],cwd=repo,text=True).strip()
for args in [['diff','--check'],['diff','--exit-code'],['diff','--cached','--exit-code'],['apply','--check',str(O/'eta-projection.patch')]]:
 subprocess.run(['git',*args],cwd=repo,check=True)
original=read(O/'builder-hashes-before.json')
for name,want in original.items():assert digest(S/name)==want,name
same=['eta-projection.patch','TransitMap.tsx','planner.ts','livePickupSelection.ts','shell-candidate.generated.mts','future-guard.generated.mts','source-extraction.json','paired-metadata.jsonl','audit-summary.json','boundaries.json','multi-option.json']
for name in same:assert (S/name).read_bytes()==(O/name).read_bytes(),name
assets=read(A/'cycle-10/built-source-provenance.json')['assets']
for name,want in assets.items():assert digest(repo/'services/shuttle-v2/web/dist'/name)==want,name
for viewport in ['mobile','desktop']:
 for prefix,states in [('browser-',12),('browser-review-',16)]:
  r=read(O/f'{prefix}{viewport}.json')
  assert r['completed'] and r['resourcesClosed'] and not r['errors'] and len(r['states'])==states
  if prefix=='browser-review-':assert r['futurePlanCleared'] and r['physicalRidePersistencePassed']
failed=read(O/'browser-review-mobile.json.first')
assert failed['resourcesClosed'] and not failed['errors']
assert len(failed['states'])==16
multi=read(O/'multi-option-review.json')
assert multi['batches']==multi['distinctSelectionBatches']==100
assert multi['distinctBoardingAmongShuttles']==87
images=[p for team in ['eta','ux'] for p in (A.parent/team).rglob('*') if p.is_file() and p.suffix.lower() in {'.png','.jpg','.jpeg','.webp'}]
imagebytes=sum(p.stat().st_size for p in images)
assert imagebytes<100*1024*1024
result={'head':sha,'base':sha,'cleanCheckout':True,'builderFilesUnchanged':len(original),'byteIdenticalReproductions':same,'originalDistAssetsUnchanged':len(assets),'browserBaselineStates':24,'browserExtendedStates':32,'futureAndPhysicalPersistence':['mobile','desktop'],'directSelector':read(O/'direct-selector-audit.json'),'shuttleDiversityBatches':100,'differentBoardingIdentityBatches':87,'screenshotsTaken':0,'combinedImageFiles':len(images),'combinedImageBytes':imagebytes}
(O/'final-integrity.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps(result,indent=2))
