from pathlib import Path
import json,hashlib,subprocess,datetime
O=Path(__file__).resolve().parent;T=O.parent;E=json.loads((O/'entry.json').read_text())
def digest(p):
 h=hashlib.sha256()
 with p.open('rb') as f:
  for b in iter(lambda:f.read(1048576),b''):h.update(b)
 return h.hexdigest()
assert subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip()==E['head']==E['base']
for group in ['tracked','builder','inputs']:
 for p,h in E[group].items():assert digest(Path(p))==h,(group,p)
for args in [['git','diff','--exit-code',E['base'],'HEAD'],['git','diff','--exit-code'],['git','diff','--cached','--exit-code'],['git','diff','--check']]:subprocess.run(args,check=True)
assert subprocess.check_output(['git','status','--porcelain'],text=True)==''
images=[p for team in ['eta','ux'] for p in (T.parent/team).rglob('*') if p.is_file() and p.suffix.lower() in ['.png','.jpg','.jpeg','.webp']];total=sum(p.stat().st_size for p in images);assert total<100*1024*1024
report={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'head':E['head'],'base':E['base'],'tree':subprocess.check_output(['git','rev-parse','HEAD^{tree}'],text=True).strip(),'trackedFilesUnchanged':len(E['tracked']),'builderArtifactsUnchanged':len(E['builder']),'frozenInputsUnchanged':len(E['inputs']),'checkoutAndIndexClean':True,'sharedScreenshots':{'files':len(images),'bytes':total},'reviewerScreenshotsAdded':0}
(O/'final-integrity.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report,indent=2))
