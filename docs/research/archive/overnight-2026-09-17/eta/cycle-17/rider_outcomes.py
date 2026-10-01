from pathlib import Path
import json,gzip,bisect,collections,statistics,datetime,sqlite3
O=Path(__file__).resolve().parent
# Reuse the already audited exact-identity chain reader, not any scoring/output loop.
exec((O/'score.py').read_text().split('def keyed(f):')[0])
legById={l['id']:l for ls in legs.values() for l in ls}
decisions={a:[json.loads(l) for l in (O/(a+'-decisions.jsonl')).open()] for a in ['current','canonical']}
needed={r['at'] for r in decisions['current']};mapping={};matchedFiles={};armCounts={}
for arm in ['current','canonical']:
 wireAt={}
 for line in gzip.open(O/(arm+'-resume6000-wire.jsonl.gz'),'rt'):
  f=json.loads(line)
  if f['at'] not in needed:continue
  groups=collections.defaultdict(list)
  for row in f['wire']['rows']:groups[row[0]].append(row)
  byrow={}
  for bi,rows in groups.items():
   bus,label=f['wire']['buses'][bi][:2];track=f['tracking'][label+'|'+bus];route=track[0];seq=top[route];N=len(seq)
   origins=[j for j in range(N) if all(seq[(j+r[5])%N]==r[1] for r in rows)];assert len(origins)==1
   byidx=collections.defaultdict(list)
   for r in rows:byidx[(origins[0]+r[5])%N].append(r)
   for idx,rs in byidx.items():
    for occ,r in enumerate(sorted(rs,key=lambda r:r[5])):byrow[(label,bus,r[1],r[5])]={'route':route,'idx':idx,'occ':occ,'firstHop':min(z[5] for z in rs),'row':r}
  wireAt[f['at']]=byrow
 output=[];counts=collections.Counter()
 for d in decisions[arm]:
  at=d['at'];look=wireAt[at]
  for opt in d['options']:
   if opt['mode']!='shuttle':continue
   result={'session':d['session'],'at':at,'routeLabel':opt['routeLabel'],'boardStop':opt['boardStopId'],'targetStop':opt['alightStopId'],'status':'unresolved','predictedTotalSec':opt['totalSec'],'walkToSec':opt['walkToSec'],'walkFromSec':opt['walkFromSec']}
   def resolve():
    selection=opt.get('livePickupSelection');boarding=selection.get('boarding') if selection else None
    if not boarding:return 'no-selected-pickup'
    bus=boarding['busName'].lstrip('#');result['bus']=bus
    traces=[t for t in d['trace'] if t['kind']=='journey' and t.get('board') and t['board']['routeLabel']==opt['routeLabel'] and t['board']['busName'].lstrip('#')==bus and t['board']['stopId']==opt['boardStopId']]
    if len(traces)!=1:return 'missing-or-ambiguous-journey-trace'
    trace=traces[0];board=trace['board'];dest=trace.get('destination')
    if not trace.get('available') or not dest or not opt.get('journeyArrival'):return 'missing-destination-forecast'
    bmap=look.get((opt['routeLabel'],bus,board['stopId'],board['stopsAhead']));dmap=look.get((opt['routeLabel'],bus,dest['stopId'],dest['stopsAhead']))
    if not bmap or not dmap:return 'missing-exact-wire-row'
    route=bmap['route'];result['route']=route;seq=top[route];N=len(seq);si=bisect.bisect_right(times.get((route,bus),[]),at)-1
    if si<0:return 'no-source'
    source=bybus[(route,bus)][si];vs,ls,end=chain(source);result['sourceId']=source['id'];result['chainEnd']=end
    if boarding['source']=='raw-at-stop':
     if source['stop_index']!=bmap['idx'] or source['stop_id']!=opt['boardStopId']:return 'raw-source-visit-unresolved'
     bi=0
    else:
     same=source['stop_index']==bmap['idx']
     if same and 0<bmap['firstHop']<N:return 'source-target-identity-unresolved'
     firstDistance=(bmap['idx']-source['stop_index'])%N
     if same and bmap['firstHop']!=0:firstDistance=N
     distance=firstDistance+bmap['occ']*N;cs=chain_hops(source,ls)
     if distance not in cs:return 'pickup-chain-incomplete-or-skipped'
     bi=cs.index(distance);assert vs[bi]['stop_index']==bmap['idx']
    boardVisit=vs[bi];result['boardVisitId']=boardVisit['id'];result['boardOutcome']=boardVisit['outcome'];result['boardDepartureAt']=boardVisit['departed_at']
    if boardVisit['departed_at'] is None:return 'pickup-departure-unknown'
    delta=dest['stopsAhead']-board['stopsAhead'];assert delta>0
    if seq[(bmap['idx']+delta)%N]!=dest['stopId'] or (bmap['idx']+delta)%N!=dmap['idx']:return 'forecast-ride-index-inconsistent'
    walked=0;ti=None
    for i in range(bi+1,len(vs)):
     walked+=legById[ls[i-1]]['hops']
     if walked==delta:ti=i;break
     if walked>delta:break
    if ti is None:return 'destination-chain-incomplete'
    target=vs[ti];assert target['stop_index']==dmap['idx'] and target['stop_id']==opt['alightStopId'];arrival=target['arrived_at'] if target['arrived_at'] is not None else target['departed_at']
    if arrival is None:return 'target-arrival-unknown'
    result.update(status='connected',targetVisitId=target['id'],targetOutcome=target['outcome'],targetArrivalAt=arrival,legIds=ls[bi:ti],pickupForecastHops=board['stopsAhead'],destinationForecastHops=dest['stopsAhead'],arrivalPlusModeledEgressSec=(arrival-at)/1000+opt['walkFromSec'],modelAccessBeforeRecordedDeparture=at+opt['walkToSec']*1000<=boardVisit['departed_at'],forecast=opt['journeyArrival'])
    return 'connected'
   reason=resolve();result['reason']=reason;counts[reason]+=1;output.append(result)
 (O/(arm+'-rider-outcomes.jsonl')).write_text(''.join(json.dumps(r)+'\n' for r in output));matchedFiles[arm]=output;armCounts[arm]=counts
