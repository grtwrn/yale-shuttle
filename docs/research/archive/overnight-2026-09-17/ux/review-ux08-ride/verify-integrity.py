from pathlib import Path
import hashlib, json, subprocess
R=Path('/home/gwarren/projects/yale-shuttle-watcher/overnight-ux-2026-09-17')
O=Path(__file__).resolve().parent
HEAD='bffa61342d00ce87fca5b8f228e206357b8b93b5'
BASE='8aa67bd7f3883598f9458d825d97a52cbc004e0f'
PICKUP='7f681d92a7d30331728d637216dabecf9d9e356c'
def git(*a): return subprocess.check_output(['git',*a],cwd=R,text=True)
def before(rev,p): return git('show',rev+':'+p)
def block(s,a,b): return s[s.index(a):s.index(b,s.index(a))]
def sha(p): return hashlib.sha256(p.read_bytes()).hexdigest()
assert git('rev-parse','HEAD').strip()==HEAD
assert git('rev-parse','HEAD^').strip()==PICKUP
assert git('rev-parse',PICKUP+'^').strip()==BASE
assert git('merge-base',HEAD,BASE).strip()==BASE
assert not git('status','--porcelain=v1').strip()
assert (O/'start-git.txt').read_text()==git('rev-parse','HEAD','HEAD^{tree}')
subprocess.run(['git','diff','--check',BASE+'..'+HEAD],cwd=R,check=True)
files=git('diff','--name-only',BASE+'..'+HEAD).splitlines()
assert len(files)==12 and all(p.startswith('services/shuttle-v2/') for p in files)
shell='services/shuttle-v2/web/src/TransitMap.tsx'
current=(R/shell).read_text(); pickup=before(PICKUP,shell); base=before(BASE,shell)
unchanged={
 'rideMapAndStops':('const RideRouteMap:', 'const OnBusBanner:'),
 'rideStopArithmetic':('const OnBusBanner:', '  const getOffAlertRef = useRef'),
 'notificationTrigger':('  useEffect(() => {\n    if (stopsRemaining === null', '  const etaStr = etaSec'),
 'autoEndEngine':('  const offBusStreakRef = React.useRef', '  const [stopGroups, setStopGroups]'),
}
for name,(a,b) in unchanged.items(): assert block(base,a,b)==block(current,a,b),name
start='  const options: TripOption[] | null = useMemo';end='  const optionsRef = useRef(options);'
nowblock=block(current,start,end)
assert nowblock==block(pickup,start,end),'new ride slice preserves reviewed pickup numerical memo'
without=nowblock.replace('return stableOptions.map(o => ({ ...o, livePickupSelection: undefined }));','return stableOptions;')
without=without.replace('return { ...o, livePickupSelection: undefined };','return o;')
without=without.replace('livePickupSelection: undefined, ','')
without=without.replace('          livePickupSelection: rawPickupSelection(hereBus.bus_name, o.boardStopId, nowMs),\n','')
without=without.replace('        livePickupSelection: forecastPickupSelection(picked, nowMs),\n','')
assert without==block(base,start,end),'full combined numerical memo equals exact supplied base once additive projection removed'
planner='services/shuttle-v2/web/src/planner.ts'
s=(R/planner).read_text().replace("import type { LivePickupSelection } from './livePickupSelection';\n",'')
s=s.replace('  /** Existing countdown and selected boarding evidence, independent of destination availability. */\n  livePickupSelection?: LivePickupSelection;\n','')
assert s==before(BASE,planner),'planner runtime unchanged'
for name in ['arrivals.ts','journeyArrival.ts','arriveBy.ts','etaSource.ts','liveAnchor.ts','liveUpdates.ts','rideArrival.ts','rideEnd.ts','rideMapFocus.ts','stopAlerts.ts']:
 p='services/shuttle-v2/web/src/'+name
 assert (R/p).read_text()==before(BASE,p),name
for name in ['livePickupSelection.ts','tripBusIdentity.ts','livePickupSelection.test.ts','tripBusIdentity.test.ts']:
 p='services/shuttle-v2/web/src/'+name
 assert (R/p).read_text()==before(PICKUP,p),name
for directory in ['src','Dockerfile','web/src/eta']:
 assert not git('diff','--name-only',BASE+'..'+HEAD,'--','services/shuttle-v2/'+directory).strip(),directory
# Captured head source equals the earlier builder artifacts. Check, do not trust logs.
for name in ['ux-pickup','ux-08-ride']:
 old=json.loads((O.parent/name/'integrity.json').read_text())
 for rel,expected in old['sourceSha256'].items():
  if name=='ux-pickup' and rel.endswith('/TransitMap.tsx'): continue
  assert sha(R/rel)==expected,(name,rel)
for name in ['TransitMap.tsx','RideFinish.tsx','rideAlert.ts','livePickupSelection.ts','tripBusIdentity.ts']:
 contents=[]
 for path in (R/'services/shuttle-v2/web/dist/assets').glob('*.js.map'):
  m=json.loads(path.read_text())
  contents.extend(c for s,c in zip(m['sources'],m['sourcesContent']) if s.endswith('/'+name))
 assert contents==[(R/'services/shuttle-v2/web/src'/name).read_text()],name
reports=[]
for path in ['browser/ride-recovery.json','browser/desktop/ride-recovery.json','pickup/browser-mobile.json','extra/ride-recovery.json','extra-desktop/ride-recovery.json']:
 d=json.loads((O/path).read_text()); assert d['completed'] and d['resourcesClosed'] and not d['errors'] and not d.get('probe'),path
 reports.append({'path':path,'states':len(d['states']),'requests':d.get('requests',d.get('feedRequests'))})
images=[p for team in ['ux','eta'] for p in (O.parents[1]/team).rglob('*') if p.is_file() and p.suffix.lower() in ['.png','.jpg','.jpeg','.webp']]
image_bytes=sum(p.stat().st_size for p in images);assert image_bytes<100*1024*1024
result={'head':HEAD,'base':BASE,'parent':PICKUP,'tree':git('rev-parse','HEAD^{tree}').strip(),'checkoutAndIndexClean':True,'changedFiles':files,'unchangedBlocks':list(unchanged),'exactBaseNumericalMemoWithAdditiveMetadataRemoved':True,'builtSourcesMatch':True,'browserReports':reports,'images':len(images),'imageBytes':image_bytes,'sourceSha256':{p:sha(R/p) for p in files}}
(O/'integrity.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result,indent=2))
