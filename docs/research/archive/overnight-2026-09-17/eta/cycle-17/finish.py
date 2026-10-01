from pathlib import Path
import json,hashlib,subprocess,datetime
O=Path(__file__).resolve().parent;entry=json.loads((O/'entry.json').read_text());plan=json.loads((O/'PLAN.json').read_text());W=Path('/home/gwarren/projects/yale-shuttle-watcher/overnight-eta-2026-09-17');sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
head=subprocess.check_output(['git','rev-parse','HEAD'],cwd=W,text=True).strip();assert head==entry['head'];status=subprocess.check_output(['git','status','--porcelain'],cwd=W,text=True);assert status==entry['git_status']==''
for p,h in entry['tracked'].items():assert sha(W/p)==h,p
for p,h in entry['prior'].items():assert sha(Path(p))==h,p
for p,h in plan['inputHashes'].items():assert sha(Path(p))==h,p
for p,h in plan['frozen'].items():assert sha(O/p)==h,p
for p in ['capture-verification.json','alignment-verification.json','verification.json','semantic-verification.json','decision-verification.json','summary.json']:assert (O/p).exists(),p
result={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'head':head,'cleanCheckoutAndIndex':True,'trackedFilesUnchanged':len(entry['tracked']),'priorArtifactsUnchanged':len(entry['prior']),'frozenInputsUnchanged':len(plan['inputHashes']),'copiedBundlesAndInitialCheckpointsUnchanged':len(plan['frozen']),'newScreenshots':0,'applicationChanges':0}
(O/'final-integrity.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result,indent=2))
