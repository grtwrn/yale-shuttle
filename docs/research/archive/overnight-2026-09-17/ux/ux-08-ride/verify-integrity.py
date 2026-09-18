from pathlib import Path
import hashlib, json, subprocess
R=Path('/home/gwarren/projects/yale-shuttle-watcher/overnight-ux-2026-09-17')
O=Path(__file__).resolve().parent
base='7f681d92a7d30331728d637216dabecf9d9e356c'
def git(*a): return subprocess.check_output(['git',*a],cwd=R,text=True)
def before(p): return git('show',base+':'+p)
assert git('rev-parse','HEAD').strip()==base
assert not git('diff','--cached','--name-only').strip()
subprocess.run(['git','diff','--check'],cwd=R,check=True)
files=['services/shuttle-v2/'+p for p in ['web/src/TransitMap.tsx','web/src/RideFinish.tsx','web/src/rideAlert.ts','web/src/rideAlert.test.ts','scripts/ride-recovery-check.mjs']]
assert set(git('diff','--name-only').splitlines())|set(git('ls-files','--others','--exclude-standard').splitlines())==set(files)
shell=files[0]; old=before(shell); new=(R/shell).read_text()
def block(s,a,b): return s[s.index(a):s.index(b,s.index(a))]
unchanged={
 'options':('  const options: TripOption[] | null = useMemo', '  const optionsRef = useRef(options);'),
 'rideMapAndStops':('const RideRouteMap:', 'const OnBusBanner:'),
 'rideStopArithmetic':('const OnBusBanner:', '  const getOffAlertRef = useRef'),
 'notificationTrigger':('  useEffect(() => {\n    if (stopsRemaining === null', '  const etaStr = etaSec'),
 'autoEndEngine':('  const offBusStreakRef = React.useRef', '  const [stopGroups, setStopGroups]'),
}
for name,(a,b) in unchanged.items(): assert block(old,a,b)==block(new,a,b),name
for name in ['planner.ts','arrivals.ts','journeyArrival.ts','arriveBy.ts','livePickupSelection.ts','tripBusIdentity.ts','etaSource.ts','liveAnchor.ts','liveUpdates.ts','rideArrival.ts','rideEnd.ts','rideMapFocus.ts','stopAlerts.ts']:
 p='services/shuttle-v2/web/src/'+name
 assert (R/p).read_text()==before(p),name
assert (R/files[2]).read_text().startswith(before(files[2]).rstrip()+'\n')
for name in ['TransitMap.tsx','RideFinish.tsx','rideAlert.ts']:
 contents=[]
 for path in (R/'services/shuttle-v2/web/dist/assets').glob('*.js.map'):
  m=json.loads(path.read_text())
  contents.extend(c for s,c in zip(m['sources'],m['sourcesContent']) if s.endswith('/'+name))
 assert contents==[(R/'services/shuttle-v2/web/src'/name).read_text()],name
reports=[]
for path in ['release/ride-recovery.json','release/desktop/ride-recovery.json']:
 d=json.loads((O/path).read_text()); assert d['completed'] and d['resourcesClosed'] and not d['errors'] and not d['probe'],path
 states={s['name']:s for s in d['states']}
 for name in ['stale','missing','empty','failed-expired']: assert 'Live stop position unavailable' in states[name]['dialog'],name
 assert 'Your stop is 5 stops away' in states['farther']['dialog']
 assert states['restored-dismiss']['focus']['text']=='Done'
 assert states['external-dismiss']['focus']['text']=='↻'
 assert states['finish']['focus']['tag']=='SECTION'
 assert states['auto-end-external']['focus']['text']=='↻'
 assert states['auto-end-owned']['focus']['tag']=='SECTION'
 for name in ['missing','stale','empty']: assert states['initial-'+name]['dialog'] is None
 reports.append({'path':path,'states':len(d['states']),'requests':d['requests']})
images=[p for team in ['ux','eta'] for p in (O.parents[1]/team).rglob('*') if p.is_file() and p.suffix.lower() in ['.png','.jpg','.jpeg','.webp']]
image_bytes=sum(p.stat().st_size for p in images);assert image_bytes<100*1024*1024
patch=git('diff','--binary')
for p in git('ls-files','--others','--exclude-standard').splitlines():
 result=subprocess.run(['git','diff','--no-index','--','/dev/null',p],cwd=R,text=True,capture_output=True);assert result.returncode==1;patch+=result.stdout
(O/'proposal.patch').write_text(patch)
result={'base':base,'headPreserved':True,'indexUnchanged':True,'unchangedBlocks':list(unchanged),'builtSourcesMatch':True,'browserReports':reports,'images':len(images),'imageBytes':image_bytes,'sourceSha256':{p:hashlib.sha256((R/p).read_bytes()).hexdigest() for p in files}}
(O/'integrity.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result,indent=2))
