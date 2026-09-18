"""Exact candidate/source and read-only connected-outcome audit, reviewer outputs only."""
from pathlib import Path
import collections,gzip,hashlib,json,sqlite3,statistics,subprocess
O=Path(__file__).resolve().parent;S=O.parent/'cycle-6';B=O.parent/'cycle-5/traversal-guard';C=O.parent/'cycle-7'
root=Path('/home/gwarren/projects/yale-shuttle-watcher/overnight-eta-2026-09-17')
read=lambda p:json.loads(p.read_text())
git=lambda *a:subprocess.check_output(['git',*a],cwd=root)
head='53b4076b6273deb6f4e2ad436420461a0e5174f4'
base='373505d5076f21a08de69d9587be9b2a55956642'
assert git('rev-parse','HEAD').decode().strip()==head
assert git('merge-base',base,head).decode().strip()==base
assert git('diff')==b'' and git('diff','--cached')==b''
assert git('ls-files','--unmerged')==b''
assert git('diff',base,head)==(O.parent/'cycle-9/proposal.patch').read_bytes()
expected_eta={'docs/red-current-release.md','docs/server-side-eta.md','services/shuttle-v2/web/src/TransitMap.tsx','services/shuttle-v2/web/src/atStopJourney.test.ts','services/shuttle-v2/web/src/eta/index.ts','services/shuttle-v2/web/src/eta/releaseSmoothing.test.ts','services/shuttle-v2/web/src/journeyArrival.ts'}
assert set(git('diff','--name-only',base,head).decode().splitlines())==expected_eta
# The carried smoothing repair must exactly equal its previously reviewed diff.
smoothing=['docs/red-current-release.md','services/shuttle-v2/web/src/eta/index.ts','services/shuttle-v2/web/src/eta/releaseSmoothing.test.ts']
prior='b574a1c800654544685a8d9f1097ad3484ac13fc'
assert git('diff',base,head,'--',*smoothing)==git('diff',prior+'^',prior,'--',*smoothing)
f='services/shuttle-v2/web/src/TransitMap.tsx';src=(root/f).read_text()
ours=git('show','0d0f34fa87f7d051d4c4419f04c83db13c0d4c72:'+f).decode()
theirs=git('show',base+':'+f).decode()
def numerical(text):
 a=text.index('    return stableOptions.map((o) => {',text.index('const options: TripOption[] | null'))
 b=text.index('\n    // eslint-disable-next-line',a)
 return text[a:b]
block=numerical(src)
assert block==numerical(ours)
expected=theirs.replace('import { journeyArrival } from "./journeyArrival";', 'import { atStopJourneyBoard, journeyArrival } from "./journeyArrival";')
expected=expected.replace(numerical(theirs),block)
assert src==expected
assert hashlib.sha256(block.encode()).hexdigest()==read(O/'source-extraction.json')['block_sha256']
assert block in (O/'shell-candidate.generated.mts').read_text()
for p in expected_eta:
 assert (root/p).read_bytes()==git('show',head+':'+p)
 assert hashlib.sha256((root/p).read_bytes()).hexdigest()==read(O.parent/'cycle-9/source-hashes.json')[p]
source_hashes={p:hashlib.sha256((root/p).read_bytes()).hexdigest() for p in sorted(expected_eta)}
(O/'source-hashes.json').write_text(json.dumps(source_hashes,indent=2)+'\n')
records={a:{(r['session'],r['at']):r for r in map(json.loads,(S/(a+'-decisions.jsonl')).open())} for a in ['baseline','ordered']}
current=list(map(json.loads,(O/'candidate-decisions.jsonl').open()))
assert len(current)==len(records['baseline'])==len(records['ordered'])==4688
for r in current:
 saved=records['ordered'][r['session'],r['at']]
 for k in ['option','trace','order']:assert saved[k]==r[k]
 r['changed']=saved['changed']
 records['ordered'][r['session'],r['at']]=r
frames={r['at']:r for r in map(json.loads,gzip.open(B/'fleet-wire.jsonl.gz','rt'))}
cases=read(S/'missing-cases.json'); states=read(S/'observed-states.json');obs={(r['at'],r['bus']):r for r in states['states']}
assert (states['frames'],states['matched'],states['rows'])==(11081,1172,160496)
assert len(obs)==34 and all(not r['leadSituation']['standing'] for r in obs.values())
db=sqlite3.connect('file:/home/gwarren/projects/yale-shuttle-watcher/conditional-replay-data/outcomes.db?mode=ro',uri=True);db.row_factory=sqlite3.Row
visits={r['id']:dict(r) for r in db.execute('select * from stop_visits where route_id=3')}
legs={r['id']:dict(r) for r in db.execute('select * from legs where route_id=3')}
seq=json.loads(db.execute('select stops_json from routes where id=3').fetchone()[0]);n=len(seq)
by_arrival=collections.defaultdict(list)
for v in visits.values():
 for t in {v['arrived_at'], *([v['departed_at']] if v['outcome']=='passed' else [])}:
  by_arrival[v['bus_name'],v['stop_index'],t].append(v)
connected_uses=0
def chain(source,target,ids):
 global connected_uses
 cur=visits[source]; dest=visits[target];hops=0
 for i,lid in enumerate(ids):
  leg=legs[lid]
  assert (leg['bus_name'],leg['from_stop_id'],leg['from_index'],leg['departed_at'])==(cur['bus_name'],cur['stop_id'],cur['stop_index'],cur['departed_at'])
  assert leg['hops']>0 and (leg['from_index']+leg['hops'])%n==leg['to_index']
  assert seq[leg['to_index']]==leg['to_stop_id']
  assert all(seq[(leg['from_index']+h)%n]!=dest['stop_id'] for h in range(1,leg['hops'])), 'skipped first endpoint'
  choices=by_arrival[leg['bus_name'],leg['to_index'],leg['arrived_at']]
  assert len(choices)==1
  cur=choices[0];hops+=leg['hops'];connected_uses+=1
  if i<len(ids)-1:assert cur['stop_id']!=dest['stop_id']
 assert cur['id']==target
 return hops
