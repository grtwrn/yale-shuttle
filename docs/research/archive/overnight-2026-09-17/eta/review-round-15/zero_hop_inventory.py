from pathlib import Path
import json,sqlite3,gzip,collections
O=Path(__file__).resolve().parent
db=sqlite3.connect('file:/home/gwarren/projects/yale-shuttle-watcher/release-integration-data/outcomes-complete.db?mode=ro',uri=True);db.row_factory=sqlite3.Row
meta=json.loads((O/'current-meta.json').read_text());selected=collections.defaultdict(list)
for r in map(json.loads,(O/'connected-pairs.jsonl').open()):
 if any(r[arm][3]==0 for arm in ['current','canonical']):selected[r['poll']].append(r)
counts=collections.Counter();cases=[]
for arm in ['current','canonical']:
 for line in gzip.open(O/(arm+'-wire.jsonl.gz'),'rt'):
  f=json.loads(line)
  if f['i'] not in selected:continue
  for r in selected[f['i']]:
   if r[arm][3]!=0:continue
   label=meta['routeMeta'][str(r['route'])]['label'];t=f['tracking'][label+'|'+r['bus']];source=dict(db.execute('select * from stop_visits where id=?',(r['sourceId'],)).fetchone());target=dict(db.execute('select * from stop_visits where id=?',(r['targetId'],)).fetchone())
   prior=[dict(v) for v in db.execute('select * from stop_visits where route_id=? and bus_name=? and stop_index=? and anchored_at<=? order by anchored_at desc,id desc limit 1',(r['route'],source['bus_name'],r['targetIndex'],r['at']))]
   pin=[dict(v) for v in db.execute('select * from stop_visits where route_id=? and bus_name=? and stop_index=? and pinned_at=?',(r['route'],source['bus_name'],r['targetIndex'],t[4]))]
   status='different-tracked-rest' if t[3]!=r['targetIndex'] else 'inactive-rest' if not t[2] else 'no-exact-pin' if not pin else 'exact-pin-without-proved-connected-lag'
   counts[arm+':'+status]+=1;counts[arm+':remainingScored']+=1
   cases.append({'arm':arm,'row':r,'tracking':t,'latestHistoricalSource':source,'scoredTarget':target,'latestPriorVisitToPhysicalOrigin':prior,'exactPinMatches':pin,'classification':status,'interpretation':'Identity remains provisional. A zero forecast alone does not prove which historical visit it belongs to or justify discarding a valid bad forecast.'})
assert counts['current:remainingScored']==57 and counts['canonical:remainingScored']==58
(O/'remaining-zero-hop-inventory.json').write_text(json.dumps({'counts':counts,'cases':cases,'noExclusionsOrRetargetingFromThisInventory':True},indent=2)+'\n');print(json.dumps(counts,indent=2));db.close()
