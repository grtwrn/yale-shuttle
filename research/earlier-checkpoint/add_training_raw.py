"""Input-quality sensitivity: recover training paths from available raw GPS.

Adds all available pre-Sep16 Red positions by date, without selecting individual
journeys or looking at their forecast errors. Numeric model/support rules stay fixed.
"""
import collections
import gzip
import hashlib
import json
from pathlib import Path
HERE=Path(__file__).resolve().parent
DATA=HERE/'data'
path=DATA/'raw_positions.jsonl.gz'
with gzip.open(path,'rt') as f:rows=[json.loads(l) for l in f]
fields='bus_id bus_name route_id lat lon heading last_stop_id collected_at'.split()
manifest=json.loads((DATA/'manifest.json').read_text())
days=['2026-09-'+s for s in ('03','04','08','09','10','11','14','15')]
counts={}
for day in days:
    source=Path('/home/gwarren/shuttle-archive')/day/'raw_positions.jsonl.gz'
    count=0
    with gzip.open(source,'rt') as f:
        for line in f:
            r=json.loads(line)
            if r.get('route_id')!=3:continue
            rows.append({**{k:r[k] for k in fields if k in r},'day':day});count+=1
    counts[day]=count
    manifest['sources'].append({'day':day,'table':'raw_positions','purpose':'training path quality sensitivity','sha256':hashlib.sha256(source.read_bytes()).hexdigest(),'bytes':source.stat().st_size})
unique={(r['bus_id'],r['collected_at']):r for r in rows}
with gzip.open(path,'wt',compresslevel=3) as f:
    for r in sorted(unique.values(),key=lambda r:(r['collected_at'],r['bus_id'])):f.write(json.dumps(r,separators=(',',':'))+'\n')
manifest['outputs'][path.name]={'sha256':hashlib.sha256(path.read_bytes()).hexdigest(),'counts':dict(collections.Counter(r['day'] for r in unique.values())),'bytes':path.stat().st_size}
(DATA/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
print(json.dumps(counts,indent=2))
