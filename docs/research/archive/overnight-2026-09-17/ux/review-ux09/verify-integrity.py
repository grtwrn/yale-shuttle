import hashlib,json,pathlib,subprocess
repo=pathlib.Path('/home/gwarren/projects/yale-shuttle-watcher/overnight-ux-2026-09-17')
out=pathlib.Path('/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/review-ux09')
builder=out.parent/'ux-09'
git=lambda *args: subprocess.check_output(['git','-C',str(repo),*args]).decode().strip()
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
e=json.loads((out/'entry.json').read_text())
assert git('rev-parse','HEAD')==e['head']=='da51fcb0af70f554ef0b141aa07d4a390f3c7de0'
assert git('rev-parse','HEAD^{tree}')==e['tree']
assert git('ls-files','--stage')==e['index']
assert git('status','--porcelain')==e['status']==''
assert git('merge-base',e['base'],e['head'])==e['base']=='98e535b99649e74ca599d2e33bcfdc46df83d30d'
for name,h in e['files'].items():assert sha(repo/name)==h,name
for name,h in e['builder'].items():assert sha(pathlib.Path(name))==h,name
scope=git('diff','--name-only',e['base'],e['head']).splitlines()
expected=['services/shuttle-v2/scripts/crash-recovery-check.mjs','services/shuttle-v2/web/src/CrashRecovery.tsx','services/shuttle-v2/web/src/main.tsx']
assert scope==expected
builder_meta=json.loads((builder/'integrity.json').read_text())
for name in scope:assert sha(repo/name)==builder_meta['sourceHashes'][name]
service=repo/'services/shuttle-v2'
def sources(dist):
 result={}
 for p in (dist/'assets').glob('*.js.map'):
  m=json.loads(p.read_text())
  for n,c in zip(m['sources'],m['sourcesContent']):
   if '/src/' in n and not '/stop-data/' in n:result[n.split('/src/')[-1]]=c
 return result
current=sources(service/'web/dist')
for n in ['main.tsx','CrashRecovery.tsx','TransitMap.tsx']:
 assert current[n]==(service/'web/src'/n).read_text(),n
old=git('show',e['base']+':services/shuttle-v2/web/src/main.tsx')+'\n'
assert (builder/'baseline-main.tsx').read_text()==old
baseline=sources(builder/'baseline-dist')
assert baseline['main.tsx']==old
assert baseline['TransitMap.tsx']==current['TransitMap.tsx']
# All production entry behavior outside the changed fallback and new import is exact.
new=current['main.tsx'].replace('import CrashRecovery from "./CrashRecovery";\n','')
start='    if (this.state.error) {';end='    return this.props.children;'
assert old.split(start)[0]==new.split(start)[0]
assert old.split(end)[1]==new.split(end)[1]
# Independent artifact fault bundle kept every production runtime module other than injected entry.
fault=sources(out/'extra-second/fault-dist')
for n in ['CrashRecovery.tsx','TransitMap.tsx','tripDraft.ts','pullToRefresh.ts']:
 assert fault[n]==current[n],n
reports={}
for rel in ['verified/mobile/crash-recovery.json','verified/desktop/crash-recovery.json','verified/feed/empty-service.json','extra-second/lifecycle.json','offline/offline-shell.json']:
 p=out/rel
 if not p.exists() and rel=='verified/feed/empty-service.json':p=out/'verified/feed/empty-service-check.json'
 r=json.loads(p.read_text());assert r['completed'] and r['resourcesClosed'] and not r['errors'],rel
 reports[rel]={'completed':r['completed'],'resourcesClosed':r['resourcesClosed'],'checks':len(r['checks'])}
images=[p for team in ['eta','ux'] for p in (out.parent.parent/team).rglob('*') if p.is_file() and p.suffix.lower() in ['.png','.jpg','.jpeg','.webp']]
image_bytes=sum(p.stat().st_size for p in images);assert image_bytes<100*1024*1024
summary={'head':e['head'],'base':e['base'],'scope':scope,'trackedFilesPreserved':len(e['files']),'builderFilesPreserved':len(e['builder']),'checkoutIndexTreeUnchanged':True,'sourceAndBuiltBundleMatch':True,'entryOutsideFallbackUnchanged':True,'baselineMapSourceMatches':True,'reports':reports,'imageFiles':len(images),'imageBytes':image_bytes}
(out/'integrity.json').write_text(json.dumps(summary,indent=2)+'\n')
print(json.dumps(summary,indent=2))
