from pathlib import Path
import hashlib,json,subprocess
out=Path(__file__).resolve().parent
repo=Path('/home/gwarren/projects/yale-shuttle-watcher/overnight-eta-2026-09-17')
git=lambda *a:subprocess.check_output(['git',*a],cwd=repo)
head='53b4076b6273deb6f4e2ad436420461a0e5174f4';base='373505d5076f21a08de69d9587be9b2a55956642'
assert git('rev-parse','HEAD').decode().strip()==head
assert git('merge-base',base,head).decode().strip()==base
assert git('diff')==git('diff','--cached')==git('status','--porcelain')==b''
assert git('diff','--check',base,head)==b''
assert git('diff',base,head)==(out.parent/'cycle-9/proposal.patch').read_bytes()
source=json.loads((out/'source-hashes.json').read_text())
for p,h in source.items():assert hashlib.sha256((repo/p).read_bytes()).hexdigest()==h
frozen=json.loads((out/'builder-hashes.json').read_text())
for p,h in frozen.items():assert hashlib.sha256((out.parent/p).read_bytes()).hexdigest()==h,p
result=dict(head=head,base=base,clean=True,sourceFiles=len(source),unchangedBuilderArtifacts=len(frozen),proposalPatchExact=True)
(out/'final-integrity.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result,indent=2))
