from pathlib import Path
import re,json,hashlib
O=Path(__file__).resolve().parent;S=Path('/home/gwarren/projects/yale-shuttle-watcher/overnight-eta-2026-09-17/services/shuttle-v2')
paths=['src/server/serverEta.ts','web/src/liveAnchor.ts','web/src/arrivals.ts','web/src/eta/index.ts','web/src/eta/arrival.ts','web/src/eta/filter.ts']
mapping={(S/p).resolve():O/('kernel-'+p.replace('/','-').replace('.ts','.mts')) for p in paths}
for p,dest in mapping.items():
 text=p.read_text()
 def repl(m):
  original=m.group(1);target=(p.parent/original).resolve()
  if target.is_dir():target=target/'index.ts'
  elif target.suffix in ('.js','.ts'):target=target.with_suffix('.ts')
  else:target=target.with_suffix('.ts')
  assert target.exists(),target
  return "from '"+mapping.get(target,target).as_uri()+"'"
 text=re.sub(r'''from ["'](\.{1,2}/[^"']+)["']''',repl,text)
 if p.name=='filter.ts':
  text=text.replace('const kernelCache = new Map<number, Float64Array>();','export const kernelCache = new Map<number, Float64Array>();\nexport const kernelSeeds = new Map<number, number>();')
  text=text.replace('  kernelCache.set(key, k);','  kernelSeeds.set(key, meanCells);\n  kernelCache.set(key, k);')
 dest.write_text(text)
(O/'kernel-probe-sources.json').write_text(json.dumps({str(p):hashlib.sha256(p.read_bytes()).hexdigest() for p in mapping},indent=2)+'\n')
