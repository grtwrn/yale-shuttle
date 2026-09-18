from pathlib import Path
import json,gzip,sqlite3,itertools,collections,hashlib
from functools import lru_cache
O=Path(__file__).resolve().parent
meta=json.loads((O/'current-meta.json').read_text());top={int(k):v['stops'] for k,v in meta['routeMeta'].items()};labels={v['label']:int(k) for k,v in meta['routeMeta'].items()}
db=sqlite3.connect('file:/home/gwarren/projects/yale-shuttle-watcher/release-integration-data/outcomes-complete.db?mode=ro',uri=True);db.row_factory=sqlite3.Row
@lru_cache(None)
def visit(i):return dict(db.execute('select * from stop_visits where id=?',(i,)).fetchone())
@lru_cache(None)
def leg(i):return dict(db.execute('select * from legs where id=?',(i,)).fetchone())
@lru_cache(None)
def next_visit(cid,lid):
 cur,l=visit(cid),leg(lid)
 vv=list(db.execute("select * from stop_visits where route_id=? and bus_name=? and stop_index=? and anchored_at between ? and ? and (how is null or how!='gap') and (arrived_at=? or (arrived_at is null and outcome='passed' and departed_at=?))",(l['route_id'],cur['bus_name'],l['to_index'],cur['anchored_at'],l['arrived_at'],l['arrived_at'],l['arrived_at'])))
 vv=[v for v in vv if v['id']!=cid];assert len(vv)==1;return dict(vv[0])
checks=collections.Counter();examples=[];backward={};lastTrack={}
for arm in ['current','canonical']:
 backward[arm]=[]
 groups=iter(itertools.groupby(map(json.loads,(O/'connected-pairs.jsonl').open()),key=lambda r:r['poll']))
 pending=next(groups,None)
 for line in gzip.open(O/(arm+'-wire.jsonl.gz'),'rt'):
  f=json.loads(line)
  for key,t in f['tracking'].items():
   prev=lastTrack.get((arm,key));N=len(top[t[0]])
   if prev and f['at']-prev[0]<=15000 and (t[1]-prev[1])%N>N/2:backward[arm].append([f['at'],key,prev[1],t[1]])
   lastTrack[(arm,key)]=(f['at'],t[1])
  if pending is None:continue
  if f['i']!=pending[0]:continue
  wanted=list(pending[1]);byVehicle=collections.defaultdict(list)
  for r in f['wire']['rows']:byVehicle[r[0]].append(r)
  keyed={};first={}
  for bi,rs in byVehicle.items():
   bus,label=f['wire']['buses'][bi][:2];route=labels[label];seq=top[route];N=len(seq);origins=set(range(N))
   for r in rs:origins&={(j-r[5])%N for j,s in enumerate(seq) if s==r[1]}
   assert len(origins)==1;origin=next(iter(origins));positions=collections.defaultdict(list)
   for r in rs:positions[(origin+r[5])%N].append(r)
   for idx,rows in positions.items():
    rows=sorted(rows,key=lambda r:r[5]);first[(route,bus,idx)]=rows[0][5]
    for occ,r in enumerate(rows):keyed[(route,bus,idx,occ)]=r
  for r in wanted:
   key=(r['route'],r['bus'],r['targetIndex'],r['occurrence']);wire=keyed[key];assert r['at']==f['at'];assert wire[2:6]==r[arm]
   s=visit(r['sourceId']);N=len(top[r['route']]);same=s['stop_index']==r['targetIndex'];h=first[key[:3]]
   if same:
    assert h==0 or h>=N,(key,h)
    expected=(0 if h==0 else N)+r['occurrence']*N;checks[arm+':sameSourceZero' if h==0 else arm+':sameSourceFuture']+=1
   else:expected=(r['targetIndex']-s['stop_index'])%N+r['occurrence']*N
   actual=sum(leg(i)['hops'] for i in r['legIds']);assert actual==expected,(r,actual,expected);checks[arm+':wireAndCumulativeOccurrence']+=1
   assert s['anchored_at']<=r['at'];assert visit(r['targetId'])['stop_index']==(s['stop_index']+actual)%N
   if r['sourceId']==59329 and r['poll']==3870 and r['targetIndex']==18:examples.append({'arm':arm,'targetId':r['targetId'],'occurrence':r['occurrence'],'physicalHops':actual,'firstWireHops':h,'truthSec':r['truthSec']})
  pending=next(groups,None)
 assert pending is None
# Every complete rider outcome must traverse the exact selected physical ride.
rider=collections.Counter()
for arm in ['current','canonical']:
 for line in (O/(arm+'-rider-outcomes.jsonl')).open():
  r=json.loads(line);rider[arm+':options']+=1
  if r['status']!='connected':continue
  cur=visit(r['boardVisitId']);target=visit(r['targetVisitId']);route=r['route'];N=len(top[route]);total=0
  assert cur['stop_id']==r['boardStop'] and target['stop_id']==r['targetStop'];assert cur['bus_name'].lstrip('#')==target['bus_name'].lstrip('#')==r['bus']
  for i,lid in enumerate(r['legIds']):
   l=leg(lid);assert l['route_id']==route and l['bus_name'].lstrip('#')==r['bus'];assert l['from_index']==cur['stop_index'] and l['departed_at']==cur['departed_at'] and l['reached']==1;assert (l['to_index']-l['from_index'])%N==l['hops'];total+=l['hops']
   cur=next_visit(cur['id'],lid);rider[arm+':legUses']+=1
  assert cur['id']==target['id'] and total==r['destinationForecastHops']-r['pickupForecastHops']
  arrival=target['arrived_at'] if target['arrived_at'] is not None else target['departed_at'];assert arrival==r['targetArrivalAt'];assert abs(r['arrivalPlusModeledEgressSec']-((arrival-r['at'])/1000+r['walkFromSec']))<1e-9
  rider[arm+':connected']+=1
assert backward['current']==backward['canonical']
result={'backwardNumericalLeadEvents':backward,'sameBackwardEventIdentities':True,'rawWireAndPhysicalOccurrenceChecks':checks,'correctedExample':examples,'riderDatabaseChecks':rider,'limits':'Independent cumulative-hop/actual wire verification, not an observed boarding proof. Unresolved source identities and incomplete chains are preserved.'};(O/'semantic-verification.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result,indent=2));db.close()
