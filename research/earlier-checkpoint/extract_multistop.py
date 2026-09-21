"""Small streaming export of public Red vehicle forecasts for other pickups."""
import collections
import gzip
import hashlib
import json
from pathlib import Path

HERE=Path(__file__).resolve().parent
FIELDS='id bus_id bus_name route_id from_stop_id to_stop_id stops_ahead predicted_sec predicted_low_sec predicted_high_sec predicted_at client_build surface'.split()
seq=json.loads((HERE/'data/topology.json').read_text())['route']['stops']
sources=[];counts={}
output=HERE/'data/multistop_predictions.jsonl.gz'
with gzip.open(output,'wt') as dest:
    for day in ['2026-09-16','2026-09-17','2026-09-18','2026-09-21']:
        path=Path('/home/gwarren/projects/yale-shuttle-watcher/canal-munson-2026-09-21/predictions.jsonl') if day.endswith('21') else Path('/home/gwarren/shuttle-archive')/day/'predictions_log.jsonl.gz'
        sources.append({'day':day,'sha256':hashlib.sha256(path.read_bytes()).hexdigest()})
        counts[day]=collections.Counter()
        with (gzip.open if path.suffix=='.gz' else open)(path,'rt') as src:
            for line in src:
                row=json.loads(line)
                if row.get('route_id')!=3 or row.get('surface') not in ['trip','card'] or row.get('to_stop_id') not in seq[15:]:continue
                clean={k:row[k] for k in FIELDS if k in row};clean['day']=day
                dest.write(json.dumps(clean,separators=(',',':'))+'\n')
                counts[day][row['to_stop_id']]+=1
manifest={'sources':sources,'counts':counts,'outputs':{output.name:hashlib.sha256(output.read_bytes()).hexdigest()},'privacy':'Allowlisted public vehicle forecasts only; no rider identifiers or coordinates.'}
(HERE/'data/multistop-manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
print(json.dumps(counts))
