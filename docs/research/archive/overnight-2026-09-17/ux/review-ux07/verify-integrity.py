import hashlib,json,subprocess
from pathlib import Path
root=Path('/home/gwarren/projects/yale-shuttle-watcher/overnight-ux-2026-09-17')
out=Path(__file__).resolve().parent
builder=out.parent/'ux-07'
head='a401ef5c7fe675e59e0ec0e2b4dbb474ba176b34'
base='d5a392f533e8684320259ff0d323a3b0da75cc50'
def git(*args):return subprocess.check_output(['git',*args],cwd=root)
assert git('rev-parse','HEAD').decode().strip()==head
assert git('merge-base',base,head).decode().strip()==base
assert git('status','--porcelain')==b''
relative='services/shuttle-v2/web/src/TransitMap.tsx'
files=[relative,'services/shuttle-v2/scripts/empty-service-check.mjs']
assert set(git('diff','--name-only',base,head).decode().splitlines())==set(files)
sources={}
for name in files:
 data=(root/name).read_bytes();assert data==git('show',head+':'+name)
 sources[name]=hashlib.sha256(data).hexdigest()
before=git('show',base+':'+relative).decode();after=(root/relative).read_text()
def block(s,start,end):return s[s.index(start):s.index(end,s.index(start))]
proof={}
for label,start,end in [('numerical_options','  const options: TripOption[] | null = useMemo','  // Origin and destination are the same place'),('map_filter','  const mapDrawnHidden = useMemo','  // ── STOP-ARRIVAL ALERTS')]:
 b,a=block(before,start,end),block(after,start,end);assert b==a,label
 proof[label+'_sha256']=hashlib.sha256(b.encode()).hexdigest()
start,end='        // Rider counting rides along','    // Adaptive cadence:'
p=block(after,start,end).replace('        setBusSnapshotFailed(false);\n','').replace('          setBusSnapshotFailed(true);\n','')
assert p==block(before,start,end)
for name in ['planner.ts','journeyArrival.ts','arrivals.ts','etaSource.ts','liveUpdates.ts','mapFilter.ts','schedule.ts']:
 rel='services/shuttle-v2/web/src/'+name
 assert (root/rel).read_bytes()==git('show',base+':'+rel),name
# Compare map implementation separately from new status type outside it.
a=block(after,'const AllRoutesMap: FC','const TripPlanner: FC').replace('type LiveBusStatus = "loading" | "unavailable" | "ready";','').strip()
b=block(before,'const AllRoutesMap: FC','const TripPlanner: FC').strip()
assert a==b
assert (builder/'TransitMap.baseline.tsx').read_bytes()==git('show','373505d5076f21a08de69d9587be9b2a55956642:'+relative)
manifest=json.loads((builder/'artifact-hashes.json').read_text())
for p,h in manifest.items():assert hashlib.sha256((builder/p).read_bytes()).hexdigest()==h,p
maps=list((root/'services/shuttle-v2/web/dist/assets').glob('rider-*.js.map'))
assert len(maps)==1
m=json.loads(maps[0].read_text());matches=[content for path,content in zip(m['sources'],m['sourcesContent']) if path.endswith('/TransitMap.tsx')]
assert matches==[after]
for args in [('diff','--check',base,head),('diff','--exit-code'),('diff','--cached','--exit-code')]:subprocess.run(['git',*args],cwd=root,check=True)
for path in [root/files[1],out/'review-lifecycle.mjs',out/'boundary-acceptance.mjs']:subprocess.run(['node','--check',str(path)],check=True)
images=[p for team in ['eta','ux'] for p in (out.parent.parent/team).rglob('*') if p.suffix.lower() in ['.png','.jpg','.jpeg','.webp']]
report={'head':head,'base':base,'parents':git('show','-s','--format=%P',head).decode().strip().split(),'sources':sources,**proof,'unchanged_numerical_modules':True,'poll_only_adds_presentation_flag':True,'all_routes_map_unchanged':True,'builder_artifacts_preserved':len(manifest),'bundle_source_matches_head':True,'clean_checkout_index':True,'image_count':len(images),'image_bytes':sum(p.stat().st_size for p in images)}
assert report['image_bytes']<100*1024*1024
(out/'integrity.json').write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps(report,indent=2))
