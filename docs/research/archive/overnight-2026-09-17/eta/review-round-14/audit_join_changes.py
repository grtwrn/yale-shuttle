from pathlib import Path
import json,collections
O=Path(__file__).resolve().parent
key=lambda r:(r['poll'],r['route'],r['bus'],r['targetIndex'],r['occurrence'])
old={key(r):r for r in map(json.loads,(O/'initial-score-superseded/connected-pairs.jsonl').open())};counts=collections.Counter();examples=[];seen=set()
with (O/'join-label-changes.jsonl').open('w') as out:
 for r in map(json.loads,(O/'connected-pairs.jsonl').open()):
  k=key(r);a=old.get(k);seen.add(k)
  if a is None:counts['newlyScorableAfterIdentityCorrection']+=1;out.write(json.dumps({'kind':'newly-scorable','final':r})+'\n')
  elif (a['targetId'],a['truthSec'])!=(r['targetId'],r['truthSec']):
   counts['retargetedToCorrectPhysicalOccurrence']+=1;change={'kind':'retargeted','initial':a,'final':r};out.write(json.dumps(change)+'\n')
   if len(examples)<5 or (r['sourceId']==59329 and r['poll']==3870 and r['targetIndex']==18):examples.append(change)
  else:counts['identicalTruth']+=1
 for k,a in old.items():
  if k not in seen:counts['previouslyScoredNowUnresolvedOrPast']+=1;out.write(json.dumps({'kind':'no-longer-scored','initial':a})+'\n')
mid={key(r):(r['targetId'],r['truthSec']) for r in map(json.loads,(O/'intermediate-ordinal-join/connected-pairs.jsonl').open())};final={key(r):(r['targetId'],r['truthSec']) for r in map(json.loads,(O/'connected-pairs.jsonl').open())};counts['additionalCumulativeHopGuardChangedLabels']=sum(mid.get(k)!=final.get(k) for k in mid.keys()|final.keys())
result={'counts':counts,'examples':examples,'initialScoresSuperseded':True,'limits':'All original outcomes and forecasts retained. Source occurrence corrections and unresolved identity accounting are measurement changes, not estimator gains. Cumulative-hop rule also prevents unobserved visits being replaced by later laps; if no labels changed, that is a verified guard rather than an observed defect.'};(O/'join-audit.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(counts,indent=2))
