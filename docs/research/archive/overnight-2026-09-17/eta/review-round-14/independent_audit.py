from pathlib import Path
import json,hashlib,collections,sqlite3
O=Path(__file__).resolve().parent;B=O.parent/'cycle-15'
checks={}
for arm in ['current','canonical']:
 fresh=(O/(arm+'.mjs')).read_text().replace('/review-round-14/replay.mts','/cycle-15/replay.mts')
 assert fresh==(B/(arm+'.mjs')).read_text()
checks['freshBuildsEqualFrozenExceptEntryComments']=2
cur=(B/'current.mjs').read_text();can=(B/'canonical.mjs').read_text();before='const mean = Math.max(0.5, Math.min(40, meanCells));';after='const mean = Math.round(Math.max(0.5, Math.min(40, meanCells)) * 10) / 10;'
assert cur.count(before)==1 and cur.replace(before,after)==can
checks['onlyArmDifference']='canonical mean rounding, exactly one substitution'
shell=(B/'shell-current.generated.mts').read_text();body=shell.split(' const compute=()=>{\n',1)[1].split('\n };\n return {options:compute(),trace};',1)[0]
source=Path('/home/gwarren/projects/yale-shuttle-watcher/overnight-eta-2026-09-17/services/shuttle-v2/web/src/TransitMap.tsx').read_text()
assert body in source
checks['exactCurrentNumericalMemoBody']=True
key=lambda r:(r['poll'],r['route'],r['bus'],r['targetIndex'],r['occurrence'])
rows={key(r):r for r in map(json.loads,(O/'connected-pairs.jsonl').open())}
saved={key(r):r for r in map(json.loads,(B/'connected-pairs.jsonl').open())}
assert rows==saved and len(rows)==182918
checks['exactRescoredForecastRecords']=len(rows)
a=json.loads((B/'score.json').read_text());b=json.loads((O/'score.json').read_text())
aa=a.pop('largestPointRegressions');bb=b.pop('largestPointRegressions');assert a==b
assert sorted(r['errorIncrease'] for r in aa)==sorted(r['errorIncrease'] for r in bb)
assert max(r['errorIncrease'] for r in aa)==69
checks['allScoreFieldsEqualExceptTiedRegressionOrdering']=True
checks['regressionRankingCutoffsEqual']=True
for name in ['current-decisions.jsonl','canonical-decisions.jsonl','current-rider-outcomes.jsonl','canonical-rider-outcomes.jsonl']:
 assert (O/name).read_bytes()==(B/name).read_bytes();checks[name]='byte-identical'
a=json.loads((B/'rider-outcome-summary.json').read_text());b=json.loads((O/'rider-outcome-summary.json').read_text());a.pop('createdAt');b.pop('createdAt');assert a==b
checks['riderSummaryEqualExceptRunTimestamp']=True
for name in ['verification.json','semantic-verification.json','decision-verification.json','resume-comparison.json']:
 assert json.loads((O/name).read_text())==json.loads((B/name).read_text());checks[name]='identical'
assert json.loads((O/'join-audit.json').read_text())['counts']==json.loads((B/'join-audit.json').read_text())['counts']
changes=list(map(json.loads,(O/'join-label-changes.jsonl').open()));retargeted=[x for x in changes if x['kind']=='retargeted'];assert len(retargeted)==125
assert all(rows[key(x['final'])]==x['final'] for x in retargeted)
checks['originalRetargetedRecordsReproduced']=125
# The selected rider subset does not contain the demonstrated zero-hop
# future-pickup relabeling. This is bounded, not a global identity claim.
zero={}
for arm in ['current','canonical']:
 rr=[r for r in map(json.loads,(O/(arm+'-rider-outcomes.jsonl')).open()) if r['status']=='connected' and r['pickupForecastHops']==0]
 assert len(rr)==538 and all(r['sourceId']==r['boardVisitId'] for r in rr);zero[arm]=len(rr)
checks['selectedZeroHopRiderPickupsStayAtSource']=zero
checks['knownRemainingIdentityDefect']='Independent lagged-origin gate fails: 11 current rows and 8 following rows; reproduced arithmetic does not validate those labels.'
(O/'independent-audit.json').write_text(json.dumps(checks,indent=2)+'\n');print(json.dumps(checks,indent=2))
