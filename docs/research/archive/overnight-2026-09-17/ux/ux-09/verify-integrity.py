from pathlib import Path
import subprocess, json, hashlib
repo=Path('/home/gwarren/projects/yale-shuttle-watcher/overnight-ux-2026-09-17')
out=Path('/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/ux-09')
entry=json.loads((out/'entry.json').read_text())
def git(*args):return subprocess.check_output(['git',*args],cwd=repo,text=True)
assert git('rev-parse','HEAD').strip()==entry['head']
assert git('diff','--cached')==entry['index']==''
expected={'services/shuttle-v2/web/src/main.tsx','services/shuttle-v2/web/src/CrashRecovery.tsx','services/shuttle-v2/scripts/crash-recovery-check.mjs'}
changed=set(git('diff','--name-only').splitlines())|set(git('ls-files','--others','--exclude-standard').splitlines())
assert changed==expected,(changed,expected)
base=(out/'baseline-main.tsx').read_text()
start=base.index('      return (',base.index('    if (this.state.error)'))
end=base.index('\n    }\n    return this.props.children;',start)
replacement=base[:start]+'      return <CrashRecovery error={this.state.error} />;'+base[end:]
replacement=replacement.replace('import BerthReview from "./BerthReview";', 'import BerthReview from "./BerthReview";\nimport CrashRecovery from "./CrashRecovery";')
assert replacement==(repo/'services/shuttle-v2/web/src/main.tsx').read_text(), 'Only fallback presentation/import changed in entry point'
# Vite sourcemaps contain the exact final application source used by the built-SPA tests.
matched={}
for p in (repo/'services/shuttle-v2/web/dist/assets').glob('*.js.map'):
 data=json.loads(p.read_text())
 for source,contents in zip(data['sources'],data['sourcesContent']):
  for name in ['main.tsx','CrashRecovery.tsx']:
   if source.endswith('/src/'+name):
    assert contents==(repo/'services/shuttle-v2/web/src'/name).read_text(),name
    matched[name]=p.name
assert set(matched)=={'main.tsx','CrashRecovery.tsx'}
reports={}
for name in ['release/mobile/crash-recovery.json','release/desktop/crash-recovery.json','verified/feed/empty-service.json','offline-second/offline-shell.json']:
 d=json.loads((out/name).read_text());assert d['completed'] and d['resourcesClosed'] and not d['errors'],name
 reports[name]={'completed':d['completed'],'resourcesClosed':d['resourcesClosed'],'checks':d['checks']}
images=[p for team in ['ux','eta'] for p in (out.parent.parent/team).rglob('*') if p.is_file() and p.suffix.lower() in {'.png','.jpg','.jpeg','.webp','.gif'}]
size=sum(p.stat().st_size for p in images)
assert size<100*1024*1024
result={'head':entry['head'],'indexUnchanged':True,'scope':sorted(expected),'sourceHashes':{s:hashlib.sha256((repo/s).read_bytes()).hexdigest() for s in sorted(expected)},'builtSource':matched,'reports':reports,'screenshots':{'count':len(images),'bytes':size},'unchangedEntryBehavior':'Error capture, review routing, PWA registration and pull-to-refresh are exact baseline; only fallback content/import replaced'}
(out/'integrity.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps(result,indent=2))
