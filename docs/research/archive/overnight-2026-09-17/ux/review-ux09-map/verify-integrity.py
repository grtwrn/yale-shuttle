from pathlib import Path
import hashlib,json,subprocess
repo=Path('/home/gwarren/projects/yale-shuttle-watcher/overnight-ux-2026-09-17')
art=repo.parent/'overnight-2026-09-17'; out=art/'ux/review-ux09-map'; entry=json.loads((out/'entry.json').read_text())
def git(*args): return subprocess.check_output(['git',*args],cwd=repo,text=True).strip()
def digest(p): return hashlib.sha256(p.read_bytes()).hexdigest()
assert git('rev-parse','HEAD')==entry['head']=='e7e9063df1fb15a364529075a702789e2bf348c7'
assert git('merge-base',entry['base'],'HEAD')==entry['base']
assert git('rev-parse','HEAD^{tree}')==entry['index']
assert not git('status','--porcelain=v1')
assert not git('diff','--cached')
for p,h in entry['tracked'].items(): assert digest(repo/p)==h,p
for p,h in entry['builder'].items(): assert digest(Path(p))==h,p
scope=git('diff','--name-only',entry['base']+'..HEAD').splitlines()
assert scope==['services/shuttle-v2/scripts/crash-recovery-check.mjs','services/shuttle-v2/scripts/map-lifecycle-check.mjs','services/shuttle-v2/web/src/CrashRecovery.tsx','services/shuttle-v2/web/src/TransitMap.tsx','services/shuttle-v2/web/src/main.tsx']
source_matches={}
for m in (repo/'services/shuttle-v2/web/dist').rglob('*.js.map'):
 d=json.loads(m.read_text())
 for s,c in zip(d['sources'],d['sourcesContent']):
  for name in ['main.tsx','TransitMap.tsx','CrashRecovery.tsx']:
   if s.endswith('/src/'+name):
    assert c==(repo/'services/shuttle-v2/web/src'/name).read_text(),name
    source_matches[name]=str(m.relative_to(repo))
assert len(source_matches)==3
reports={}
for path in ['verified/mobile/map-lifecycle.json','verified/desktop/map-lifecycle.json','verified/original-repro/map-stress.json','verified/feed/empty-service.json','verified/fullscreen/after-browser.json','recovery-mobile/crash-recovery.json','recovery-desktop/crash-recovery.json','recovery-real-trip/lifecycle.json','offline/offline-shell.json']:
 d=json.loads((out/path).read_text());assert d.get('completed') and d.get('resourcesClosed') and not d.get('errors'),path
 reports[path]={'completed':d['completed'],'resourcesClosed':d['resourcesClosed'],'errors':d.get('errors',[])}
images=[p for t in ['ux','eta'] for p in (art/t).rglob('*') if p.is_file() and p.suffix.lower() in ['.png','.jpeg','.jpg','.webp']]
image_bytes=sum(p.stat().st_size for p in images);assert image_bytes<100*1024*1024
summary={'head':entry['head'],'base':entry['base'],'checkoutIndexTreeUnchanged':True,'trackedFilesUnchanged':len(entry['tracked']),'builderFilesUnchanged':len(entry['builder']),'sourceScope':scope,'sourceBundleParity':source_matches,'passingBrowserReports':reports,'imageCount':len(images),'imageBytes':image_bytes}
(out/'integrity.json').write_text(json.dumps(summary,indent=2));print(json.dumps(summary,indent=2))
