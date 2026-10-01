import json, collections, math
from pathlib import Path
O=Path(__file__).resolve().parent
rows=[json.loads(l) for l in (O/'decisions.jsonl').read_text().splitlines()]
by=collections.defaultdict(list)
for r in rows:by[r['session']].append(r)
summary=[];events=[];counts=collections.Counter();examples={}
for sid,rs in by.items():
 c=collections.Counter();prev=None;orders=[];destpairs=set()
 for r in rs:
  red=next((o for o in r['options'] if o['routeLabel']=='Red'),None)
  c['polls']+=1;c['redExists']+=red is not None
  if red:
   destpairs.add((red['boardStopId'],red['alightStopId']))
   j=red.get('journeyArrival');trace=next((t for t in r['trace'] if t['kind']=='journey'),{})
   fields={'journeyMissing':j is None,'catchRisk':bool(j and j['catchRisk']),'countdownDiffers':bool(j and j['busName']!=red['busName']),'departed':red.get('departed',False),'etaUnavailable':red.get('etaUnavailable',False),'pointSlowerThanWalk':red['totalSec']>red['directWalkSec'],'walkIsTop':r['order']['order'][0]=='Walk','pendingRank':bool(r['order'].get('pending')),'nonzeroAccess':red['walkToSec']>0,'windowStraddlesWalk':bool(j and j['lowMs']<=r['at']+red['directWalkSec']*1000<=j['highMs'])}
   for k,v in fields.items():
    c[k]+=v
    if v:examples.setdefault(k,{f:r[f] for f in ['session','at','sourceId','sourceStop','target','offsetM','order','options','trace']})
   state={'order':r['order']['order'],'tier':red['tier'],'countdown':red['busName'],'journeyBus':j['busName'] if j else None,'available':j is not None,'departed':red.get('departed',False)}
  else:state={'order':r['order']['order'],'tier':None,'countdown':None,'journeyBus':None,'available':False,'departed':False}
  if prev:
   changes=[k for k in state if state[k]!=prev[k]]
   if changes:
    for k in changes:c[k+'Changes']+=1
    events.append(dict(session=sid,at=r['at'],changes=changes,before=prev,after=state,order=r['order']))
  prev=state
 summary.append(dict(session=sid,counts=dict(c),boardAlightPairs=sorted(destpairs),firstAt=rs[0]['at'],lastAt=rs[-1]['at'],initialOrder=rs[0]['order'],finalOrder=rs[-1]['order']))
 counts.update(c)
assert len(by)==40
out=dict(scope='Selected current-code diagnostic, repeated correlated polls, modeled walking, no candidate.',totals=dict(counts),sessions=summary,events=events,examples=examples)
(O/'decision-summary.json').write_text(json.dumps(out,indent=2)+'\n')
print(json.dumps({'sessions':len(by),'totals':dict(counts),'pairs':dict(collections.Counter(str(x['boardAlightPairs']) for x in summary))},indent=2))
