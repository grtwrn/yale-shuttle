"""Independent provenance verification; does not import audit_receipts.py."""
from pathlib import Path
from collections import defaultdict, Counter
import json,datetime,hashlib,sqlite3,subprocess
O=Path(__file__).resolve().parent; P=O.parent; R=P.parents[1]
load=lambda p:json.loads(p.read_text())
stamp=lambda s:round(datetime.datetime.fromisoformat(s.replace('Z','+00:00')).replace(tzinfo=datetime.timezone.utc).timestamp()*1000)
def digest(p):
 h=hashlib.sha256()
 with p.open('rb') as f:
  for chunk in iter(lambda:f.read(1024*1024),b''):h.update(chunk)
 return h.hexdigest()
plan=load(O/'PLAN.json')
for fn,h in plan['inputs'].items():assert digest(Path(fn))==h,fn
rows=[json.loads(l) for l in (O/'sanitized-receipts.jsonl').open()];summary=load(O/'receipt-audit.json');ev=load(O/'case-evidence.json')
cases=[c for c in load(P/'cycle-6/missing-cases.json') if c['causal']['pickupRows'][0]['hops']==29];sources={c['sourceId']:c for c in cases}
assert {(r['session'],r['at']) for r in ev}=={(r['session'],r['at']) for r in cases}
assert len(rows)==summary['sanitizedSamples']==487 and len(ev)==38
keys=['observed_at','bus_id','bus_name','route_id','lat','lon','heading','last_stop_id','stationary','at_stop_id','at_stop_since','stationary_since','last_moved_at','lap']
original={}; clocks=defaultdict(list); selectedExpected=set()
for fn in plan['inputs']:
 if 'ongoing-rider-qa' not in fn:continue
 for n,l in enumerate(Path(fn).open(),1):
  x=json.loads(l);at=stamp(x['at']);clocks[Path(fn).parent.name].append(at)
  for sid,c in sources.items():
   if c['retrospective']['sourcePinnedAt']-60000<=at<=c['retrospective']['sourceDepartedAt']+90000:
    bb=[b for b in x['buses'] if b['bus_name']=='#'+c['bus']]
    if bb:
     assert len(bb)==1;selectedExpected.add((fn,n,sid));original[fn,n,sid]=(at,x['feedAgeMs'],{k:bb[0][k] for k in keys if k in bb[0]})
assert selectedExpected=={(r['file'],r['line'],r['sourceId']) for r in rows}
raw=[]
for l in (R/'conditional-replay-data/raw-frames.jsonl').open():
 x=json.loads(l);at=stamp(x['at'])
 for b in x['buses']:raw.append((at,b))
byname=defaultdict(list)
for at,b in raw:byname[b['bus_name']].append((at,b))
dbpath=R/'conditional-replay-data/outcomes.db'
assert digest(dbpath)==load(P/'cycle-12/alternative-summary.json')['databaseSHA256']
db=sqlite3.connect('file:'+str(dbpath)+'?mode=ro',uri=True);db.row_factory=sqlite3.Row
uses=0;exact=0;diffs=Counter()
for r in rows:
 at,age,b=original[r['file'],r['line'],r['sourceId']]
 assert r['bus']==b and r['sampledAt']==at and r['feedAgeMs']==age and r['receiptAt']==at-age
 assert set(r)=={'sourceId','stream','file','line','sampledAt','receiptAt','feedAgeMs','bus','matchMethod','candidates'}
 sid=r['sourceId'];c=sources[sid];lo=c['retrospective']['sourcePinnedAt']-180000;hi=c['retrospective']['sourceDepartedAt']+90000
 cand=[]
 for t,bb in byname[b['bus_name']]:
  if not lo<=t<=hi:continue
  if not all(b.get(k)==bb.get(k) for k in ['bus_id','bus_name','route_id','lat','lon','heading']):continue
  if 'observed_at' in b:
   if t!=b['observed_at']:continue
  elif not (r['receiptAt']-120000<=t<=r['receiptAt'] and b.get('last_moved_at')==bb.get('last_moved_at')):continue
  d={k:{'sample':b.get(k),'reconstructed':bb.get(k)} for k in keys if k!='observed_at' and b.get(k)!=bb.get(k)}
  cand.append({'collectedAt':t,'differences':d})
 assert r['candidates']==cand
 if 'observed_at' in b:
  assert len(cand)==1;exact+=1
  found=db.execute('select bus_id,route_id,lat,lon,heading,last_stop_id from raw_positions where bus_name=? and collected_at=?',(b['bus_name'],b['observed_at'])).fetchall()
  assert len(found)==1
  assert all(found[0][k]==b.get(k) for k in ['bus_id','route_id','lat','lon','heading','last_stop_id']);uses+=1
  diffs.update(cand[0]['differences'].keys())
db.close()
for c,e in zip(cases,ev):
 assert c['session']==e['session'] and c['at']==e['at']
 matches=[r for r in rows if r['sourceId']==c['sourceId'] and any(q['collectedAt']==c['at'] for q in r['candidates'])]
 assert len(matches)==len(e['supports'])
 assert e['exactObservedAt']==any(r['matchMethod']=='observed_at' for r in matches)
 assert e['uniqueCompatible']==any(len(r['candidates'])==1 for r in matches)
 assert e['ambiguousOnly']==(bool(matches) and not e['uniqueCompatible'])
for k,expected in [('exactObservedAt',0),('uniqueCompatible',8),('ambiguousOnly',14)]:assert sum(e[k] for e in ev)==summary['caseCoverage'][k]==expected
assert sum(not e['supports'] for e in ev)==16
old=load(P/'cycle-6/paired-outcomes.json');assert len(old)==1400 and max(r['absErrorIncreaseSec'] for r in old)==442.82701916224846
coverage=[]
for sid,c in sources.items():
 lo=c['retrospective']['sourcePinnedAt']-60000;hi=c['retrospective']['sourceDepartedAt']+90000
 streams={}
 for stream,ts in clocks.items():
  inside=[t for t in ts if lo<=t<=hi];before=max((t for t in ts if t<lo),default=None);after=min((t for t in ts if t>hi),default=None)
  streams[stream]=dict(anyBusSamplesInWindow=len(inside),previousSampleAt=before,nextSampleAt=after,enclosingGapSec=(after-before)/1000 if not inside and before and after else None)
 coverage.append(dict(sourceId=sid,streams=streams))
(O/'coverage-gaps.json').write_text(json.dumps(coverage,indent=2)+'\n')
repo=R/'overnight-eta-2026-09-17'
assert subprocess.check_output(['git','rev-parse','HEAD'],cwd=repo,text=True).strip()==plan['base']
assert subprocess.check_output(['git','status','--porcelain'],cwd=repo,text=True)==''
report=dict(originalSamplesVerified=len(rows),candidateSetsIndependentlyVerified=len(rows),exactCollectionDatabaseChecks=uses,exactCollectionFieldsOtherThanLapUnchanged=exact,exactCollectionDifferenceUses=dict(diffs),caseCoverage=summary['caseCoverage'],preservedDecisions=38,preservedOutcomes=1400,retainedRegressionSec=442.82701916224846,inputHashesVerified=len(plan['inputs']),checkoutClean=True,head=plan['base'])
(O/'verification.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report,indent=2))
