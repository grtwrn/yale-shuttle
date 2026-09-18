from pathlib import Path
import re,hashlib,json
O=Path(__file__).resolve().parent
S=Path.cwd()/'web/src/eta/index.ts'
s=S.read_text()
def change(m):
 p=(S.parent/m.group(1)).resolve().with_suffix('.ts')
 assert p.exists(),p
 return "from '"+p.as_uri()+"'"
s=re.sub(r'''from ["'](\.{1,2}/[^"']+)["']''',change,s)
s=s.replace('export function arrivalsForBus(', 'export let observedRaw: any[] = [];\nexport function arrivalsForBus(',1)
needle='  // Pool absolute arrival quantiles only while the tracked rest continues.'
assert s.count(needle)==1
s=s.replace(needle,'  observedRaw = structuredClone(rows);\n'+needle)
(O/'pool-observer.generated.mts').write_text(s)
(O/'pool-observer-source.json').write_text(json.dumps({'source':str(S),'sha256':hashlib.sha256(S.read_bytes()).hexdigest(),'modification':'Resolve imports to original modules; clone raw rows immediately before pooling. No computation change.'},indent=2)+'\n')
