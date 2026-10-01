import hashlib,json,subprocess
from pathlib import Path
root=Path('/home/gwarren/projects/yale-shuttle-watcher/overnight-ux-2026-09-17')
out=Path(__file__).resolve().parent
head='a401ef5c7fe675e59e0ec0e2b4dbb474ba176b34'
base='d5a392f533e8684320259ff0d323a3b0da75cc50'
def git(*args):return subprocess.check_output(['git',*args],cwd=root)
assert git('rev-parse','HEAD').decode().strip()==head
assert git('merge-base',base,head).decode().strip()==base
assert git('diff','--cached','--name-only')==b''
assert git('ls-files','--others','--exclude-standard')==b''
files=['services/shuttle-v2/web/src/TransitMap.tsx','services/shuttle-v2/scripts/empty-service-check.mjs']
assert set(git('diff','--name-only').decode().splitlines())==set(files)
sources={name:hashlib.sha256((root/name).read_bytes()).hexdigest() for name in files}
before=git('show',head+':'+files[0]).decode();production=git('show',base+':'+files[0]).decode();after=(root/files[0]).read_text()
def block(s,start,end):return s[s.index(start):s.index(end,s.index(start))]
proof={}
for label,start,end in [('numerical_options','  const options: TripOption[] | null = useMemo','  // Origin and destination are the same place'),('map_filter','  const activeFilter = activeOnly && buses.length > 0;','  // ── STOP-ARRIVAL ALERTS')]:
 b,a=block(before,start,end),block(after,start,end);assert b==a,label
 assert block(production,start,end)==a,label+' production'
 proof[label+'_sha256']=hashlib.sha256(b.encode()).hexdigest()
start,end='        // Rider counting rides along','    // Adaptive cadence:'
assert block(after,start,end)==block(before,start,end)
for name in ['planner.ts','journeyArrival.ts','arrivals.ts','etaSource.ts','liveUpdates.ts','mapFilter.ts','schedule.ts']:
 rel='services/shuttle-v2/web/src/'+name
 assert (root/rel).read_bytes()==git('show',base+':'+rel),name
assert block(after,'const AllRoutesMap: FC','const TripPlanner: FC')==block(before,'const AllRoutesMap: FC','const TripPlanner: FC')
manifest=json.loads((out/'prior-artifact-hashes.json').read_text())
for p,h in manifest.items():assert hashlib.sha256((out.parent/p).read_bytes()).hexdigest()==h,p
maps=list((root/'services/shuttle-v2/web/dist/assets').glob('rider-*.js.map'));assert len(maps)==1
m=json.loads(maps[0].read_text());matches=[content for path,content in zip(m['sources'],m['sourcesContent']) if path.endswith('/TransitMap.tsx')];assert matches==[after]
subprocess.run(['git','diff','--check'],cwd=root,check=True)
subprocess.run(['node','--check',str(root/files[1])],check=True)
images=[p for team in ['eta','ux'] for p in (out.parent.parent/team).rglob('*') if p.suffix.lower() in ['.png','.jpg','.jpeg','.webp']]
report={'head':head,'base':base,'sources':sources,**proof,'unchanged_numerical_modules':True,'poll_unchanged_from_reviewed_head':True,'all_routes_map_unchanged':True,'prior_artifacts_preserved':len(manifest),'bundle_source_matches_candidate':True,'index_empty':True,'image_count':len(images),'image_bytes':sum(p.stat().st_size for p in images)}
assert report['image_bytes']<100*1024*1024
(out/'integrity.json').write_text(json.dumps(report,indent=2)+'\n')
(out/'proposal.patch').write_bytes(git('diff','--',*files))
print(json.dumps(report,indent=2))
