import hashlib
import json
import subprocess
from pathlib import Path
root=Path('/home/gwarren/projects/yale-shuttle-watcher/overnight-ux-2026-09-17')
art=Path('/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux')
head='9d85b47fea1bdfaa7f2d2413b055eb9b83871031'
base='2dbc060bf517225c219fba8cbc5cb343fb19312b'
def git(*args): return subprocess.check_output(['git',*args],cwd=root)
assert git('rev-parse','HEAD').decode().strip()==head
assert git('rev-parse','HEAD^').decode().strip()==base
assert git('merge-base',base,head).decode().strip()==base
assert git('status','--porcelain=v1')==b''
evidence=json.loads((art/'ux-06-trip/integrity.json').read_text())
changed=git('diff','--name-only',base,head).decode().splitlines()
assert set(changed)==set(evidence['sources'])
for rel,expected in evidence['sources'].items():
    content=(root/rel).read_bytes()
    assert content==git('show',head+':'+rel), rel
    assert hashlib.sha256(content).hexdigest()==expected, rel
rel='services/shuttle-v2/web/src/TransitMap.tsx'
before=git('show',base+':'+rel).decode()
after=(root/rel).read_text()
assert before==(art/'ux-06-trip/baseline-TransitMap.tsx').read_text()
start='  const options: TripOption[] | null = useMemo'
end='  // Origin and destination are the same place'
old=before[before.index(start):before.index(end)]
new=after[after.index(start):after.index(end)]
assert old==new
assert hashlib.sha256(old.encode()).hexdigest()==evidence['numerical_options_sha256']
for name in ['planner.ts','journeyArrival.ts','arrivals.ts','etaSource.ts']:
    rel='services/shuttle-v2/web/src/'+name
    assert (root/rel).read_bytes()==git('show',base+':'+rel)
for args in [('diff','--check',base,head),('diff','--exit-code'),('diff','--cached','--exit-code')]: git(*args)
subprocess.run(['node','--check','services/shuttle-v2/scripts/trip-identity-check.mjs'],cwd=root,check=True)
images=[p for team in ['ux','eta'] for p in (art.parent/team).rglob('*') if p.is_file() and p.suffix.lower() in ['.png','.jpg','.jpeg','.webp']]
report={'head':head,'base':base,'parent_and_merge_base':base,'working_tree_and_index_clean':True,'sources':evidence['sources'],'frozen_baseline_matches_base':True,'numerical_options_sha256':evidence['numerical_options_sha256'],'numerical_modules_match_base':True,'screenshots':{'count':len(images),'bytes':sum(p.stat().st_size for p in images)}}
(art/'review-ux06-trip/integrity.json').write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps(report,indent=2))
