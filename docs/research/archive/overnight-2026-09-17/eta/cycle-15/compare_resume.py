from pathlib import Path
import json,gzip,hashlib
O=Path(__file__).resolve().parent
results={}
for arm in ['current','canonical']:
 full=[json.loads(l) for l in gzip.open(O/(arm+'-wire.jsonl.gz'),'rt') if '"i":59' in l[:16]]
 # Explicit index filter after parsing avoids relying on a textual prefix.
 full=[r for r in full if 5900<=r['i']<6000]
 resumed=[json.loads(l) for l in gzip.open(O/(arm+'-resume5900-wire.jsonl.gz'),'rt')]
 assert len(full)==len(resumed)==100,(arm,len(full),len(resumed))
 unequal=[]
 for a,b in zip(full,resumed):
  if a!=b:unequal.append({'i':a['i'],'keys':[k for k in a.keys()|b.keys() if a.get(k)!=b.get(k)]})
 results[arm]={'polls':100,'exactPolls':100-len(unequal),'differences':unequal,'minuteStateDigests':sum('stateSha256' in r for r in full),'checkpoint6000Bytes':(O/(arm+'-checkpoint-6000.v8')).stat().st_size}
(O/'resume-comparison.json').write_text(json.dumps(results,indent=2)+'\n')
assert all(r['exactPolls']==100 for r in results.values()),results
print(json.dumps(results,indent=2))
