import collections,gzip,hashlib,json,math,sqlite3
from pathlib import Path
O=Path(__file__).resolve().parent; B=O.parent/'cycle-4'; A=O.parents[2]
read=lambda p:json.loads(p.read_text())
plan=read(B/'PLAN.json')
for p,h in plan['hashes'].items():assert hashlib.sha256(Path(p).read_bytes()).hexdigest()==h,p
for p,h in read(O/'builder-before.json').items():assert hashlib.sha256((B/p).read_bytes()).hexdigest()==h,p
frames=[json.loads(l) for l in gzip.open(B/'fleet-wire.jsonl.gz','rt')]; bytime={f['at']:f for f in frames}
raw={}
for l in (A/'conditional-replay-data/raw-frames.jsonl').read_text().splitlines():
 f=json.loads(l);raw[f['at']]=f['buses']
from datetime import datetime,timezone
rows=zero=positive=contradict=alias=0; last={}; badstops=collections.Counter(); aliases=[]
for f in frames:
 key=datetime.fromtimestamp(f['at']/1000,timezone.utc).isoformat(timespec='milliseconds').replace('+00:00','Z')
 assert f['buses']==raw[key]
 assert f['contexts']==[w['sourceId'] for w in plan['windows'] if w['start']<=f['at']<=w['end']]
 wire=f['server_eta']; assert wire['at']==wire['servedAt']==f['at'];seen=set(); groups=collections.defaultdict(list)
 for r,d in zip(wire['rows'],wire['distributions']):
  rows+=1; assert (r[0],r[1],r[5]) not in seen;seen.add((r[0],r[1],r[5]))
  assert len(d)==50 and d==sorted(d) and all(math.isfinite(x) and x>=0 for x in d)
  groups[r[0],r[1]].append(r)
  if r[5]==0:
   zero+=1
   if r[2]>0:
    positive+=1;badstops[r[1]]+=1
    contradict+=any(x[0]==r[0] and x[5]>0 and x[2]<r[2] for x in wire['rows'])
 for (bi,stop),rs in groups.items():
  for occurrence,r in enumerate(sorted(rs,key=lambda r:r[5])):
   k=(wire['buses'][bi][0],stop,occurrence);old=last.get(k)
   if old and 0<f['at']-old[0]<=15000 and old[1][5]-r[5]>=28 and r[5]==0 and r[2]>0:
    dt=(f['at']-old[0])/1000; expected=max(0,(old[1][2]-dt)*math.exp(-dt/30))
    assert abs(r[2]-expected)<1;alias+=1;aliases.append(dict(at=f['at'],bus=k[0],stop=stop,hopsBefore=old[1][5],hopsAfter=r[5],error=r[2]-expected))
   last[k]=(f['at'],r)
assert (rows,zero,positive,contradict,alias)==(160496,1734,101,84,6)
# Recompute old trace transport parity independently, including complete vectors.
parity=0
for l in (O.parent/'cycle-2/current-trace.jsonl').read_text().splitlines():
 r=json.loads(l)
 if r['at'] not in bytime:continue
 w=bytime[r['at']]['server_eta'];bis=[i for i,b in enumerate(w['buses']) if b[0]==r['bus'].lstrip('#')];assert len(bis)==1
 for old in r['forecasts']:
  matches=[(row,d) for row,d in zip(w['rows'],w['distributions']) if row[0]==bis[0] and row[1]==old['target'] and row[5]==old['stopsAhead']];assert len(matches)==1
  row,d=matches[0]; rnd=lambda x:math.floor(x+0.5)
  assert row[2:5]==[rnd(old[k]) for k in ['eta','low','high']]
  assert d==list(map(rnd,old['distribution']));parity+=1
assert parity==6025
# Revalidate exact published source/leg/target records without reusing connect().
db=sqlite3.connect('file:'+str(A/'conditional-replay-data/outcomes.db')+'?mode=ro',uri=True);db.row_factory=sqlite3.Row
visits={r['id']:dict(r) for r in db.execute('select * from stop_visits where route_id=3')}; legs={r['id']:dict(r) for r in db.execute('select * from legs where route_id=3')}; seq=json.loads(db.execute('select stops_json from routes where id=3').fetchone()[0]);db.close()
vs=collections.defaultdict(list)
for v in visits.values():
 for t in set([v['arrived_at']]+([v['departed_at']] if v['outcome']=='passed' else [])):
  vs[v['bus_name'],v['stop_id'],v['stop_index'],t].append(v)
