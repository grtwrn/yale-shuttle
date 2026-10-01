from pathlib import Path
import json,sqlite3,collections,hashlib
O=Path(__file__).resolve().parent;A=Path('/home/gwarren/projects/yale-shuttle-watcher');path=A/'release-integration-data/outcomes-complete.db'
db=sqlite3.connect('file:'+str(path)+'?mode=ro',uri=True);db.row_factory=sqlite3.Row
original=collections.Counter((r['collected_at'],r['bus_id'],r['bus_name'],r['route_id'],r['lat'],r['lon'],r['heading'],r['last_stop_id']) for r in db.execute('select * from raw_positions where collected_at>=1789531200000 order by collected_at,id'))
fresh=collections.Counter();carried=0;routes=collections.Counter();polls=0;prior=0
from datetime import datetime
p=Path('/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/cycle-14/all-route-raw-frames.jsonl')
for f in map(json.loads,p.open()):
 at=round(datetime.fromisoformat(f['at'].replace('Z','+00:00')).timestamp()*1000);assert at>prior;prior=at;polls+=1
 for b in f['buses']:
  assert b['observed_at']<=at
  if b['observed_at']==at:fresh[(at,b['bus_id'],b['bus_name'],b['route_id'],b['lat'],b['lon'],b['heading'],b['last_stop_id'])]+=1;routes[b['route_id']]+=1
  else:carried+=1
missing=original-fresh;extra=fresh-original
assert not missing and not extra,(len(missing),len(extra))
plan=json.loads((O/'PLAN.json').read_text());assert hashlib.sha256(path.read_bytes()).hexdigest()==plan['inputHashes'][str(path)]
result={'originalRawRows':sum(original.values()),'exactFreshExportMatches':sum(fresh.values()),'polls':polls,'carriedStaleBusRows':carried,'freshRowsByRoute':routes,'missing':sum(missing.values()),'extra':sum(extra.values()),'sha256':hashlib.sha256(p.read_bytes()).hexdigest(),'historicalDatabaseHashUnchanged':True,'limits':'Coordinates, observed time, bus identity, heading and last upstream stop verified. Derived pin/stationary/lap metadata is causal reconstruction, not original live publication. No forecast/outcome validation from this export.'}
(O/'all-route-export-verification.json').write_text(json.dumps(result,indent=2)+'\n');db.close();print(json.dumps(result,indent=2))
