from pathlib import Path
import hashlib,json,subprocess
repo=Path('/home/gwarren/projects/yale-shuttle-watcher/overnight-ux-2026-09-17')
root=Path('/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/review-ux10')
art=root.parent
entry=json.loads((root/'entry.json').read_text())
def git(*a):return subprocess.check_output(['git',*a],cwd=repo).decode().strip()
def digest(p):return hashlib.sha256(p.read_bytes()).hexdigest()
assert git('rev-parse','HEAD')==entry['head']=='8f20f201a6cb7935ac3af4b983c173830510a277'
assert git('merge-base','HEAD',entry['base'])==entry['base']=='98e535b99649e74ca599d2e33bcfdc46df83d30d'
assert git('write-tree')==entry['index']
assert not git('status','--porcelain')
for p,h in entry['tracked'].items():assert digest(repo/p)==h,p
for p,h in entry['builder'].items():assert digest(art/p)==h,p
previous='a5966b1e87a9f4fbecf3888456fbd272f186fcb8'
assert git('diff','--name-only',previous,'HEAD').splitlines()==['services/shuttle-v2/scripts/saved-places-check.mjs','services/shuttle-v2/web/src/SavedPlaces.tsx','services/shuttle-v2/web/src/TransitMap.tsx']
assert len(git('diff','--name-only',entry['base'],'HEAD').splitlines())==9
# Remove only the bounded saved-list replacement; everything else must match
# the independently approved previous map/recovery candidate byte-for-byte.
p='services/shuttle-v2/web/src/TransitMap.tsx'
prior=git('show',previous+':'+p)+'\n';current=(repo/p).read_text()
prior=prior.replace('  const [editingSavedId, setEditingSavedId] = useState<string | null>(null);\n  const [editingSavedMode, setEditingSavedMode] = useState(false);\n','')
a=prior.index('  const renderTripRow = ');b=prior.index('  // The rows under each box',a);prior=prior[:a]+prior[b:]
a=prior.index('      {!options && savedTrips.length > 0 && (');b=prior.index('      {autoDetectOffer && (',a);prior=prior[:a]+'LISTS\n'+prior[b:]
a=current.index('      {!options && <SavedPlaces');b=current.index('      {autoDetectOffer && (',a);current=current[:a]+'LISTS\n'+current[b:]
current=current.replace('import { SavedPlaces } from "./SavedPlaces";\n','')
assert prior==current,'Unrelated shell edits'
# Independently verify the preserved baseline bundle, without repeating its
# completed browser experiment, and the prior two-map scope against supplied base.
old_shell=git('show',previous+':'+p)+'\n'
assert (art/'ux-10/TransitMap.entry.tsx').read_text()==old_shell
found=[]
for file in (art/'ux-10/entry-dist/assets').glob('*.js.map'):
 data=json.loads(file.read_text())
 found.extend(c for s,c in zip(data['sources'],data['sourcesContent']) if s.endswith('/src/TransitMap.tsx'))
assert found==[old_shell]
old_shell=old_shell.replace('import { cancelMapTouchZoom } from "./mapLifecycle";\n','').replace('      cancelMapTouchZoom(map);\n','')
old_shell=old_shell.replace('    // Filters rebuild this map and changing tabs removes it. As on trip maps,\n    // disable CSS zoom: map.stop() does not cancel its delayed completion.\n','')
old_shell=old_shell.replace('    // Done can remove the map during a zoom. Keep zoom immediate, as on trip\n    // maps, so a delayed CSS transition cannot run after teardown.\n','')
old_shell=old_shell.replace('const map = L.map(ref.current, { zoomControl: true, scrollWheelZoom: true, zoomAnimation: false });','const map = L.map(ref.current, { zoomControl: true, scrollWheelZoom: true });')
assert old_shell==git('show',entry['base']+':'+p)+'\n'
# Verify the built production bundle actually embeds the candidate sources.
web=repo/'services/shuttle-v2/web'
for name in ['TransitMap.tsx','SavedPlaces.tsx','CrashRecovery.tsx','mapLifecycle.ts','main.tsx']:
 found=[]
 for file in (web/'dist/assets').glob('*.js.map'):
  data=json.loads(file.read_text())
  found.extend(c for s,c in zip(data['sources'],data['sourcesContent']) if s.endswith('/src/'+name))
 assert found==[(web/'src'/name).read_text()],name
reports=['saved/mobile/report.json','saved/desktop/report.json','saved/navigation/after-browser.json','saved/feed/empty-service.json','touch/map-touch-teardown.json','map/map-lifecycle.json','crash/crash-recovery.json','actual-trip/lifecycle.json','offline/offline-shell.json','extra-mobile/report.json','extra-desktop/report.json']
for file in reports:
 d=json.loads((root/file).read_text());assert d.get('passed') or d.get('completed'),file
 assert d.get('errors')==[],file
 if file=='saved/navigation/after-browser.json':
  script=(repo/'services/shuttle-v2/scripts/navigation-search-check.mjs').read_text()
  assert 'await page.close(); await ctx.close();' in script and 'await browser.close();' in script
 else:assert d.get('closed') or d.get('resourcesClosed'),file
 if file=='touch/map-touch-teardown.json':
  assert len(d['cases'])==8
  for c in d['cases']:assert c['listenersBefore']==c['listenersAfterRemoval'],c['name']
images=[p for team in ['ux','eta'] for p in (art.parent/team).rglob('*') if p.is_file() and p.suffix.lower() in ['.png','.jpg','.jpeg','.webp']]
size=sum(p.stat().st_size for p in images);assert size<100*1024*1024
summary={'head':entry['head'],'base':entry['base'],'checkoutUnchanged':True,'indexUnchanged':True,'trackedHashes':len(entry['tracked']),'builderHashes':len(entry['builder']),'newSliceScope':3,'cumulativeScope':9,'shellOutsideSavedListsUnchangedFromPreviousApproval':True,'sourceBundleParity':True,'baselineBundleProvenance':True,'priorMapScopeMatchesExactBase':True,'reportsPassed':len(reports),'screenshots':{'count':len(images),'bytes':size}}
(root/'integrity.json').write_text(json.dumps(summary,indent=2));print(json.dumps(summary,indent=2))
