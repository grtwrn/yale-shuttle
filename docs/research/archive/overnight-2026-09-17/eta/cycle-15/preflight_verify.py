from pathlib import Path
import json,sqlite3,collections,hashlib,subprocess
from functools import lru_cache
O=Path(__file__).resolve().parent;A=O.parents[2];db=sqlite3.connect('file:'+str(A/'release-integration-data/outcomes-complete.db')+'?mode=ro',uri=True);db.row_factory=sqlite3.Row
plan=json.loads((O/'PLAN.json').read_text());assert subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip()==plan['base']
for p,h in plan['inputHashes'].items():assert hashlib.sha256(Path(p).read_bytes()).hexdigest()==h,p
meta=json.loads((O/'current-meta.json').read_text());top={int(k):v['stops'] for k,v in meta['routeMeta'].items()};expected={r['id']:r['repairedStops'] for r in json.loads((O.parent/'cycle-14/all-route-topology.json').read_text())}
assert all(s==expected[r] for r,s in top.items())
@lru_cache(None)
def getv(i):return dict(db.execute('select * from stop_visits where id=?',(i,)).fetchone())
@lru_cache(None)
def getl(i):return dict(db.execute('select * from legs where id=?',(i,)).fetchone())
@lru_cache(None)
def successors(route,bus,idx,anchored,arrived):
 return list(db.execute("select * from stop_visits where route_id=? and bus_name=? and stop_index=? and anchored_at>=? and anchored_at<=? and how!='gap' and (arrived_at=? or (arrived_at is null and outcome='passed' and departed_at=?))",(route,bus,idx,anchored,arrived,arrived,arrived)))
checked=set();sources=set();targets=set();rows=0;legUses=0;totals=collections.Counter();tails=0
for line in (O/'preflight-connected-pairs.jsonl').open():
 r=json.loads(line);s,t=getv(r['sourceId']),getv(r['targetId']);assert s['route_id']==t['route_id']==r['route'] and s['bus_name'].lstrip('#')==t['bus_name'].lstrip('#')==r['bus'];assert t['stop_index']==r['targetIndex'] and t['stop_id']==r['targetStop'];arrival=t['arrived_at'] if t['arrived_at'] is not None else t['departed_at'];assert abs(r['truthSec']-(arrival-r['at'])/1000)<1e-9
 k=(s['id'],t['id'],tuple(r['legIds']))
 if k not in checked:
  cur=s;seq=top[r['route']]
  for lid in r['legIds']:
   l=getl(lid);assert l['route_id']==r['route'] and l['bus_name']==s['bus_name'] and l['departed_at']==cur['departed_at'] and l['from_index']==cur['stop_index'];assert l['from_stop_id']==seq[l['from_index']] and l['to_stop_id']==seq[l['to_index']] and l['reached']==1;assert (l['to_index']-l['from_index'])%len(seq)==l['hops'];vv=successors(r['route'],s['bus_name'],l['to_index'],cur['anchored_at'],l['arrived_at']);assert len(vv)==1;cur=dict(vv[0]);legUses+=1
  assert cur['id']==t['id'];checked.add(k)
 for arm in ['current','canonical']:
  eta,low,high,_=r[arm];eta,low,high=max(0,eta),max(0,low),max(0,high);ae=abs(eta-r['truthSec']);totals[arm+'AE']+=ae;totals[arm+'early']+=r['truthSec']<low;totals[arm+'late']+=r['truthSec']>high
 rows+=1;sources.add(s['id']);targets.add(t['id'])
score=json.loads((O/'preflight-score.json').read_text());assert rows==score['counts']['scored']
for arm in ['current','canonical']:
 assert abs(totals[arm+'AE']/rows-score['metrics']['all'][arm]['MAE'])<1e-7
 for t in ['early','late']:assert totals[arm+t]==score['metrics']['all'][arm][t]
for line in (O/'preflight-large-tail-changes.jsonl').open():
 r=json.loads(line);assert r['maxBandDelta']==max(abs(r['current'][j]-r['canonical'][j]) for j in range(3))>60;tails+=1
assert tails==score['counts'].get('largeBandChanges',0);db.close()
result={'hashesVerified':len(plan['inputHashes']),'allActualRingSequencesMatchRepairedDatabaseTopology':True,'scoredTruths':rows,'connectedChains':len(checked),'connectedLegUses':legUses,'sources':len(sources),'targets':len(targets),'largeTailChangesRetained':tails,'sameCurrentHead':plan['base']};(O/'preflight-verification.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result,indent=2))
