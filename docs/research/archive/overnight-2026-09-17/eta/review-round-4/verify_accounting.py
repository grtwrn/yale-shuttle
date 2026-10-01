import json,gzip,sqlite3,collections
from pathlib import Path
O=Path(__file__).resolve().parent;B=O.parent/'cycle-4';A=O.parents[2]
rows=[json.loads(l) for l in (B/'decisions.jsonl').read_text().splitlines()];frames={f['at']:f for f in map(json.loads,gzip.open(B/'fleet-wire.jsonl.gz','rt'))}
out=json.loads((B/'outcome-audit.json').read_text()); scored={(s['session'],s['at']) for s in out['scores']}
db=sqlite3.connect('file:'+str(A/'conditional-replay-data/outcomes.db')+'?mode=ro',uri=True);db.row_factory=sqlite3.Row;sources={r['id']:dict(r) for r in db.execute('select * from stop_visits where route_id=3')};db.close()
missing=collections.Counter();unavailable=collections.Counter();countdownDifferent=0
for r in rows:
 option=next(o for o in r['options'] if o['mode']=='shuttle');source=sources[r['sourceId']]
 t=next(t for t in r['trace'] if t['kind']=='journey');board=t.get('board');dest=t.get('destination');j=option.get('journeyArrival')
 if j:countdownDifferent+=option['busName']!=j['busName']
 else:
  if board is None:reason='raw-at-stop branch found no modeled zero-time boarding row'
  elif dest is None:reason='no later destination row for selected boarding occurrence'
  elif dest['eta']<max(board['eta'],option['walkToSec']):reason='destination median precedes pickup median or required access walk'
  else:reason='unclassified'
  unavailable[reason]+=1
 bus=board['busName'] if board else option['busName']
 if option['boardStopId']!=source['stop_id']:why='different boarding stop needs separate chain'
 elif bus!=source['bus_name'].lstrip('#'):why='different bus needs separate chain'
 elif not source['anchored_at']<=r['at']<=source['departed_at']:why='outside selected current source visit'
 elif board and board['stopsAhead']!=0:why='modeled boarding is not current occurrence'
 else:why=None
 if why:missing[why]+=1;assert (r['session'],r['at']) not in scored
 else:assert (r['session'],r['at']) in scored
assert dict(missing)==out['missing'];assert dict(unavailable)==out['missingDestinationCauses'];assert countdownDifferent==676
summary=dict(unmatched=dict(missing),unavailableJourney=dict(unavailable),countdownJourneyDifferent=countdownDifferent)
(O/'accounting.json').write_text(json.dumps(summary,indent=2)+'\n');print(json.dumps(summary,indent=2))