counts=collections.Counter()
for c in cases:
 key=(c['session'],c['at']);r=records['baseline'][key];option=r['option'];f=frames[c['at']]
 assert not option.get('journeyArrival') and option['walkToSec']==0
 raw=c['causal']['rawBus'];source=visits[c['sourceId']];label=c['retrospective']
 rows=db.execute('select * from raw_positions where bus_name=? and collected_at=?',(raw['bus_name'],c['at'])).fetchall();assert len(rows)==1
 assert all(rows[0][k]==raw[k] for k in ['lat','lon','heading','route_id'])
 assert raw['bus_name']==source['bus_name'] and raw['at_stop_id']==source['stop_id']==option['boardStopId']
 wi=next(i for i,b in enumerate(f['server_eta']['buses']) if b[0]==c['bus'])
 for field,stop in [('pickupRows',source['stop_id']),('destinationRows',option['alightStopId'])]:
  saved=c['causal'][field]
  wire=sorted([(r,i) for i,r in enumerate(f['server_eta']['rows']) if r[0]==wi and r[1]==stop],key=lambda x:x[0][5])
  assert len(saved)==len(wire)
  for x,(w,j) in zip(saved,wire):
   assert (x['stopId'],x['eta'],x['low'],x['high'],x['hops'])==(w[1],w[2],max(0,w[3]),max(0,w[4]),w[5])
   assert x['distribution']==f['server_eta']['distributions'][j]
 h=c['causal']['pickupRows'][0]['hops'];post=c['at']>source['departed_at']
 assert post==label['afterRecordedDeparture']
 assert label['sourceDepartedAt']==source['departed_at']
 assert chain(c['sourceId'],label['targetVisit'],label['legIds'])==label['routeHops']
 assert visits[label['targetVisit']]['arrived_at']==label['targetArrivedAt']
 assert c['causal']['destinationRows'][0]['hops']==label['routeHops']+(1 if h==1 else 0)
 assert (c['at'],c['bus']) in obs
 counts[h,post]+=1
assert counts=={(1,False):30,(29,False):24,(29,True):14}
labels=read(B/'outcome-audit.json')['scores'];recomputed=[]
for label in labels:
 key=label['session'],label['at'];one=records['baseline'][key];two=records['ordered'][key]
 o0,o1=one['option'],two['option'];source=visits[label['sourceId']];target=visits[label['targetVisit']]
 chain(source['id'],target['id'],label['legIds'])
 assert source['stop_id']==o0['boardStopId'] and target['stop_id']==o0['alightStopId']
 assert source['bus_name'].lstrip('#')==o0['busName']==o1['busName']==label['bus']
 assert label['at']+o0['walkToSec']*1000<=source['departed_at']
 truth=(target['arrived_at']-label['at'])/1000+o0['walkFromSec']
 assert abs(truth-label['actualConnectedSec'])<1e-9
 e0=o0['totalSec']-truth;e1=o1['totalSec']-truth
 recomputed.append(dict(source=source['id'],target=target['id'],at=label['at'],changed=two['changed'],e0=e0,e1=e1))
changed=[r for r in recomputed if r['changed']];assert len(changed)==30 and len(recomputed)==1400
assert all(r['e0']==r['e1'] for r in recomputed if not r['changed'])
for key,r in records['ordered'].items():
 old=records['baseline'][key]
 if not r['changed']:assert r['option']==old['option'];continue
 j=r['option']['journeyArrival'];trace=next(t for t in r['trace'] if t['kind']=='journey')
 board,dest=trace['board'],trace['destination']
 assert board['stopsAhead']==1<dest['stopsAhead'] and board['busName']==dest['busName']==j['busName']
 assert j['distributionMs']==[r['at']+1000*(x+r['option']['walkFromSec']) for x in dest['distribution']]
 assert not old['option'].get('journeyArrival')
for mode in ['baseline','ordered']:
 errors=[r['e0' if mode=='baseline' else 'e1'] for r in changed]
 assert statistics.mean(map(abs,errors))==read(S/'counterfactual-scores.json')['pairedChanged'][mode]['mae']
reg=max(changed,key=lambda r:abs(r['e1'])-abs(r['e0']))
assert reg['source']==63523 and reg['target']==63632
assert abs(abs(reg['e1'])-abs(reg['e0'])-442.82701916224846)<1e-9
assert all(records['baseline'][k]['option']==r['option'] for k,r in records['ordered'].items() if k[0].endswith(':150'))

for p,h in read(O/'builder-hashes.json').items():assert hashlib.sha256((O.parent/p).read_bytes()).hexdigest()==h,p
db.close()
result=dict(head=head,base=base,priorSmoothingUntouched=True,exactCombinedSource=True,numericalBlockUnchangedFromHead=True,sourceHashes=source_hashes,prototypeDecisionsExact=len(current),missingCases=len(cases),connectedLegUses=connected_uses,connectedOutcomes=len(recomputed),changedOutcomes=len(changed),changedMAE=[statistics.mean(abs(r[k]) for r in changed) for k in ['e0','e1']],largestRetainedRegression=reg,priorArtifactCount=len(read(O/'builder-hashes.json')),priorArtifactsPreserved=True,scope='Selected reused Red history; no population coverage, fresh holdout, or walking-outcome claim.')
(O/'evidence.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result,indent=2))
