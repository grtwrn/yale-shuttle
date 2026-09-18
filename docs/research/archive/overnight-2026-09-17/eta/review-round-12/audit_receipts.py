"""Bounded, read-only receipt provenance audit; no forecast/replay production."""
from pathlib import Path
from collections import defaultdict, Counter
from bisect import bisect_left,bisect_right
import json, datetime, hashlib, statistics
O=Path(__file__).resolve().parent; P=Path('/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta'); R=P.parents[1]
load=lambda p:json.loads(p.read_text())
plan=load(O/'PLAN.json')
for name,digest in plan['inputs'].items():
 assert hashlib.sha256(Path(name).read_bytes()).hexdigest()==digest,name
stamp=lambda s:round(datetime.datetime.fromisoformat(s.replace('Z','+00:00')).replace(tzinfo=datetime.timezone.utc).timestamp()*1000) if isinstance(s,str) else s
cases=[c for c in load(P/'cycle-6/missing-cases.json') if c['causal']['pickupRows'][0]['hops']==29]
assert len(cases)==38
sources={c['sourceId']:c for c in cases}
windows={sid:(c['retrospective']['sourcePinnedAt']-60000,c['retrospective']['sourceDepartedAt']+90000) for sid,c in sources.items()}
fields=['observed_at','bus_id','bus_name','route_id','lat','lon','heading','last_stop_id','stationary','at_stop_id','at_stop_since','stationary_since','last_moved_at','lap']
raw=defaultdict(list)
for line in (R/'conditional-replay-data/raw-frames.jsonl').open():
 f=json.loads(line);at=stamp(f['at'])
 for sid,(lo,hi) in windows.items():
  if lo-120000<=at<=hi:
   b=next((b for b in f['buses'] if b['bus_name']=='#'+sources[sid]['bus']),None)
   if b:raw[sid].append({'at':at,'bus':b})
rawtimes={sid:[r['at'] for r in rows] for sid,rows in raw.items()}
receipts=[]; inventory=[]
for filename in plan['inputs']:
 p=Path(filename)
 if 'ongoing-rider-qa' not in filename:continue
 total=0;selected=0;first=last=None;etaRows=0
 for lineNo,line in enumerate(p.open(),1):
  f=json.loads(line);total+=1;at=stamp(f['at']);first=at if first is None else first;last=at
  etaRows+=int('server_eta' in f)
  for sid,(lo,hi) in windows.items():
   if not lo<=at<=hi:continue
   b=next((b for b in f.get('buses',[]) if b['bus_name']=='#'+sources[sid]['bus']),None)
   if b is None:continue
   receipt=at-f['feedAgeMs']; rs=raw[sid]; times=rawtimes[sid]
   available=rs[bisect_left(times,receipt-120000):bisect_right(times,receipt)]
   exactFields=['bus_id','bus_name','route_id','lat','lon','heading']
   if 'observed_at' in b:
    candidates=[r for r in rs if r['at']==b['observed_at'] and all(r['bus'].get(k)==b.get(k) for k in exactFields)]
    method='observed_at'
   else:
    candidates=[r for r in available if all(r['bus'].get(k)==b.get(k) for k in exactFields) and r['bus'].get('last_moved_at')==b.get('last_moved_at')]
    method='position-and-movement-clock'
   comparisons=[]
   for r in candidates:
    diff={k:{'sample':b.get(k),'reconstructed':r['bus'].get(k)} for k in fields if k!='observed_at' and b.get(k)!=r['bus'].get(k)}
    comparisons.append({'collectedAt':r['at'],'differences':diff})
   receipts.append(dict(sourceId=sid,stream=p.parent.name,file=str(p),line=lineNo,sampledAt=at,receiptAt=receipt,feedAgeMs=f['feedAgeMs'],bus={k:b[k] for k in fields if k in b},matchMethod=method,candidates=comparisons))
   selected+=1
 inventory.append(dict(file=str(p),samples=total,firstSample=first,lastSample=last,selected=selected,serverEtaSnapshots=etaRows))
receipts.sort(key=lambda r:(r['sampledAt'],r['stream'],r['sourceId']))
with (O/'sanitized-receipts.jsonl').open('w') as out:
 for r in receipts:out.write(json.dumps(r,separators=(',',':'))+'\n')
