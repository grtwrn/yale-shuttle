from pathlib import Path
import json,hashlib,subprocess,datetime
O=Path(__file__).resolve().parent;R=Path('/home/gwarren/projects/yale-shuttle-watcher/overnight-eta-2026-09-17');A=O.parents[1];head=subprocess.check_output(['git','rev-parse','HEAD'],cwd=R,text=True).strip();plan=json.loads((O/'PLAN.json').read_text());assert head==plan['base']
for args in [['git','diff','--check'],['git','diff','--exit-code'],['git','diff','--cached','--exit-code']]:subprocess.run(args,cwd=R,check=True)
assert not subprocess.check_output(['git','status','--porcelain'],cwd=R,text=True)
required=['verification.json','fixture-comparison.json','longitudinal.json','change-audit.json','all-large-tail-target-context.json','all-route-export-verification.json','all-route-red-input-comparison.json','RESULTS.md','REVIEW_REQUEST.md']
for p in required:assert (O/p).exists() and (O/p).stat().st_size
v=json.loads((O/'verification.json').read_text());assert v['currentBaselineExactArchivedReleaseOnRows']==150020 and v['checkpointTruthsVerified']==3309
c=json.loads((O/'fixture-comparison.json').read_text())['results']['canonical']
for m,r in c.items():assert r['counts']['wireMatches']==r['counts']['stateMatches']==r['counts']['frames']
e=json.loads((O/'all-route-export-verification.json').read_text());assert e['originalRawRows']==e['exactFreshExportMatches']==197354 and e['missing']==e['extra']==0
r=json.loads((O/'all-route-red-input-comparison.json').read_text());assert r['exactRowsAfterOriginalRedLapKeyProjection']==46790
h=json.loads((O/'hop-changes.json').read_text());assert all(abs(r['current']-r['canonical'])==1 for r in h)
for name in ['build-provenance.json','fixture-build-provenance.json']:
 b=json.loads((O/name).read_text());assert b['substitutions']==1
 for arm,want in b['bundles'].items():
  f=O/(arm+('-fixture' if name.startswith('fixture') else '')+'.mjs');assert hashlib.sha256(f.read_bytes()).hexdigest()==want
source={str(p.relative_to(R)):hashlib.sha256(p.read_bytes()).hexdigest() for p in [*sorted((R/'services/shuttle-v2/web/src/eta').glob('*.ts')),R/'services/shuttle-v2/src/server/serverEta.ts',R/'services/shuttle-v2/web/src/arrivals.ts']}
images=[p for t in ['eta','ux'] for p in (A/t).rglob('*') if p.is_file() and p.suffix.lower() in ['.png','.jpg','.jpeg','.webp','.gif']];size=sum(p.stat().st_size for p in images);assert size<100*1024*1024
result={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'head':head,'cleanCheckoutAndIndex':True,'artifactResultFilesVerified':required,'sourceHashes':source,'combinedImageFiles':len(images),'combinedImageBytes':size,'newETAImages':0,'scope':'Research artifacts only; no app/source-control/publication or watcher changes. All owned tool sessions collected; no browser/server started.'}
(O/'final-integrity.json').write_text(json.dumps(result,indent=2)+'\n')
hashes={p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(O.iterdir()) if p.is_file() and p.name not in ['artifact-hashes.json','finish.log']}
(O/'artifact-hashes.json').write_text(json.dumps(hashes,indent=2)+'\n');print(json.dumps({k:v for k,v in result.items() if k not in ['sourceHashes','artifactResultFilesVerified']},indent=2));print('Hashed artifacts:',len(hashes))
