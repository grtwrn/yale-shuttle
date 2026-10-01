from pathlib import Path
import json,gzip,hashlib,subprocess,re,collections,statistics,math,sqlite3,itertools
O=Path(__file__).resolve().parent;B=O.parent/'cycle-5/traversal-guard';P=O.parent/'cycle-4';A=O.parents[2];R=Path('/home/gwarren/projects/yale-shuttle-watcher/overnight-eta-2026-09-17/services/shuttle-v2');BASE='6220b860a69f5567557926f41de59ed1af72d2f8';HEAD='b574a1c800654544685a8d9f1097ad3484ac13fc'
read=lambda p:json.loads(p.read_text())
assert subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip()==HEAD
assert subprocess.check_output(['git','rev-parse',HEAD+'^'],text=True).strip()==BASE
plan=read(B/'PLAN.json')
for p,h in plan['hashes'].items():assert hashlib.sha256(Path(p).read_bytes()).hexdigest()==h,p
assert hashlib.sha256((R/'web/src/eta/index.ts').read_bytes()).hexdigest()==plan['candidateIndexSha256']
assert (R/'web/src/eta/index.ts').read_bytes()==(B/'candidate-index-source.ts.txt').read_bytes()
files={'web/src/eta/index.ts':'baseline-index.generated.mts','web/src/arrivals.ts':'baseline-arrivals.generated.mts','src/server/serverEta.ts':'baseline-server.generated.mts'}
for rel,name in files.items():
 original=R/rel;s=subprocess.check_output(['git','show',BASE+':services/shuttle-v2/'+rel],text=True)
 def resolve(m):
  spec=m[2]
  if not spec.startswith('.'):return m[0]
  p=(original.parent/spec).resolve()
  if p.suffix=='.js':p=p.with_suffix('.ts')
  elif not p.suffix:p=p.with_suffix('.ts') if p.with_suffix('.ts').exists() else p/'index.ts'
  dest=B/files[str(p.relative_to(R))] if str(p.relative_to(R)) in files else p
  return m[1]+str(dest)+m[3]
 assert re.sub(r'''(from\s+["'])([^"']+)(["'])''',resolve,s)==(B/name).read_text(),rel
# Every transported row is paired by bus identity and hop count, independently of numeric sorting.
c=collections.Counter();stops=collections.Counter();endpoints=0
for a,b in itertools.zip_longest(map(json.loads,gzip.open(P/'fleet-wire.jsonl.gz','rt')),map(json.loads,gzip.open(B/'fleet-wire.jsonl.gz','rt'))):
 assert a and b and a['at']==b['at'] and a['buses']==b['buses'] and a['warmMs']==b['warmMs'];c['frames']+=1
 def wire(f):
  w=f['server_eta'];assert len(w['rows'])==len(w['distributions']);out={}
  assert w['at']==w['servedAt']==f['at']
  for row,q in zip(w['rows'],w['distributions']):
   key=(w['buses'][row[0]][0],row[1],row[5]);assert key not in out
   assert len(q)==50 and q==sorted(q) and all(math.isfinite(v) and v>=0 for v in q)
   assert row[3]<=row[2]<=row[4];out[key]=(row[1:],q)
  return out
 aw,bw=wire(a),wire(b);assert aw.keys()==bw.keys();assert sorted(a['server_eta']['buses'])==sorted(b['server_eta']['buses'])
 for k,(row,q) in bw.items():
  old=aw[k];c['rows']+=1;c['changed']+=old!=(row,q)
  assert row[6:]==old[0][6:]
  if k[2]==0:
   c['zero']+=1;assert row[1:4]==[0,0,0] and q==[0]*50
   if old[0][1]>0:c['fixed']+=1;stops[k[1]]+=1
  if k[1] in [48,4]:assert (row,q)==old;endpoints+=1
 for label,w in [('base',aw),('candidate',bw)]:
  groups=collections.defaultdict(list)
  for (bus,stop,h),(r,q) in w.items():groups[bus,stop].append((h,r[1]))
  for rs in groups.values():
   if len(rs)==2:c[label+'Pairs']+=1;rs.sort();assert rs[1][1]>=rs[0][1]
assert c==dict(frames=1172,rows=160496,changed=454,zero=1734,fixed=101,basePairs=61142,candidatePairs=61142),c
assert stops=={11:90,146:11}
# Full first/second endpoint forecast dictionaries equal, and baseline matches the old release-ON arm.
n=0
forecastKey=lambda r:tuple(r[k] for k in ['at','bus','target','stopsAhead'])
old={forecastKey(y):y for y in map(json.loads,(A/'release-integration-data/final-pairs.jsonl').open())};newkeys=set()
for x in map(json.loads,(B/'full-pairs.jsonl').open()):
 key=forecastKey(x);assert key not in newkeys;newkeys.add(key);y=old[key]
 assert x['baseline']==x['candidate']==y['candidate'];n+=1