perSource=[]
for sid,c in sources.items():
 xs=[r for r in receipts if r['sourceId']==sid];stop=c['sourceStop'];pin=c['retrospective']['sourcePinnedAt'];dep=c['retrospective']['sourceDepartedAt']
 transitions=[]
 for stream in ['red','rotation']:
  ss=[r for r in xs if r['stream']==stream];seen=set();prev=None
  for r in ss:
   key=(r['receiptAt'],json.dumps(r['bus'],sort_keys=True))
   if key in seen:continue
   seen.add(key)
   state=r['bus'].get('at_stop_id')==stop
   if prev is None or state!=(prev['bus'].get('at_stop_id')==stop):
    transitions.append(dict(stream=stream,atStop=state,previousReceiptAt=prev['receiptAt'] if prev else None,receiptAt=r['receiptAt'],sampledAt=r['sampledAt'],pinOffsetSec=(r['receiptAt']-pin)/1000,departureOffsetSec=(r['receiptAt']-dep)/1000,collectionAt=r['bus'].get('observed_at'),leftCensored=prev is None,intervalSec=(r['receiptAt']-prev['receiptAt'])/1000 if prev else None))
   prev=r
 diffs=Counter(k for r in xs for cc in r['candidates'] for k in cc['differences'])
 perSource.append(dict(sourceId=sid,bus=c['bus'],stop=stop,samples=len(xs),withObservedAt=sum('observed_at' in r['bus'] for r in xs),uniqueMatch=sum(len(r['candidates'])==1 for r in xs),ambiguousMatch=sum(len(r['candidates'])>1 for r in xs),unmatched=sum(not r['candidates'] for r in xs),atStopSamples=sum(r['bus'].get('at_stop_id')==stop for r in xs),atStopReceivedAfterRecordedDeparture=sum(r['bus'].get('at_stop_id')==stop and r['receiptAt']>dep for r in xs),diffFieldUses=dict(diffs),transitions=transitions))
caseEvidence=[]
for c in cases:
 xs=[r for r in receipts if r['sourceId']==c['sourceId']]
 supports=[r for r in xs if any(v['collectedAt']==c['at'] for v in r['candidates'])]
 exact=[r for r in supports if r['matchMethod']=='observed_at']
 unique=[r for r in supports if len(r['candidates'])==1]
 nearby=[r for r in xs if abs(r['receiptAt']-c['at'])<=15000]
 caseEvidence.append(dict(session=c['session'],sourceId=c['sourceId'],at=c['at'],target=c['target'],beforeRecordedDeparture=not c['retrospective']['afterRecordedDeparture'],supports=[dict(file=r['file'],line=r['line'],receiptAt=r['receiptAt'],sampledAt=r['sampledAt'],matchMethod=r['matchMethod'],candidateCount=len(r['candidates']),atStopId=r['bus'].get('at_stop_id'),stationary=r['bus'].get('stationary'),differences=next(v['differences'] for v in r['candidates'] if v['collectedAt']==c['at'])) for r in supports],exactObservedAt=bool(exact),uniqueCompatible=bool(unique),ambiguousOnly=bool(supports) and not unique,nearbySamples=len(nearby),nearbyAtSource=sum(r['bus'].get('at_stop_id')==c['sourceStop'] for r in nearby)))
summary=dict(cohort=dict(decisions=len(cases),busPolls=len({(c['at'],c['bus']) for c in cases}),sources=len(sources)),inventory=inventory,sanitizedSamples=len(receipts),uniqueResponseSourcePairs=len({(r['stream'],r['sourceId'],r['receiptAt']) for r in receipts}),serverEtaSnapshots=sum(x['serverEtaSnapshots'] for x in inventory),perSource=perSource,caseCoverage=dict(exactObservedAt=sum(x['exactObservedAt'] for x in caseEvidence),uniqueCompatible=sum(x['uniqueCompatible'] for x in caseEvidence),ambiguousOnly=sum(x['ambiguousOnly'] for x in caseEvidence),noCompatibleReceipt=sum(not x['supports'] for x in caseEvidence),nearbyRawAtSource=sum(x['nearbyAtSource']>0 for x in caseEvidence)),limitations=['Sample response receipt is an upper bound on when a field was published, not exact first publication.','Without observed_at, a unique match under a 120s search/clock contract is compatibility, not proof of collection identity.','No server_eta snapshots: never claim live served-position parity or replay accuracy from this audit.','Response onset brackets can include omitted polls, window censoring and prior/different stop visits.','Collected positions are not doors-open or physical boarding evidence.'])
(O/'receipt-audit.json').write_text(json.dumps(summary,indent=2)+'\n');(O/'case-evidence.json').write_text(json.dumps(caseEvidence,indent=2)+'\n')
print(json.dumps({k:v for k,v in summary.items() if k!='perSource'},indent=2))
for r in perSource:print(json.dumps({k:v for k,v in r.items() if k!='transitions'}))
