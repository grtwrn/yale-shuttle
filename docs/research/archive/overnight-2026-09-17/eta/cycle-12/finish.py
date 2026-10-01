from pathlib import Path
import hashlib,json,subprocess
O=Path(__file__).resolve().parent;P=O.parent
repo=Path('/home/gwarren/projects/yale-shuttle-watcher/overnight-eta-2026-09-17')
head=subprocess.check_output(['git','rev-parse','HEAD'],cwd=repo,text=True).strip()
assert head==json.loads((O/'PLAN.json').read_text())['head']
assert subprocess.check_output(['git','status','--porcelain'],cwd=repo,text=True)==''
for cmd in [['git','diff','--check'],['git','diff','--exit-code'],['git','diff','--cached','--exit-code'],
            ['git','apply','--check',str(O/'eta-projection.patch')],['git','apply','--check',str(O/'eta-tests.patch')]]:
    subprocess.run(cmd,cwd=repo,check=True,capture_output=True,text=True)
overlay=json.loads((O/'overlay.json').read_text())
for target,v in overlay.items():
    assert target.startswith(str(repo/'services/shuttle-v2/web/src')+'/')
    assert hashlib.sha256(Path(v['artifact']).read_bytes()).hexdigest()==v['sha256']
types=json.loads((O/'typecheck.json').read_text());assert len(types['typechecks'])==2
assert all(x['diagnostics']==0 for x in types['typechecks'])
assert '9 passed' in (O/'tests-corrected.log').read_text()
images=[f for team in ['eta','ux'] for f in (P.parent/team).rglob('*') if f.is_file() and f.suffix.lower() in {'.png','.jpg','.jpeg','.webp'}]
own_images=[f for f in O.rglob('*') if f.suffix.lower() in {'.png','.jpg','.jpeg','.webp'}];assert not own_images
report=dict(head=head,checkoutAndIndexClean=True,appChanges=0,patchesApply=True,virtualTypechecks=2,
            artifactTests=9,newScreenshots=0,combinedImageFiles=len(images),combinedImageBytes=sum(f.stat().st_size for f in images),
            historicalVerification=json.loads((O/'verification.json').read_text()))
assert report['combinedImageBytes']<100*1024*1024
(O/'final-integrity.json').write_text(json.dumps(report,indent=2)+'\n')
hashes={str(f.relative_to(O)):hashlib.sha256(f.read_bytes()).hexdigest() for f in O.iterdir() if f.is_file() and f.name!='artifact-hashes.json'}
(O/'artifact-hashes.json').write_text(json.dumps(hashes,indent=2)+'\n')
print(json.dumps({k:v for k,v in report.items() if k!='historicalVerification'},indent=2))
