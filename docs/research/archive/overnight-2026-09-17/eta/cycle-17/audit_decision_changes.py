from pathlib import Path
import json,collections
O=Path(__file__).resolve().parent
outcomes={arm:{(r['session'],r['at'],r['routeLabel']):r for r in map(json.loads,(O/(arm+'-rider-outcomes.jsonl')).open())} for arm in ['current','canonical']}
counts=collections.Counter();cases=[]
for aa,bb in zip((O/'current-decisions.jsonl').open(),(O/'canonical-decisions.jsonl').open(),strict=True):
 a,b=json.loads(aa),json.loads(bb);assert (a['session'],a['at'])==(b['session'],b['at']);changes=[]
 if a['visible']!=b['visible']:changes.append({'kind':'visible-route-order','current':a['visible'],'canonical':b['visible']});counts['visible-route-order']+=1
 for x in a['options']:
  yy=[y for y in b['options'] if y['routeLabel']==x['routeLabel']];assert len(yy)==1;y=yy[0]
  facts=[]
  if (x.get('journeyArrival') or {}).get('catchRisk')!=(y.get('journeyArrival') or {}).get('catchRisk'):facts.append({'kind':'walking-caution','current':(x.get('journeyArrival') or {}).get('catchRisk'),'canonical':(y.get('journeyArrival') or {}).get('catchRisk')});counts['walking-caution']+=1
  for mins in [15,30,45]:
   if (x['totalSec']<=mins*60)!=(y['totalSec']<=mins*60):facts.append({'kind':'synthetic-point-deadline','minutes':mins,'currentPass':x['totalSec']<=mins*60,'canonicalPass':y['totalSec']<=mins*60});counts['synthetic-point-deadline']+=1
  if facts or a['visible']!=b['visible']:
   key=(a['session'],a['at'],x['routeLabel']);changes.append({'routeLabel':x['routeLabel'],'facts':facts,'current':x,'canonical':y,'currentOutcome':outcomes['current'].get(key),'canonicalOutcome':outcomes['canonical'].get(key)})
 if changes:cases.append({'session':a['session'],'at':a['at'],'changes':changes})
summary=json.loads((O/'decision-summary.json').read_text());assert counts['visible-route-order']==summary['visibleOrderDifferences'] and counts['walking-caution']==summary['cautionDifferences'] and counts['synthetic-point-deadline']==summary['syntheticPointDeadlineDifferences']
result={'counts':counts,'cases':cases,'limits':'All actual saved selector changes in fixed historical sessions. Synthetic deadlines and modeled walking are not observed preferences or physical boarding. Retain unresolved outcomes; these are not on-time probabilities.'}
(O/'decision-case-audit.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(counts))
for c in cases:
 print(c['session'],c['at'])
 for d in c['changes']:
  if 'routeLabel' in d:
   print(d['routeLabel'],d['facts'],'total',d['current']['totalSec'],d['canonical']['totalSec'],'outcome',[(d[a+'Outcome'] or {}).get('reason') for a in ['current','canonical']])
  else: print(d)
