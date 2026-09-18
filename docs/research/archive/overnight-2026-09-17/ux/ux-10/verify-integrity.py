from pathlib import Path
import hashlib,json,subprocess
repo=Path('/home/gwarren/projects/yale-shuttle-watcher/overnight-ux-2026-09-17')
root=Path('/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/ux-10')
entry=json.loads((root/'entry-integrity.json').read_text())
def git(*args): return subprocess.check_output(['git',*args],cwd=repo).decode().strip()
assert git('rev-parse','HEAD')==entry['head']
index=repo/git('rev-parse','--git-path','index');assert hashlib.sha256(index.read_bytes()).hexdigest()==entry['index']
changed=[]
for f,h in entry['tracked'].items():
 if hashlib.sha256((repo/f).read_bytes()).hexdigest()!=h:changed.append(f)
assert changed==['services/shuttle-v2/web/src/TransitMap.tsx'],changed
untracked=git('ls-files','--others','--exclude-standard').splitlines()
assert sorted(untracked)==['services/shuttle-v2/scripts/saved-places-check.mjs','services/shuttle-v2/web/src/SavedPlaces.tsx'],untracked
before=(root/'TransitMap.entry.tsx').read_text(); after=(repo/changed[0]).read_text()
a=before.index('  const renderTripRow = ');b=before.index('  // The rows under each box',a); before=before[:a]+before[b:]
before=before.replace('  const [editingSavedId, setEditingSavedId] = useState<string | null>(null);\n  const [editingSavedMode, setEditingSavedMode] = useState(false);\n','')
a=before.index('      {!options && savedTrips.length > 0 && (');b=before.index('      {autoDetectOffer && (',a);before=before[:a]+'LISTS\n'+before[b:]
a=after.index('      {!options && <SavedPlaces');b=after.index('      {autoDetectOffer && (',a);after=after[:a]+'LISTS\n'+after[b:]
after=after.replace('import { SavedPlaces } from "./SavedPlaces";\n','')
assert before==after,'Unrelated shell change'
# Verify the actual tested bundle is built from exactly the proposed sources.
web=repo/'services/shuttle-v2/web';maps=list((web/'dist/assets').glob('*.js.map'))
for name in ['TransitMap.tsx','SavedPlaces.tsx']:
 contents=[]
 for p in maps:
  d=json.loads(p.read_text())
  contents += [text for source,text in zip(d['sources'],d['sourcesContent']) if source.endswith('/'+name)]
 assert contents==[(web/'src'/name).read_text()],name
for name in ['mobile/report.json','desktop/report.json','navigation/after-browser.json','feed/empty-service.json']:
 d=json.loads((root/'final'/name).read_text());assert d.get('passed') or d.get('completed');assert d.get('errors')==[]
images=[p for team in ['ux','eta'] for p in (root.parent.parent/team).rglob('*') if p.is_file() and p.suffix.lower() in ['.png','.jpg','.jpeg','.webp']]
size=sum(p.stat().st_size for p in images);assert size<100*1024*1024
report={'head':entry['head'],'indexUnchanged':True,'trackedCompared':len(entry['tracked']),'changed':changed,'new':untracked,'shellOutsideListsUnchanged':True,'sourceBundleParity':True,'screenshots':{'count':len(images),'bytes':size},'browserReportsPassed':4}
(root/'integrity.json').write_text(json.dumps(report,indent=2));print(json.dumps(report))
