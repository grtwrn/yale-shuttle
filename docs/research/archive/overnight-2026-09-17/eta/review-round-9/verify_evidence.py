from pathlib import Path
import json,hashlib,subprocess,collections
O=Path(__file__).resolve().parent
repo=Path('/home/gwarren/projects/yale-shuttle-watcher/overnight-eta-2026-09-17')
plan=json.loads((O/'PLAN.json').read_text())
assert subprocess.check_output(['git','rev-parse','HEAD'],cwd=repo,text=True).strip()==plan['head']
assert not subprocess.check_output(['git','status','--porcelain'],cwd=repo,text=True).strip()
for name,want in plan['inputHashes'].items():
    assert hashlib.sha256(Path(name).read_bytes()).hexdigest()==want,name
rows=[json.loads(s) for s in (O/'pickup-census.jsonl').read_text().splitlines()]
base={(r['session'],r['at']):r for r in rows if r['arm']=='historical'}
ablation={(r['session'],r['at']):r for r in rows if r['arm']=='missingDestination'}
assert len(base)==len(ablation)==4688 and base.keys()==ablation.keys()
for key,r in base.items():
    a=ablation[key]
    assert r['contract']['boarding']==a['contract']['boarding']
    assert r['contract']['countdown']==a['contract']['countdown']
    assert r['waitSec']==a['waitSec']
    assert not r['wrongBus']
assert sum(r['wrongBus'] for r in ablation.values())==742
assert collections.Counter(r['contract']['relation'] for r in base.values())=={'same-visit':2490,'raw-current':1456,'different-bus':742}
missing=json.loads((O.parent/'cycle-6/missing-cases.json').read_text())
remaining={(r['session'],r['at']):r for r in missing if r['causal']['reason']=='only next-lap pickup; first destination precedes it'}
assert len(remaining)==38
unlinked={k:r for k,r in base.items() if r['contract'].get('relation')=='raw-current' and r['contract']['forecastLink'] is None}
assert unlinked.keys()==remaining.keys()
assert sum(r['retrospective']['afterRecordedDeparture'] for r in remaining.values())==14
assert all(all(p['hops']==29 for p in r['causal']['pickupRows']) for r in remaining.values())
outcomes=json.loads((O.parent/'cycle-6/paired-outcomes.json').read_text())
assert len(outcomes)==1400
for r in outcomes:
    b=base[(r['session'],r['at'])]
    assert abs(b['totalSec']-r['ordered']['totalSec'])<1e-9
    assert b['contract']['destinationAvailable']==r['ordered']['journeyAvailable']
worst=max((r for r in outcomes if r['changed']),key=lambda r:r['absErrorIncreaseSec'])
assert worst['sourceId']==63523 and round(worst['absErrorIncreaseSec'],2)==442.83
browser=json.loads((O/'browser-contract.json').read_text())
assert browser['completed'] and browser['resourcesClosed'] and not browser['errors'] and len(browser['states'])==8
boundaries=json.loads((O/'boundaries.json').read_text());assert boundaries['passed']==13
summary=json.loads((O/'summary.json').read_text());assert summary['exactProductionDecisions']==summary['exactRankings']==summary['inputRowsUnchanged']==4688
images=[p for team in ['eta','ux'] for p in (O.parent.parent/team).rglob('*') if p.is_file() and p.suffix.lower() in {'.png','.jpg','.jpeg','.webp'}]
report={'head':plan['head'],'cleanGit':True,'inputHashes':len(plan['inputHashes']),'pairedSelections':4688,'missingDestinationAttributionChanges':742,'sameBusLaterObserved':0,'rawUnlinked':38,'rawUnlinkedBeforeDeparture':24,'rawUnlinkedAfterDeparture':14,'preservedConnectedOutcomes':1400,'retainedWorstRegression':worst,'browserStates':8,'boundaryCases':13,'screenshotsAdded':0,'combinedScreenshots':{'n':len(images),'bytes':sum(p.stat().st_size for p in images)}}
assert report['combinedScreenshots']['bytes']<100*1024*1024
(O/'evidence.json').write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps(report,indent=2))
