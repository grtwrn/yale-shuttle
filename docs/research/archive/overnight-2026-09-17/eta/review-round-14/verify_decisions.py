from pathlib import Path
import json,collections
O=Path(__file__).resolve().parent;c=collections.Counter();sessions=set()
for aa,bb in zip((O/'current-decisions.jsonl').open(),(O/'canonical-decisions.jsonl').open(),strict=True):
 a,b=json.loads(aa),json.loads(bb);assert (a['session'],a['at'])==(b['session'],b['at']);sessions.add(a['session']);c['pairedDecisions']+=1;c['visibleOrderDifferences']+=a['visible']!=b['visible']
 vehicle=lambda x:(x['routeLabel'],(x.get('livePickupSelection') or {}).get('boarding',{}).get('busName'))
 ident=lambda x:vehicle(x)+(x['boardStopId'],x['alightStopId'],(x.get('livePickupSelection') or {}).get('boarding',{}).get('stopsAhead'),(x.get('livePickupSelection') or {}).get('relation'))
 c['boardingVehicleDifferences']+=[vehicle(x) for x in a['options']]!=[vehicle(x) for x in b['options']]
 c['pickupSelectionMetadataDifferences']+=[ident(x) for x in a['options']]!=[ident(x) for x in b['options']]
 for x in a['options']:
  yy=[y for y in b['options'] if y['routeLabel']==x['routeLabel']];assert len(yy)==1;y=yy[0];ja,jb=x.get('journeyArrival'),y.get('journeyArrival')
  c['journeyAvailabilityDifferences']+=bool(ja)!=bool(jb)
  c['cautionDifferences']+=(ja or {}).get('catchRisk')!=(jb or {}).get('catchRisk')
  for minutes in [15,30,45]:c['syntheticPointDeadlineDifferences']+=(x['totalSec']<=minutes*60)!=(y['totalSec']<=minutes*60)
saved=json.loads((O/'decision-summary.json').read_text())
for k,v in c.items():assert saved[k]==v,(k,saved[k],v)
assert len(sessions)==saved['sessions']
result={'counts':c,'sessions':len(sessions),'cautionField':'journeyArrival.catchRisk','note':'The interrupted script compared an absent top-level catchRisk field. This independent check uses the actual nested journey field and also finds zero differences. Saved forecasts/options unchanged; no browser assertion.'};(O/'decision-verification.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result,indent=2))
