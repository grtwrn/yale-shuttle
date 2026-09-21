"""Build bus-only, reproducible inputs; never export rider reports or identifiers."""
import collections
import gzip
import hashlib
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
WORK = HERE.parents[2]
ARCHIVE = Path('/home/gwarren/shuttle-archive')
TODAY = WORK / 'canal-munson-2026-09-21'
DAYS = ['2026-09-' + d for d in ('03','04','08','09','10','11','14','15','16','17','18','21')]
FIELDS = {
    'stop_visits': 'id bus_id bus_name anchor_bus_id route_id stop_id stop_index anchored_at pinned_at arrived_at departed_at stand_sec inside_sec outcome how confidence first_step_m steps far_m confirm_sec rest_polls shuffles first_moved_at last_at_rest_at closest_m dow hour',
    'legs': 'id bus_id bus_name route_id from_stop_id from_index to_stop_id to_index hops departed_at arrived_at to_pinned_at leg_sec hold_sec drive_sec holds reached dow hour',
    'raw_positions': 'bus_id bus_name route_id lat lon heading last_stop_id collected_at',
    'predictions_log': 'id bus_id bus_name route_id from_stop_id to_stop_id stops_ahead predicted_sec predicted_low_sec predicted_high_sec predicted_at client_build surface',
}
TODAY_NAMES = {'stop_visits':'visits','legs':'legs','raw_positions':'positions','predictions_log':'predictions'}

def digest(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for b in iter(lambda: f.read(1 << 20), b''):
            h.update(b)
    return h.hexdigest()

manifest = {'sources': [], 'outputs': {}, 'privacy': 'Only allowlisted public transit vehicle observations, stop visits, legs, and vehicle forecasts. No rider submissions, IPs, anonymous IDs, screenshots or journey origins.'}
out = HERE / 'data'
out.mkdir(exist_ok=True)
for table, fields in FIELDS.items():
    counts = collections.Counter()
    path = out / (table + '.jsonl.gz')
    with gzip.open(path, 'wt', compresslevel=3) as dest:
        for day in DAYS:
            if table in ('raw_positions','predictions_log') and day < '2026-09-16':
                continue
            source = TODAY / (TODAY_NAMES[table] + '.jsonl') if day.endswith('-21') else ARCHIVE / day / (table + '.jsonl.gz')
            manifest['sources'].append({'day':day, 'table':table, 'sha256':digest(source), 'bytes':source.stat().st_size})
            opener = gzip.open if source.suffix == '.gz' else open
            with opener(source, 'rt') as f:
                for line in f:
                    r = json.loads(line)
                    if r.get('route_id') != 3:
                        continue
                    if table == 'predictions_log' and (r.get('surface') not in ('trip','card') or r.get('to_stop_id') not in (48,4)):
                        continue
                    clean = {k:r[k] for k in fields.split() if k in r}
                    clean['day'] = day
                    dest.write(json.dumps(clean, separators=(',',':')) + '\n')
                    counts[day] += 1
    manifest['outputs'][path.name] = {'sha256':digest(path), 'counts':dict(counts), 'bytes':path.stat().st_size}
feed = json.loads((TODAY / 'live-feed.json').read_text())
seq = feed['routes']['3']
topology = {'route': {'id':3,'name':'Red','shortName':'Red','color':'#C62828','stops':seq,'path':feed['route_paths']['3']}, 'stops':[{'id':s,'name':feed['stop_names'][str(s)],**feed['stop_coords'][str(s)]} for s in seq]}
(out / 'topology.json').write_text(json.dumps(topology, separators=(',',':')))
manifest['outputs']['topology.json'] = {'sha256':digest(out / 'topology.json')}
(out / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
print(json.dumps(manifest['outputs'], indent=2))
