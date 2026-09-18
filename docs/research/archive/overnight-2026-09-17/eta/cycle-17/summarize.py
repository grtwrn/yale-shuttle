from pathlib import Path
import json,statistics,collections,sqlite3,datetime
O=Path(__file__).resolve().parent
score=json.loads((O/'score.json').read_text());inv=json.loads((O/'remaining-zero-hop-inventory.json').read_text());dec=json.loads((O/'decision-summary.json').read_text());rider=json.loads((O/'rider-outcome-summary.json').read_text())
ident=lambda r:(r['poll'],r['route'],r['bus'],r['targetIndex'],r['occurrence'])
uncertain={ident(c['row']) for c in inv['cases']};counts=collections.Counter();errs={a:[] for a in ['current','canonical']};complement={a:[] for a in errs};changed=[]
for r in map(json.loads,(O/'connected-pairs.jsonl').open()):
 counts['all']+=1;counts['occurrence'+str(r['occurrence'])]+=1
 if ident(r) in uncertain:
  counts['uncertainPhysicalKeys']+=1
  if r['current']!=r['canonical']:changed.append(r)
 for a in errs:
  v=abs(max(0,r[a][0])-r['truthSec']);errs[a].append(v)
  if ident(r) not in uncertain:complement[a].append(v)
for a in errs:assert len(errs[a])==score['metrics']['all'][a]['n'] and abs(statistics.mean(errs[a])-score['metrics']['all'][a]['MAE'])<1e-8
# Keep all raw changes, including unresolved and already-arrived labels.
tails=list(map(json.loads,(O/'large-tail-changes.jsonl').open()));tailReasons=collections.Counter(r['reason'] for r in tails)
regressions=score['largestPointRegressions'];db=sqlite3.connect('file:/home/gwarren/projects/yale-shuttle-watcher/release-integration-data/outcomes-complete.db?mode=ro',uri=True);db.row_factory=sqlite3.Row
context=[]
for r in regressions:
 source=dict(db.execute('select * from stop_visits where id=?',(r['sourceId'],)).fetchone());target=dict(db.execute('select * from stop_visits where id=?',(r['targetId'],)).fetchone());legs=[dict(db.execute('select * from legs where id=?',(i,)).fetchone()) for i in r['legIds']]
 assert len(legs)==len(r['legIds']);context.append({'forecast':r,'source':source,'target':target,'legs':legs})
db.close();(O/'largest-regression-context.json').write_text(json.dumps(context,indent=2)+'\n')
new={'createdAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'counts':counts,'zeroHopCounts':inv['counts'],'inclusiveMAE':{a:statistics.mean(v) for a,v in errs.items()},'complementarySensitivityMAE':{a:statistics.mean(v) if v else None for a,v in complement.items()},'uncertainDifferentArmRows':changed,'tailReasons':tailReasons,'largestRawTailChange':max(tails,key=lambda r:r['maxBandDelta']) if tails else None,'largestPointRegression':regressions[0] if regressions else None,'decisions':dec,'riders':{k:v for k,v in rider.items() if k!='largestRegressions'},'caveats':'Complement is exploratory sensitivity only, not a certified cohort or replacement score. All uncertain rows stay included. Original prefix57/58 uncertain rows and poll508 sign sensitivity remain unchanged in review15. No exclusions or calibration claims.'}
(O/'summary.json').write_text(json.dumps(new,indent=2)+'\n');print(json.dumps({k:v for k,v in new.items() if k not in ['uncertainDifferentArmRows','largestRawTailChange','largestPointRegression','decisions','riders']},indent=2))