assert len(matchedFiles['current'])==len(matchedFiles['canonical']);counts=collections.Counter();pairs=[];errors={a:[] for a in ['current','canonical']}
for a,b in zip(matchedFiles['current'],matchedFiles['canonical'],strict=True):
 assert (a['session'],a['at'],a['routeLabel'],a['boardStop'],a['targetStop'])==(b['session'],b['at'],b['routeLabel'],b['boardStop'],b['targetStop'])
 if a['status']!='connected' or b['status']!='connected':counts['unresolvedAtLeastOne']+=1;continue
 ident=lambda r:(r['route'],r['bus'],r['boardVisitId'],r['targetVisitId'],r['legIds'])
 same=ident(a)==ident(b);counts['bothConnected']+=1;counts['sameConnectedTrip' if same else 'differentConnectedTrips']+=1
 if same:
  assert a['arrivalPlusModeledEgressSec']==b['arrivalPlusModeledEgressSec'];truth=a['arrivalPlusModeledEgressSec'];ea=abs(a['predictedTotalSec']-truth);eb=abs(b['predictedTotalSec']-truth);errors['current'].append(ea);errors['canonical'].append(eb);counts['modelAccessBeforeRecordedDeparture']+=a['modelAccessBeforeRecordedDeparture'];pairs.append({'current':a,'canonical':b,'errorIncrease':eb-ea})
summary={'createdAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'arms':armCounts,'paired':counts,'sameTripMetrics':{a:{'rows':len(e),'MAE':statistics.mean(e) if e else None,'median':statistics.median(e) if e else None} for a,e in errors.items()},'largestRegressions':sorted(pairs,key=lambda r:r['errorIncrease'],reverse=True)[:10],'limits':'Reused selected stationary-origin sessions; correlated option-polls, not independent riders. Arrival truth is recorded connected target time plus modeled egress, not observed walking. Access compared to retrospective recorded departure is not proof of physical boarding, especially passed stops/raw current transitions. Exact positive-sublap source identities and incomplete chains remain unresolved. No browser, calibration or rider-choice improvement claim.'}
(O/'rider-outcome-summary.json').write_text(json.dumps(summary,indent=2)+'\n');print(json.dumps({k:v for k,v in summary.items() if k!='largestRegressions'},indent=2))
