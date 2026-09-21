"""Merge a later bus-only capture without changing the frozen training dates."""
import collections
import gzip
import hashlib
import json
from pathlib import Path

HERE=Path(__file__).resolve().parent
ROOT=HERE.parents[2]
SOURCE=ROOT/'canal-munson-2026-09-21/extension'
DATA=HERE/'data'
manifest=json.loads((DATA/'manifest.json').read_text())
audit={'modelFrozenCommit':'505ef89f9847b6023fd02013ec55ebfac16a38d9','modelFrozenAt':'2026-09-21T17:47:50Z','description':'Additional same-day outcomes captured only after numeric model rules were frozen. Clock times before the freeze are newly inspected retrospective extension; only later forecast origins are called prospective. No training or calibration changes.','tables':{}}
for table in ['stop_visits','legs','raw_positions','predictions_log']:
    path=DATA/(table+'.jsonl.gz')
    with gzip.open(path,'rt') as f:old=[json.loads(l) for l in f]
    fields=set().union(*(r.keys() for r in old));fields.discard('day')
    def key(r):return (r['bus_id'],r['collected_at']) if table=='raw_positions' else r['id']
    rows={key(r):r for r in old}
    raw=(SOURCE/(table+'.jsonl')).read_bytes()
    incoming=[json.loads(l) for l in raw.splitlines()]
    assert incoming[-1].get('end') is True and incoming[-1]['rows']==len(incoming)-2
    new=0;updated=0
    for r in incoming[1:-1]:
        if r.get('route_id')!=3:continue
        if table=='predictions_log' and (r.get('surface') not in ('trip','card') or r.get('to_stop_id') not in (48,4)):continue
        clean={k:r[k] for k in fields if k in r};clean['day']='2026-09-21'
        k=key(clean)
        if k not in rows:new+=1
        elif rows[k]!=clean:updated+=1
        rows[k]=clean
    clock_key={'stop_visits':'anchored_at','legs':'departed_at','raw_positions':'collected_at','predictions_log':'predicted_at'}[table]
    ordered=sorted(rows.values(),key=lambda r:(r[clock_key],r['bus_id']))
    with gzip.open(path,'wt',compresslevel=3) as f:
        for r in ordered:f.write(json.dumps(r,separators=(',',':'))+'\n')
    counts=dict(collections.Counter(r['day'] for r in ordered))
    manifest['outputs'][path.name]={'sha256':hashlib.sha256(path.read_bytes()).hexdigest(),'counts':counts,'bytes':path.stat().st_size}
    manifest['sources'].append({'day':'2026-09-21','table':table,'extension':True,'sha256':hashlib.sha256(raw).hexdigest(),'bytes':len(raw)})
    audit['tables'][table]={'new':new,'updated':updated,'maxClock':max(r[clock_key] for r in ordered),'previousMaxClock':max(r[clock_key] for r in old)}
(DATA/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
(DATA/'extension.json').write_text(json.dumps(audit,indent=2)+'\n')
print(json.dumps(audit,indent=2))
