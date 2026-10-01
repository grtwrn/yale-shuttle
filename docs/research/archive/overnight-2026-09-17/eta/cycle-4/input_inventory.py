"""Read-only feasibility inventory, not a rider decision score."""
import collections
import hashlib
import json
from pathlib import Path

ROOT=Path('/home/gwarren/projects/yale-shuttle-watcher')
OUT=Path(__file__).resolve().parent
RAW=ROOT/'conditional-replay-data/raw-frames.jsonl'
frames=collections.Counter();counts=collections.Counter();names=collections.defaultdict(set)
n=0;first=None;last=None
for line in RAW.open():
    r=json.loads(line);n+=1;first=first or r['at'];last=r['at']
    for route in {b['route_id'] for b in r['buses']}:frames[route]+=1
    for b in r['buses']:counts[b['route_id']]+=1;names[b['route_id']].add(b['bus_name'])
work=ROOT/'overnight-eta-2026-09-17/services/shuttle-v2/web/src'
files=[RAW,OUT.parent/'cycle-2/component-snapshots.v8',OUT.parent/'cycle-2/current-trace.jsonl',
       OUT.parent/'cycle-2/trace-outcomes.json',work/'planner.ts',work/'tripRanking.ts',work/'walk.ts',work/'journeyArrival.ts',work/'TransitMap.tsx']
result=dict(frames=n,first=first,last=last,framesByRoute=dict(frames),observationsByRoute=dict(counts),distinctBusCounts={r:len(v) for r,v in names.items()},hashes={str(p):hashlib.sha256(p.read_bytes()).hexdigest() for p in files},
limitations=['Archive contains only Red; absence of other routes is not evidence those routes were off.',
             'Five saved V8 component snapshots contain only each focal bus entry, not all warm Red vehicle states.',
             'Current trace saved only selected focal-bus targets11/48/4; it cannot reproduce every boarding/alighting option.',
             'Existing rank/walk policies already address overlap, persistence and meaningful walking savings; measure baseline before proposing another rule.'])
(OUT/'input-inventory.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps({k:v for k,v in result.items() if k!='hashes'},indent=2))
