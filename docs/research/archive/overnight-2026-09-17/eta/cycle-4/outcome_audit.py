"""Retrospective exact current-source boarding subset; never used by forecasts."""
import ast,collections,json,sqlite3,gzip
from pathlib import Path
O=Path(__file__).resolve().parent;A=O.parents[2]
# Reuse reviewed connection function only, without executing its old outputs.
source=(O.parent/'cycle-2/trace_outcomes.py').read_text();tree=ast.parse(source)
fn=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='connect')
db=sqlite3.connect('file:/home/gwarren/projects/yale-shuttle-watcher/conditional-replay-data/outcomes.db?mode=ro',uri=True);db.row_factory=sqlite3.Row
seq=json.loads(db.execute('SELECT stops_json FROM routes WHERE id=3').fetchone()[0]);N=len(seq)
visits=[dict(r) for r in db.execute('SELECT * FROM stop_visits WHERE route_id=3')];legs=[dict(r) for r in db.execute('SELECT * FROM legs WHERE route_id=3')];db.close()
byid={r['id']:r for r in visits};by_leg=collections.defaultdict(list);by_visit=collections.defaultdict(list)
for l in legs:by_leg[l['bus_name'],l['from_index'],l['departed_at']].append(l)
for v in visits:
 ts={v['arrived_at']}
 if v['outcome']=='passed':ts.add(v['departed_at'])
 for t in ts:
  if t is not None:by_visit[v['bus_name'],v['stop_id'],v['stop_index'],t].append(v)
exec(compile(ast.Module(body=[fn],type_ignores=[]),'<reviewed connect>','exec'))
frames={r['at']:r for r in map(json.loads,gzip.open(O/'fleet-wire.jsonl.gz','rt'))}
rows=[json.loads(l) for l in (O/'decisions.jsonl').read_text().splitlines()]
counts=collections.Counter();missing=collections.Counter();scores=[];contexts=set();cause=collections.Counter();cause_examples={}
chains={}
for r in rows:
 o=next(o for o in r['options'] if o['mode']=='shuttle');f=frames[r['at']];s=byid[r['sourceId']]
 jt=next((t for t in r['trace'] if t['kind']=='journey'),{});board=jt.get('board');dest=jt.get('destination');j=o.get('journeyArrival')
 if not j:
  if not board:why='raw-at-stop branch found no modeled zero-time boarding row'
  elif not dest:why='no later destination row for selected boarding occurrence'
  elif dest['eta']<max(board['eta'],o['walkToSec']):why='destination median precedes pickup median or required access walk'
  else:why='other journey guard; inspect retained trace'
  cause[why]+=1;cause_examples.setdefault(why,dict(session=r['session'],at=r['at'],option=o,trace=r['trace']))
 # Exact reuse only when chosen boarding is this completed visit now; all other
 # choices remain missing until a separate occurrence-chain matcher is reviewed.
 bus=(board or {}).get('busName',o['busName'])
 if o['boardStopId']!=s['stop_id']:reason='different boarding stop needs separate chain'
 elif bus!=s['bus_name'].lstrip('#'):reason='different bus needs separate chain'
 elif not(s['anchored_at']<=r['at']<=s['departed_at']):reason='outside selected current source visit'
 elif board and board['stopsAhead']!=0:reason='modeled boarding is not current occurrence'
 elif not board and not any(b['bus_name']==s['bus_name'] and b.get('at_stop_id')==s['stop_id'] for b in f['buses']):reason='unresolved boarding identity'
 else:reason=None
 if reason:missing[reason]+=1;continue
 key=(s['id'],o['alightStopId'])
 if key not in chains:chains[key]=connect(s,o['alightStopId'])
 path,err=chains[key]
 if err:missing[err]+=1;continue
 endpoint=path[-1]['visit'];distance=sum(p['leg']['hops'] for p in path)
 if dest and dest['stopsAhead']!=distance:missing['destination is not connected current first occurrence']+=1;continue
 actual=(endpoint['arrived_at']-r['at'])/1000+o['walkFromSec']
 reachable=r['at']+o['walkToSec']*1000<=s['departed_at']
 rec=dict(session=r['session'],sourceId=s['id'],sourceVisit=s['id'],targetVisit=endpoint['id'],boardStop=o['boardStopId'],alightStop=o['alightStopId'],bus=bus,at=r['at'],firstOccurrence=True,legIds=[p['leg']['id'] for p in path],predictedSec=o['totalSec'],actualConnectedSec=actual,modeledDirectWalkSec=o['directWalkSec'],modeledAccessReachesBeforeRecordedDeparture=reachable,journeyAvailable=bool(j),top=r['order']['order'][0],errorSec=o['totalSec']-actual,actualBusBeatsModeledWalk=actual<o['directWalkSec'],earlyMiss=bool(j and endpoint['arrived_at']+o['walkFromSec']*1000<j['lowMs']),lateMiss=bool(j and endpoint['arrived_at']+o['walkFromSec']*1000>j['highMs']))
 scores.append(rec);contexts.add((s['id'],endpoint['id']));counts['matched']+=1;counts['reachable']+=reachable;counts['unavailableJourney']+=not bool(j);counts['busBeatsModeledWalk']+=rec['actualBusBeatsModeledWalk']
 if reachable:
  counts['topRedAndActualSlowerThanModeledWalk']+=rec['top']=='Red' and not rec['actualBusBeatsModeledWalk']
  counts['topWalkAndActualBusFasterThanModeledWalk']+=rec['top']=='Walk' and rec['actualBusBeatsModeledWalk']
assert len(scores)+sum(missing.values())==len(rows)
result=dict(scope='Restricted exact connected current-source boarding subset. Model access/direct walks; no actual rider or observed walking/deadline outcome. Chosen alternative stops/buses/later occurrences stay missing, never receive focal truth.',counts=dict(counts),distinctConnectedContexts=len(contexts),missing=dict(missing),missingDestinationCauses=dict(cause),causeExamples=cause_examples,scores=scores,largestErrors=sorted(scores,key=lambda s:abs(s['errorSec']),reverse=True)[:10])
(O/'outcome-audit.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps({k:v for k,v in result.items() if k not in ['scores','causeExamples','largestErrors']},indent=2))
