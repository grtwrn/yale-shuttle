from pathlib import Path
import hashlib, json, subprocess
root=Path('/home/gwarren/projects/yale-shuttle-watcher/overnight-ux-2026-09-17')
out=Path('/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/ux-10-weather')
entry=json.loads((out/'entry-integrity.json').read_text())
def git(*args): return subprocess.check_output(['git',*args],cwd=root).decode().strip()
def sha(p): return hashlib.sha256(p.read_bytes()).hexdigest()
assert git('rev-parse','HEAD')==entry['head']
assert sha(root/git('rev-parse','--git-path','index'))==entry['index']
changed=[f for f,h in entry['files'].items() if not (root/f).is_file() or sha(root/f)!=h]
assert changed==['services/shuttle-v2/web/src/TransitMap.tsx'], changed
untracked=git('ls-files','--others','--exclude-standard').splitlines()
assert untracked==['services/shuttle-v2/scripts/weather-controls-check.mjs'],untracked
current=(root/changed[0]).read_text(); before=(out/'TransitMap.entry.tsx').read_text()
assert before==subprocess.check_output(['git','show','HEAD:'+changed[0]],cwd=root).decode()
# Everything outside the weather state/markup is exact entry source.
state='  /** Hour-by-hour panel open?'
unit='  /** °F or °C, the rider\'s call'
markup='      {/* The weather, always on'
end='      {/* Nothing is planned because one end is still just text'
assert current.split(state)[0]==before.split(state)[0]
assert current.split(unit)[1].split(markup)[0]==before.split(unit)[1].split(markup)[0]
assert current.split(end)[1]==before.split(end)[1]
def match_map(folder,expected):
    for p in folder.rglob('*.map'):
        m=json.loads(p.read_text())
        for source,content in zip(m.get('sources',[]),m.get('sourcesContent',[])):
            if source.endswith('/TransitMap.tsx'):
                assert content==expected,(p,source)
                return str(p)
    raise AssertionError('TransitMap sourcemap missing')
baseline_map=match_map(out/'entry-dist',before)
current_map=match_map(root/'services/shuttle-v2/web/dist',current)
reports={}
for rel in ['baseline/report.json','final/mobile/report.json','final/desktop/report.json']:
    value=json.loads((out/rel).read_text())
    assert value['passed'] and value['closed'] and value['errors']==[],rel
    reports[rel]=len(value['checks'])
nav=json.loads((out/'final/navigation/after-browser.json').read_text())
assert nav['completed'] and nav['errors']==[]
reports['final/navigation/after-browser.json']=len(nav['checks'])
extra=out/'supplemental-verified/report.json'
if extra.exists():
    value=json.loads(extra.read_text())
    assert value['passed'] and value['closed'] and value['errors']==[]
    reports['supplemental-verified/report.json']=len(value['checks'])
images=[p for team in ['ux','eta'] for p in (out.parent.parent/team).rglob('*') if p.is_file() and p.suffix.lower() in ['.png','.jpg','.jpeg','.webp']]
size=sum(p.stat().st_size for p in images)
assert size<100*1024*1024
subprocess.run(['git','diff','--check'],cwd=root,check=True)
result={'head':entry['head'],'unchanged_tracked_files':len(entry['files'])-1,'changed':changed,'new':untracked,'index_preserved':True,'baseline_map':baseline_map,'current_map':current_map,'reports':reports,'combined_images':len(images),'combined_image_bytes':size,'source_sha256':sha(root/changed[0])}
(out/'integrity.json').write_text(json.dumps(result,indent=2))
(out/'proposal.patch').write_bytes(subprocess.check_output(['git','diff'],cwd=root))
print(json.dumps(result,indent=2))
