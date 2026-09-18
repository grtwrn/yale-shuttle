from pathlib import Path
import hashlib,json
O=Path(__file__).resolve().parent
web=Path('/home/gwarren/projects/yale-shuttle-watcher/overnight-eta-2026-09-17/services/shuttle-v2/web')
sources={}
for p in (web/'dist/assets').glob('*.js.map'):
    d=json.loads(p.read_text())
    for name,content in zip(d['sources'],d['sourcesContent']):
        target=(p.parent/name).resolve()
        if target.is_relative_to(web/'src'):
            assert target.read_text()==content,str(target)
            sources[str(target.relative_to(web))]=hashlib.sha256(content.encode()).hexdigest()
assert all('src/'+n in sources for n in ['TransitMap.tsx','planner.ts','journeyArrival.ts','tripBusIdentity.ts'])
assets={str(p.relative_to(web/'dist')):hashlib.sha256(p.read_bytes()).hexdigest() for p in (web/'dist').rglob('*') if p.is_file()}
(O/'built-source-provenance.json').write_text(json.dumps({'sourceCount':len(sources),'sources':sources,'assets':assets},indent=2)+'\n')
print(f'{len(sources)} local built source modules match current checkout; {len(assets)} asset hashes captured')
