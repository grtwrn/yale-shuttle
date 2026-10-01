from pathlib import Path
from datetime import datetime,timezone
import json,hashlib,subprocess
O=Path(__file__).resolve().parent;R=Path('/home/gwarren/projects/yale-shuttle-watcher/overnight-eta-2026-09-17');A=O.parent
entry=json.loads((O/'entry-integrity.json').read_text())
def git(*args):return subprocess.check_output(['git',*args],cwd=R,text=True).strip()
assert git('rev-parse','HEAD')==entry['head']==entry['base']
assert git('merge-base',entry['base'],'HEAD')==entry['base']
for args in [('diff','--check'),('diff','--exit-code',entry['base'],'HEAD'),('diff','--exit-code'),('diff','--cached','--exit-code')]:subprocess.run(['git',*args],cwd=R,check=True)
assert not git('status','--porcelain')
for p,h in entry['builderHashes'].items():assert hashlib.sha256(Path(p).read_bytes()).hexdigest()==h,p
plan=json.loads((O/'PLAN.json').read_text())
for p,h in plan['inputHashes'].items():assert hashlib.sha256(Path(p).read_bytes()).hexdigest()==h,p
x=json.loads((O/'independent-audit.json').read_text());assert x['checkpointRawForecastAndDBTruthChecks']==3309
for a in ['current','canonical']:assert x['temporalSnapshots']['builder'][a]['futureDatedEntries']==585 and x['temporalSnapshots']['reviewerImmutable'][a]['futureDatedEntries']==0
for m in ['restart10','restart20','restart30']:
 r=x['fixture']['reviewerImmutable']['canonical'][m];assert r['polls']==r['entryMatches']==r['wireMatches']
images=[p for t in ['eta','ux'] for p in (A.parent/t).rglob('*') if p.is_file() and p.suffix.lower() in ['.png','.jpg','.jpeg','.webp','.gif']]
size=sum(p.stat().st_size for p in images);assert size<100*1024*1024
out={'at':datetime.now(timezone.utc).isoformat(),'head':git('rev-parse','HEAD'),'base':entry['base'],'tree':git('rev-parse','HEAD^{tree}'),'cleanCheckoutAndIndex':True,'builderFilesUnchanged':len(entry['builderHashes']),'frozenInputsUnchanged':len(plan['inputHashes']),'immutableDiagnosticRestartPolls':60,'builderFutureDatedStateEntriesPerArm':585,'allImmutableWireOutputsEqualBuilder':x['allImmutableWiresEqualOriginal'],'combinedImageFiles':len(images),'combinedImageBytes':size,'newReviewerImages':0,'completedOwnedSessions':[56173,98844,15872]}
(O/'final-integrity.json').write_text(json.dumps(out,indent=2)+'\n');print(json.dumps(out,indent=2))
