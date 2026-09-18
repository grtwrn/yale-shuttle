from pathlib import Path
import json,sqlite3,gzip,collections,itertools
from functools import lru_cache
O=Path(__file__).resolve().parent;T=O.parent;B=T/'cycle-15'
db=sqlite3.connect('file:/home/gwarren/projects/yale-shuttle-watcher/release-integration-data/outcomes-complete.db?mode=ro',uri=True);db.row_factory=sqlite3.Row
meta=json.loads((O/'current-meta.json').read_text());top={int(k):v['stops'] for k,v in meta['routeMeta'].items()}
@lru_cache(None)
def visit(i):return dict(db.execute('select * from stop_visits where id=?',(i,)).fetchone())
@lru_cache(None)
def leg(i):return dict(db.execute('select * from legs where id=?',(i,)).fetchone())
@lru_cache(None)
def path(sourceId,legIds):
 cur=visit(sourceId);hops=0
 for lid in legIds:
  l=leg(lid);N=len(top[l['route_id']]);assert cur['how']!='gap' and cur['departed_at']==l['departed_at'];assert cur['stop_index']==l['from_index'];assert cur['route_id']==l['route_id'] and cur['bus_name']==l['bus_name'];assert l['reached'] and l['hops']==(l['to_index']-l['from_index'])%N>0
  vs=list(db.execute("select * from stop_visits where route_id=? and bus_name=? and stop_index=? and anchored_at between ? and ? and (how is null or how!='gap') and (arrived_at=? or (arrived_at is null and outcome='passed' and departed_at=?))",(l['route_id'],l['bus_name'],l['to_index'],cur['anchored_at'],l['arrived_at'],l['arrived_at'],l['arrived_at'])))
  vs=[v for v in vs if v['id']!=cur['id']];assert len(vs)==1;cur=dict(vs[0]);hops+=l['hops']
 return cur,hops

def key(r):return (r['poll'],r['route'],r['bus'],r['targetIndex'],r['occurrence'])
records=list(map(json.loads,(O/'lagged-origin-records.jsonl').open()));mapped={key(r):r for r in records};assert len(mapped)==len(records)
counts=collections.Counter();proofPairs=set();priorIds=set();rowsByArm={}
for arm in ['current','canonical']:
 groups=iter(itertools.groupby(records,key=lambda r:r['poll']));pending=next(groups,None)
 for line in gzip.open(O/(arm+'-wire.jsonl.gz'),'rt'):
  f=json.loads(line)
  if pending is None or f['i']!=pending[0]:continue
  for r in list(pending[1]):
   a=r['alignment'];s=visit(r['sourceId']);later=visit(r['historicalSourceId']);route=r['route'];bus=r['bus'];seq=top[route];N=len(seq);label=meta['routeMeta'][str(route)]['label'];track=f['tracking'][label+'|'+bus]
   assert s['id']==a['pricedSourceId'] and later['id']==a['historicalSourceId'];assert track[2] and track[3]==s['stop_index'] and track[4]==s['pinned_at'];assert s['anchored_at']<later['anchored_at']<=r['at'];assert s['departed_at']<=later['anchored_at']
   matches=list(db.execute('select id from stop_visits where route_id=? and bus_name=? and stop_index=? and pinned_at=?',(route,s['bus_name'],s['stop_index'],s['pinned_at'])));assert [x['id'] for x in matches]==[s['id']]
   latest=db.execute('select id from stop_visits where route_id=? and bus_name=? and anchored_at<=? order by anchored_at desc,id desc limit 1',(route,s['bus_name'],r['at'])).fetchone();assert latest['id']==later['id']
   end,distance=path(s['id'],tuple(a['proofLegIds']));assert end['id']==later['id'] and distance==a['sourceOffsetHops']
   bi=next(i for i,b in enumerate(f['wire']['buses']) if b[:2]==[bus,label]);rows=[w for w in f['wire']['rows'] if w[0]==bi];origins=[i for i in range(N) if all(seq[(i+w[5])%N]==w[1] for w in rows)];assert origins==[s['stop_index']]
   targets=sorted([w for w in rows if (origins[0]+w[5])%N==r['targetIndex']],key=lambda w:w[5]);w=targets[r['occurrence']];assert w[2:6]==r[arm]
   if r['targetId'] is not None:
    target,hops=path(s['id'],tuple(r['legIds']));assert target['id']==r['targetId'] and target['stop_index']==r['targetIndex'];assert hops==w[5]
    arrival=target['arrived_at'] if target['arrived_at'] is not None else target['departed_at'];assert r['truthSec']==(arrival-r['at'])/1000
    counts[arm+':resolved']+=1
   else:counts[arm+':unresolved']+=1
   counts[arm+':wireChecked']+=1;counts[arm+':zeroHop' if w[5]==0 else arm+':nonzeroHop']+=1;proofPairs.add((r['poll'],s['id'],later['id']));priorIds.add(s['id'])
  pending=next(groups,None)
 assert pending is None
# Explicit acceptance for each independent reviewer case, including previously
# mislabeled current and following occurrences. This is a new gate, not a rerun
# or modification of the reviewer's intentionally failing original script.
review=json.loads((T/'review-round-14/lagged-origin-audit.json').read_text());accepted=[]
for c in review['cases']:
 old=c['score'];new=mapped[key(old)];assert new['targetId']==c['priorRest']['id'];assert new['truthSec']==c['priorArrivalRelativeSec']<0;accepted.append({'arm':c['arm'],'key':key(old),'oldTarget':old['targetId'],'correctTarget':new['targetId']})
followers=json.loads((T/'review-round-14/lagged-following-audit.json').read_text())
for c in followers['followingRows']:
 old=c['followingOccurrence'];new=mapped[key(old)];assert new['targetId']==c['expectedFollowingTargetId'];counts['reviewFollowingCases']+=1
assert len(accepted)==22 and counts['reviewFollowingCases']==8
# Preserve all raw tail changes and report changes to truth separately.
oldT={key(r):r for r in map(json.loads,(B/'large-tail-changes.jsonl').open())};newT={key(r):r for r in map(json.loads,(O/'large-tail-changes.jsonl').open())};assert oldT.keys()==newT.keys()
for k,r in oldT.items():
 for field in ['current','canonical','maxBandDelta']:assert r[field]==newT[k][field]
counts['rawLargeTailChangesPreserved']=len(oldT)
result={'counts':counts,'alignedBusPolls':len(proofPairs),'priorVisits':len(priorIds),'reviewCurrentCases':accepted,'limitations':'Only exact prior-rest identities are established here. Other source alignment remains provisional; no missing case is reclassified using its residual. Original forecasts, outcomes and independent reviewer evidence stay unchanged.'}
(O/'alignment-verification.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps({k:v for k,v in result.items() if k!='reviewCurrentCases'},indent=2));db.close()