assert newkeys==old.keys()
assert n==150020
comp=read(B/'comparison.json');assert all(x['baseline']==x['candidate'] for x in comp['checkpoints']);assert all(x['baseline']==x['candidate'] for x in comp['jumps'])
# Recount availability directly from all decisions, then exact matched-outcome identity and error.
loaddec=lambda p:{(d['session'],d['at']):d for d in map(json.loads,(p/'decisions.jsonl').open())}
da,db=loaddec(P),loaddec(B);assert da.keys()==db.keys();av=collections.Counter();mismatch=collections.Counter()
for k,a in da.items():
 b=db[k];ao=next(o for o in a['options'] if o['mode']=='shuttle');bo=next(o for o in b['options'] if o['mode']=='shuttle')
 av[bool(ao.get('journeyArrival')),bool(bo.get('journeyArrival'))]+=1
 for arm,opt in [('base',ao),('candidate',bo)]:mismatch[arm]+=bool(opt.get('journeyArrival') and opt['busName']!=opt['journeyArrival']['busName'])
assert av=={(True,True):4471,(False,True):149,(False,False):68},av
ident=lambda s:(s['session'],s['at'],s['sourceVisit'],s['targetVisit'],s['bus'])
am={ident(s):s for s in read(P/'outcome-audit.json')['scores']};bm={ident(s):s for s in read(B/'outcome-audit.json')['scores']};keys=am.keys()&bm.keys();assert len(keys)==1382
stable=0;errors=[[],[]];worst=None
for k in keys:
 a,b=am[k],bm[k];assert a['actualConnectedSec']==b['actualConnectedSec'] and a['legIds']==b['legIds']
 if a['journeyAvailable']:assert a['predictedSec']==b['predictedSec'];stable+=1
 delta=abs(b['errorSec'])-abs(a['errorSec']);errors[0].append(abs(a['errorSec']));errors[1].append(abs(b['errorSec']))
 if worst is None or delta>worst[0]:worst=(delta,k)
assert stable==1240 and len(am)==1420 and len(bm)==1400
# Independently follow exact saved leg IDs against read-only DB for every candidate matched decision.
con=sqlite3.connect('file:'+str(A/'conditional-replay-data/outcomes.db')+'?mode=ro',uri=True);con.row_factory=sqlite3.Row
visits={r['id']:dict(r) for r in con.execute('SELECT * FROM stop_visits WHERE route_id=3')};legs={r['id']:dict(r) for r in con.execute('SELECT * FROM legs WHERE route_id=3')};seq=json.loads(con.execute('SELECT stops_json FROM routes WHERE id=3').fetchone()[0]);con.close()
lookup=collections.defaultdict(list)
for v in visits.values():
 for t in set([v['arrived_at']]+([v['departed_at']] if v['outcome']=='passed' else [])):lookup[v['bus_name'],v['stop_id'],v['stop_index'],t].append(v)
leguses=0
for s in bm.values():
 source=visits[s['sourceVisit']];endpoint=visits[s['targetVisit']];d=db[s['session'],s['at']];opt=next(o for o in d['options'] if o['mode']=='shuttle')
 assert source['anchored_at']<=s['at']<=source['departed_at'] and source['bus_name'].lstrip('#')==s['bus']
 assert source['stop_id']==opt['boardStopId'] and endpoint['stop_id']==opt['alightStopId']
 dep=source['departed_at'];idx=source['stop_index'];hops=0
 for lid in s['legIds']:
  l=legs[lid];leguses+=1;assert l['departed_at']==dep and l['from_index']==idx and l['bus_name']==source['bus_name'] and l['reached']==1
  assert l['to_stop_id']==seq[l['to_index']] and (l['to_index']-idx)%len(seq)==l['hops'];hops+=l['hops']
  vs=[v for v in lookup[source['bus_name'],l['to_stop_id'],l['to_index'],l['arrived_at']] if source['anchored_at']<=v['anchored_at']<=l['arrived_at']];assert len(vs)==1
  v=vs[0];assert v['how']!='gap';dep=v['departed_at'];idx=v['stop_index']
 assert v['id']==endpoint['id'];assert hops==(endpoint['stop_index']-source['stop_index'])%len(seq)
 actual=(endpoint['arrived_at']-s['at'])/1000+opt['walkFromSec'];assert abs(actual-s['actualConnectedSec'])<1e-8 and abs(opt['totalSec']-actual-s['errorSec'])<1e-8
 j=opt.get('journeyArrival');assert s['earlyMiss']==bool(j and endpoint['arrived_at']+opt['walkFromSec']*1000<j['lowMs']);assert s['lateMiss']==bool(j and endpoint['arrived_at']+opt['walkFromSec']*1000>j['highMs'])
report=dict(head=HEAD,base=BASE,inputHashes=len(plan['hashes']),generatedBaselineFiles=3,wire=dict(c),fixedStops=dict(stops),allSelectedEndpointRowsUnchanged=endpoints,fullExactForecasts=n,selectedExactCheckpoints=len(comp['checkpoints']),selectedExactJumps=len(comp['jumps']),decisions=len(da),availability={str(k):v for k,v in av.items()},countdownJourneyMismatch=dict(mismatch),exactOutcomePairs=len(keys),unchangedExistingJourneys=stable,candidateOutcomes=len(bm),verifiedCandidateLegUses=leguses,pairedMAE=list(map(statistics.mean,errors)),largestErrorIncrease=worst,scope='Selected reused historical Red data and hypothetical walking; no prospective or calibrated accuracy claim.')
(O/'evidence.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report,indent=2))
