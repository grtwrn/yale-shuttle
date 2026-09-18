from pathlib import Path
import json,hashlib,subprocess,statistics
O=Path(__file__).resolve().parent;C=O.parent/'cycle-6'
repo=Path('/home/gwarren/projects/yale-shuttle-watcher/overnight-eta-2026-09-17')
read=lambda p:json.loads(p.read_text())
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
old=read(C/'artifact-hashes.json')['files']
for name,digest in old.items():assert sha(C/name)==digest,name
rows=[json.loads(s) for s in (O/'candidate-decisions.jsonl').read_text().splitlines()]
expected=[json.loads(s) for s in (C/'ordered-decisions.jsonl').read_text().splitlines()]
assert len(rows)==len(expected)==4688
for r,e in zip(rows,expected):
 assert r['session']==e['session'] and r['at']==e['at']
 for key in ['option','trace','order']:assert r[key]==e[key]
lookup={(r['session'],r['at']):r for r in rows}
paired=read(C/'paired-outcomes.json');scores=read(C/'counterfactual-scores.json')
changed=[]
for x in paired:
 r=lookup[x['session'],x['at']];o=r['option']
 assert o['totalSec']==x['ordered']['totalSec']
 assert o.get('journeyArrival',{}).get('busName',o['busName'])==x['bus']
 assert abs((o['totalSec']-x['actualConnectedSec'])-x['ordered']['errorSec'])<1e-9
 if x['changed']:changed.append(x)
assert len(paired)==1400 and len(changed)==30
assert abs(statistics.mean(abs(x['ordered']['errorSec']) for x in changed)-scores['pairedChanged']['ordered']['mae'])<1e-9
worst=max(changed,key=lambda x:x['absErrorIncreaseSec'])
assert worst['sourceId']==63523 and 442.8<worst['absErrorIncreaseSec']<442.9
files=['services/shuttle-v2/web/src/journeyArrival.ts','services/shuttle-v2/web/src/TransitMap.tsx','services/shuttle-v2/web/src/atStopJourney.test.ts','docs/server-side-eta.md']
sourceHashes={name:sha(repo/name) for name in files}
subprocess.run(['git','diff','--check'],cwd=repo,check=True)
subprocess.run(['git','diff','--cached','--exit-code'],cwd=repo,check=True)
head=subprocess.check_output(['git','rev-parse','HEAD'],cwd=repo,text=True).strip()
assert head=='77c32b80256215eb36516e7bb68c9d7664c7697e'
extraction=read(O/'source-extraction.json')
assert extraction['source_sha256']==sourceHashes['services/shuttle-v2/web/src/TransitMap.tsx']
assert extraction['candidate_sha256']==sha(O/'shell-candidate.generated.mts')
walk=read(O/'walk-gate-browser.json');assert len(walk['cases'])==5 and not walk['errors'] and walk['resourcesClosed']
for r in walk['cases']:
 if r['walkSec'] in [100,119]:assert 'Connection uncertain' in r['deadlineText']
deadline=read(O/'deadline-browser.json');assert deadline['checks']==13 and not deadline['errors']
assert len(deadline['sessions'][0]['deadlines'])==3
screens=[p for team in [O.parent,O.parent.parent/'ux'] for p in team.rglob('*') if p.is_file() and p.suffix.lower() in ['.png','.jpg','.jpeg','.webp']]
screenbytes=sum(p.stat().st_size for p in screens);assert screenbytes<100*1024**2
result={'head':head,'sourceHashes':sourceHashes,'originalCycle6HashesPreserved':len(old),'exactPrototypeDecisions':len(rows),'pairedConnectedOutcomes':len(paired),'restoredOutcomes':len(changed),'retainedWorstRegression':worst,'changedScores':scores['pairedChanged'],'stability':scores['stability'],'walkingCases':len(walk['cases']),'deadlineStates':3,'screenshotFilesBothTeams':len(screens),'screenshotBytesBothTeams':screenbytes,'limits':'Existing connected outcomes independently audited in round6; this checks identity/forecast transfer, not a new raw-GPS/DB audit or holdout. No full suite/staging/production claim.'}
(O/'evidence.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps({k:v for k,v in result.items() if k not in ['sourceHashes','retainedWorstRegression','changedScores','stability']},indent=2))