decisions=[json.loads(l) for l in (B/'decisions.jsonl').read_text().splitlines()];di={(r['session'],r['at']):r for r in decisions}; outcome=read(B/'outcome-audit.json')
reachable=0;contexts=set();usedlegs=0;available=0;redslower=walkfaster=0
for s in outcome['scores']:
 d=di[s['session'],s['at']]; opt=next(o for o in d['options'] if o['mode']=='shuttle'); source=visits[s['sourceId']];endpoint=visits[s['targetVisit']]
 assert source['anchored_at']<=s['at']<=source['departed_at'];assert source['bus_name'].lstrip('#')==s['bus'];assert source['stop_id']==opt['boardStopId'];assert endpoint['stop_id']==opt['alightStopId']
 departure=source['departed_at'];idx=source['stop_index'];hops=0
 for lid in s['legIds']:
  leg=legs[lid];usedlegs+=1
  assert leg['departed_at']==departure and leg['from_index']==idx and leg['bus_name']==source['bus_name'] and leg['reached']==1
  assert leg['to_stop_id']==seq[leg['to_index']] and (leg['to_index']-idx)%len(seq)==leg['hops'];hops+=leg['hops']
  candidates=[v for v in vs[source['bus_name'],leg['to_stop_id'],leg['to_index'],leg['arrived_at']] if source['anchored_at']<=v['anchored_at']<=leg['arrived_at']];assert len(candidates)==1
  v=candidates[0];assert v['how']!='gap';departure=v['departed_at'];idx=v['stop_index']
 assert v['id']==endpoint['id'];assert hops==(endpoint['stop_index']-source['stop_index'])%len(seq)
 trace=next(t for t in d['trace'] if t['kind']=='journey');board=trace.get('board'); dest=trace.get('destination')
 if board:assert board['stopsAhead']==0 and board['busName']==s['bus']
 if dest:assert dest['stopsAhead']==hops and dest['busName']==s['bus']
 actual=(endpoint['arrived_at']-s['at'])/1000+opt['walkFromSec'];assert abs(actual-s['actualConnectedSec'])<1e-8
 catch=s['at']+opt['walkToSec']*1000<=source['departed_at']; assert catch==s['modeledAccessReachesBeforeRecordedDeparture'];reachable+=catch
 assert abs(opt['totalSec']-actual-s['errorSec'])<1e-8
 j=opt.get('journeyArrival');available+=bool(j)
 assert s['earlyMiss']==bool(j and endpoint['arrived_at']+opt['walkFromSec']*1000<j['lowMs'])
 assert s['lateMiss']==bool(j and endpoint['arrived_at']+opt['walkFromSec']*1000>j['highMs'])
 if catch:
  redslower+=s['top']=='Red' and actual>=opt['directWalkSec'];walkfaster+=s['top']=='Walk' and actual<opt['directWalkSec']
 contexts.add((source['id'],endpoint['id']))
assert (len(outcome['scores']),reachable,len(contexts),len(decisions)-len(outcome['scores']),redslower,walkfaster)==(1420,1382,20,3268,481,0)
# All decisions remain grouped by persistent session, with no undetected early ranking switches.
sessions=collections.defaultdict(list)
for d in decisions:sessions[d['session']].append(d)
changes=0
for sid,ds in sessions.items():
 assert len({json.dumps(d['stable'],sort_keys=True) for d in ds})==1 and sum(d['reset'] for d in ds)==1
 for a,b in zip(ds,ds[1:]):
  if a['order']['order']!=b['order']['order']:
   changes+=1;assert a['order'].get('pending') and b['at']-a['order']['pending']['since']>=30000
assert changes==48
# Generated observer differs only by import resolution plus the declared raw clone.
import re
source=Path('/home/gwarren/projects/yale-shuttle-watcher/overnight-eta-2026-09-17/services/shuttle-v2/web/src/eta/index.ts'); text=source.read_text()
def fix(m):return "from '"+(source.parent/m.group(1)).resolve().with_suffix('.ts').as_uri()+"'"
text=re.sub(r'''from ["'](\.{1,2}/[^"']+)["']''',fix,text)
text=text.replace('export function arrivalsForBus(','export let observedRaw: any[] = [];\nexport function arrivalsForBus(',1).replace('  // Pool absolute arrival quantiles only while the tracked rest continues.','  observedRaw = structuredClone(rows);\n  // Pool absolute arrival quantiles only while the tracked rest continues.')
assert text==(B/'pool-observer.generated.mts').read_text()
report=dict(inputHashes=len(plan['hashes']),unchangedBuilderFiles=len(read(O/'builder-before.json')),frames=len(frames),wireRows=rows,zeroHopRows=zero,positiveZeroHopRows=positive,positiveStops=dict(badstops),downstreamContradictions=contradict,aliases=aliases,previousTraceParity=parity,outcomeRows=len(outcome['scores']),connectedLegUses=usedlegs,reachable=reachable,modeledMisses=len(outcome['scores'])-reachable,contexts=len(contexts),unmatched=3268,journeyAvailable=available,sessions=len(sessions),rankChanges=changes,observerSourceExact=True)
(O/'evidence.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report,indent=2))
