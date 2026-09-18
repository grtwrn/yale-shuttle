"""Identify current-stop transport contradictions and whole-lap smoothing aliases."""
import gzip,json,collections,math
from pathlib import Path
O=Path(__file__).resolve().parent
frames=list(map(json.loads,gzip.open(O/'fleet-wire.jsonl.gz','rt')))
last={};bad=[];aliases=[];runs=[];counts=collections.Counter();transitions=[]
for f in frames:
 w=f['server_eta']
 if not w:continue
 groups=collections.defaultdict(list)
 for i,r in enumerate(w['rows']):groups[r[0],r[1]].append((i,r))
 for (bi,stop),items in groups.items():
  items.sort(key=lambda ir:ir[1][5]);bus=w['buses'][bi][0]
  for occurrence,(i,r) in enumerate(items):
   k=(bus,stop,occurrence);prev=last.get(k)
   # Occurrence ordering is unique here: this fixed Red ring has no repeated stop IDs.
   rec=dict(at=f['at'],bus=bus,stop=stop,occurrence=occurrence,row=r,distribution=w['distributions'][i],track=w['buses'][bi],contexts=f['contexts'])
   if r[5]==0:
    counts['zeroHopRows']+=1
    if r[2]>0:
     counts['positiveEtaZeroHopRows']+=1
     onward=[x for x in w['rows'] if x[0]==bi and x[5]>0 and x[2]<r[2]]
     bad.append({**rec,'downstreamEarlierRows':onward,'previous':prev})
     counts['zeroHopPickupAfterDownstream']+=bool(onward)
   if prev and 0<(f['at']-prev['at'])<=15000 and prev['row'][5]-r[5]>=28:
    dt=(f['at']-prev['at'])/1000
    alias={**rec,'previous':prev,'hopDecrease':prev['row'][5]-r[5],'dt':dt}
    if r[5]==0:
     # priceRoute emits an all-zero current-stop row; transport rounding only
     # introduces <=0.5sec per row. The exact prior unrounded pool is not saved.
     expected=max(0,(prev['row'][2]-dt)*math.exp(-dt/30))
     alias.update(zeroRowPoolPredictionSec=expected,roundedDifferenceSec=r[2]-expected)
    aliases.append(alias)
   # No recursive history in saved rows.
   last[k]=rec
assert counts['positiveEtaZeroHopRows']>0
out=dict(scope='Baseline bug localization only. Zero-hop raw rows are explicitly zero in priceRoute; current release pooling can overwrite them with an earlier future-lap occurrence. No coefficient or tracking change tested.',counts=dict(counts),aliasTransitions=aliases,contradictions=bad)
(O/'pooling-audit.json').write_text(json.dumps(out,indent=2)+'\n')
selected=[a for a in aliases if a['row'][5]==0 and a['row'][2]>0]
print(json.dumps({'counts':dict(counts),'aliasTransitions':len(aliases),'zeroHopAliases':len(selected),'examples':[{k:a[k] for k in ['at','bus','stop','occurrence','row','hopDecrease','zeroRowPoolPredictionSec','roundedDifferenceSec']} for a in selected[:5]]},indent=2))
