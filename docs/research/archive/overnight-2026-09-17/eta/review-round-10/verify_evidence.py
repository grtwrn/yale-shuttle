from pathlib import Path
import json,hashlib,subprocess
O=Path(__file__).resolve().parent
A=O.parent
repo=Path('/home/gwarren/projects/yale-shuttle-watcher/overnight-eta-2026-09-17')
web=repo/'services/shuttle-v2/web'
read=lambda p:json.loads(p.read_text())
digest=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
plan=read(O/'PLAN.json')
assert subprocess.check_output(['git','rev-parse','HEAD'],cwd=repo,text=True).strip()==plan['head']
assert not subprocess.check_output(['git','status','--porcelain'],cwd=repo,text=True).strip()
for path,want in plan['inputHashes'].items():assert digest(Path(path))==want,path
prior=read(A/'cycle-10/artifact-hashes.json')['files']
for path,want in prior.items():assert digest(A/'cycle-10'/path)==want,path
overlay=read(O/'overlay.json');sources={}
for path,meta in overlay.items():assert digest(Path(meta['artifact']))==meta['sha256']
for p in (O/'dist/assets').glob('*.js.map'):
    d=read(p)
    for name,content in zip(d['sources'],d['sourcesContent']):
        target=(p.parent/name).resolve()
        if target.is_relative_to(web/'src'):
            expected=Path(overlay[str(target)]['artifact']) if str(target) in overlay else target
            assert expected.read_text()==content,str(target)
            sources[str(target)]=hashlib.sha256(content.encode()).hexdigest()
assert all(p in sources for p in overlay)
assert all(str(web/'src'/n) in sources for n in ['journeyArrival.ts','tripBusIdentity.ts','TripBoardingActions.tsx'])
paired=[json.loads(s) for s in (O/'paired-metadata.jsonl').read_text().splitlines()]
base={(r['session'],r['at']):r for r in paired if r['arm']=='historical'}
absent={(r['session'],r['at']):r for r in paired if r['arm']=='missingDestination'}
assert len(base)==len(absent)==4688
for key,r in base.items():
    assert r['livePickupSelection']==absent[key]['livePickupSelection']
    assert r['waitSec']==absent[key]['waitSec']
outcomes=read(A/'cycle-6/paired-outcomes.json');assert len(outcomes)==1400
for r in outcomes:
    b=base[(r['session'],r['at'])]
    assert b['totalSec']==r['ordered']['totalSec']
    assert b['destinationAvailable']==r['ordered']['journeyAvailable']
worst=max((r for r in outcomes if r['changed']),key=lambda r:r['absErrorIncreaseSec'])
assert worst['sourceId']==63523 and worst['absErrorIncreaseSec']==442.82701916224846
missing=read(A/'cycle-6/missing-cases.json')
remaining=[r for r in missing if r['causal']['reason']=='only next-lap pickup; first destination precedes it']
assert len(remaining)==38
for r in remaining:
    b=base[(r['session'],r['at'])]
    assert b['livePickupSelection']['relation']=='raw-current'
    assert b['livePickupSelection']['boarding']['source']=='raw-at-stop'
    assert 'stopsAhead' not in b['livePickupSelection']['boarding']
    assert not b['destinationAvailable']
assert sum(r['retrospective']['afterRecordedDeparture'] for r in remaining)==14
build=read(O/'overlay-verification.json');assert build['built'] and len(build['typechecks'])==2
audit=read(O/'audit-summary.json');assert audit['pairedDecisions']==audit['pairedRankings']==audit['metadataMatches']==9376
boundaries=read(O/'boundaries.json');assert boundaries['passed']==17
multi=read(O/'multi-option.json');assert multi['batches']==100 and multi['distinctSelectionBatches']>0
browsers=[]
for viewport in ['mobile','desktop']:
    b=read(O/f'browser-{viewport}.json')
    assert b['completed'] and b['resourcesClosed'] and not b['errors'] and b['keyboardTabPassed']
    assert len(b['states'])==12
    browsers.append({'viewport':viewport,'states':len(b['states']),'requests':b['feedRequests'],'errors':b['errors'],'resourcesClosed':b['resourcesClosed']})
subprocess.run(['git','apply','--check',str(O/'eta-projection.patch')],cwd=repo,check=True)
images=[p for team in ['eta','ux'] for p in (A.parent/team).rglob('*') if p.is_file() and p.suffix.lower() in {'.png','.jpg','.jpeg','.webp'}]
imagebytes=sum(p.stat().st_size for p in images);assert imagebytes<100*1024*1024
report={'head':plan['head'],'cleanGit':True,'inputHashes':len(plan['inputHashes']),'priorArtifactsPreserved':len(prior),'pairedStates':9376,'preservedConnectedOutcomes':1400,'retainedRegressionSec':worst['absErrorIncreaseSec'],'rawUnknownPreserved':38,'rawAfterDeparture':14,'builtSourceCount':len(sources),'overlayModules':len(overlay),'sourceHashes':sources,'assets':{str(p.relative_to(O/'dist')):digest(p) for p in (O/'dist').rglob('*') if p.is_file()},'browsers':browsers,'boundaryGroups':17,'multiOptionBatches':multi['batches'],'multiOptions':multi['options'],'patchApplies':True,'screenshotsAdded':0,'combinedScreenshots':{'files':len(images),'bytes':imagebytes}}
(O/'evidence.json').write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps({k:v for k,v in report.items() if k not in ['sourceHashes','assets']},indent=2))
