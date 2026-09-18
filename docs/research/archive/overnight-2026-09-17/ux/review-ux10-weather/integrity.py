from pathlib import Path
import hashlib,json,subprocess
root=Path('/home/gwarren/projects/yale-shuttle-watcher/overnight-ux-2026-09-17')
out=Path('/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/review-ux10-weather')
builder=out.parent/'ux-10-weather'
base='56a5258bd4c6a4869667a99d3b480b12a3ce61c9'
head='413c85ac5158ef5d4f5c0c50ecf7c8e9c43a1c97'
def git(*args): return subprocess.check_output(['git',*args],cwd=root).decode().strip()
def sha(p): return hashlib.sha256(p.read_bytes()).hexdigest()
entry=json.loads((out/'entry.json').read_text())
assert git('rev-parse','HEAD')==head==entry['head']
assert git('merge-base',base,head)==base
assert git('write-tree')==entry['index']
assert git('status','--porcelain')==''
assert all(sha(root/f)==h for f,h in entry['files'].items())
assert all(sha(builder/f)==h for f,h in json.loads((out/'builder-hashes.json').read_text()).items())
files=git('diff','--name-only',base,head).splitlines()
assert files==['services/shuttle-v2/scripts/weather-controls-check.mjs','services/shuttle-v2/web/src/TransitMap.tsx']
f=files[1]; current=(root/f).read_text(); before=subprocess.check_output(['git','show',base+':'+f],cwd=root).decode()
assert before==(builder/'TransitMap.entry.tsx').read_text()
state='  /** Hour-by-hour panel open?'; unit='  /** °F or °C, the rider\'s call'; markup='      {/* The weather, always on'; end='      {/* Nothing is planned because one end is still just text'
assert current.split(state)[0]==before.split(state)[0]
assert current.split(unit)[1].split(markup)[0]==before.split(unit)[1].split(markup)[0]
assert current.split(end)[1]==before.split(end)[1]
def match_map(folder,expected):
 for p in folder.rglob('*.map'):
  m=json.loads(p.read_text())
  for name,content in zip(m.get('sources',[]),m.get('sourcesContent',[])):
   if name.endswith('/TransitMap.tsx'):
    assert content==expected
    return str(p)
 raise AssertionError('Missing TransitMap source map')
maps=[match_map(root/'services/shuttle-v2/web/dist',current),match_map(builder/'entry-dist',before)]
reports={}
for rel in ['browser/mobile/report.json','browser/desktop/report.json','extra-corrected/report.json','supplemental/report.json']:
 x=json.loads((out/rel).read_text()); assert x['passed'] and x['closed'] and x['errors']==[]; reports[rel]=len(x['checks'])
for rel,closure in [('browser/navigation/after-browser.json',None),('feed/empty-service.json','resourcesClosed')]:
 x=json.loads((out/rel).read_text()); assert x['completed'] and x['errors']==[]
 if closure: assert x[closure]
 reports[rel]=len(x['checks'])
initial=json.loads((out/'extra/report.json').read_text())
assert initial['closed'] and initial['errors']==[] and 'element is not enabled' in initial['failure']
images=[p for team in ['ux','eta'] for p in (out.parent.parent/team).rglob('*') if p.is_file() and p.suffix.lower() in ['.png','.jpg','.jpeg','.webp']]
size=sum(p.stat().st_size for p in images); assert size<100*1024*1024
result={'head':head,'base':base,'checkout_clean':True,'index_tree_unchanged':True,'tracked_hashes':len(entry['files']),'builder_hashes':len(json.loads((out/'builder-hashes.json').read_text())),'scope':files,'source_maps':maps,'passing_browser_reports':reports,'retained_initial_fixture_failure':True,'shared_image_count':len(images),'shared_image_bytes':size}
(out/'integrity.json').write_text(json.dumps(result,indent=2)); print(json.dumps(result,indent=2))
