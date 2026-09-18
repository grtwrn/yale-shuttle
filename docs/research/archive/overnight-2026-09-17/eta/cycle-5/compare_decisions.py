"""Pair decisions only by exact outcome identity; retain changed/unmatched choices."""
from pathlib import Path
import json,collections,statistics,sys
O=Path(sys.argv[1]);B=Path('/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/cycle-4')
def read(p):return json.loads(p.read_text())
def identity(r):return (r['session'],r['at'],r['sourceVisit'],r['targetVisit'],r['bus'])
a=read(B/'outcome-audit.json');b=read(O/'outcome-audit.json');am={identity(r):r for r in a['scores']};bm={identity(r):r for r in b['scores']};keys=am.keys()&bm.keys()
matched=[dict(identity=k,baseline=am[k],candidate=bm[k]) for k in sorted(keys)]
for r in matched:assert r['baseline']['actualConnectedSec']==r['candidate']['actualConnectedSec'] and r['baseline']['legIds']==r['candidate']['legIds']
availability=collections.Counter();choice=collections.Counter()
da={(r['session'],r['at']):r for r in map(json.loads,(B/'decisions.jsonl').open())};db={(r['session'],r['at']):r for r in map(json.loads,(O/'decisions.jsonl').open())};assert da.keys()==db.keys()
for k,x in da.items():
 y=db[k];ao=next(o for o in x['options'] if o['mode']=='shuttle');bo=next(o for o in y['options'] if o['mode']=='shuttle')
 av=bool(ao.get('journeyArrival'));bv=bool(bo.get('journeyArrival'));availability[str((av,bv))]+=1
 aj=ao.get('journeyArrival',{});bj=bo.get('journeyArrival',{})
 choice['journeyBusChanged']+=aj.get('busName')!=bj.get('busName')
 choice['countdownBusChanged']+=ao['busName']!=bo['busName']
 choice['topRouteChanged']+=x['order']['order'][0]!=y['order']['order'][0]
summary=dict(decisions=len(da),availability=dict(availability),choices=dict(choice),baselineMatched=len(am),candidateMatched=len(bm),exactPairedOutcomes=len(keys),baselineOnlyOutcomeIdentities=len(am.keys()-bm.keys()),candidateOnlyOutcomeIdentities=len(bm.keys()-am.keys()),baselineMissing=a['missing'],candidateMissing=b['missing'],metrics={arm:dict(n=len(matched),mae=statistics.mean(abs(r[arm]['errorSec']) for r in matched),early=sum(r[arm]['earlyMiss'] for r in matched if r[arm]['journeyAvailable']),late=sum(r[arm]['lateMiss'] for r in matched if r[arm]['journeyAvailable']),journeyAvailable=sum(r[arm]['journeyAvailable'] for r in matched),modeledAccessMisses=sum(not r[arm]['modeledAccessReachesBeforeRecordedDeparture'] for r in matched)) for arm in ['baseline','candidate']},scope='Exact connected historical bus journeys for selected hypothetical stationary riders. Access and direct walking modeled, not observed; changed alternative choices never receive old focal truth. Early/late counts have different available distributions and are not paired coverage estimates.')
(O/'decision-comparison.json').write_text(json.dumps(dict(summary=summary,paired=matched),indent=2)+'\n');print(json.dumps(summary,indent=2))
