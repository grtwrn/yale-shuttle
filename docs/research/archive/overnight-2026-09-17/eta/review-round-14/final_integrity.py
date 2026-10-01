from pathlib import Path
import json,hashlib,subprocess,datetime
O=Path(__file__).resolve().parent;B=O.parent/'cycle-15';entry=json.loads((O/'entry.json').read_text())
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
assert subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip()==entry['head']=='98e535b99649e74ca599d2e33bcfdc46df83d30d'
for p,h in entry['tracked'].items():assert sha(Path(p))==h,p
for p,h in entry['builder'].items():assert sha(B/p)==h,p
for p,h in entry['inputs'].items():assert sha(Path(p))==h,p
for args in [['git','diff','--check'],['git','diff','--exit-code',entry['head'],'HEAD'],['git','diff','--exit-code'],['git','diff','--cached','--exit-code']]:subprocess.run(args,check=True)
assert not subprocess.check_output(['git','status','--porcelain'],text=True).strip()
images=[p for team in ['eta','ux'] for p in (O.parent.parent/team).rglob('*') if p.is_file() and p.suffix.lower() in ['.png','.jpg','.jpeg','.webp']]
size=sum(p.stat().st_size for p in images);assert size<100*1024*1024
result={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'head':entry['head'],'base':entry['head'],'tree':subprocess.check_output(['git','rev-parse','HEAD^{tree}'],text=True).strip(),'trackedFilesUnchanged':len(entry['tracked']),'builderFilesUnchanged':len(entry['builder']),'frozenInputsUnchanged':len(entry['inputs']),'cleanCheckoutAndIndex':True,'imagesBothTeams':len(images),'imageBytesBothTeams':size,'newReviewerScreenshots':0}
(O/'final-integrity.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result,indent=2))
