from pathlib import Path
import json,hashlib,sqlite3,collections,subprocess,math
O=Path(__file__).resolve().parent;A=Path('/home/gwarren/projects/yale-shuttle-watcher');plan=json.loads((O/'PLAN.json').read_text())
for p,h in plan['inputHashes'].items():assert hashlib.sha256(Path(p).read_bytes()).hexdigest()==h,p
assert subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip()==plan['base']
for args in [['git','diff','--exit-code'],['git','diff','--cached','--exit-code'],['git','diff','--check']]:subprocess.run(args,check=True)
old={ (r['at'],r['bus'],r['target'],r['stopsAhead']):r['candidate'] for r in map(json.loads,(A/'release-integration-data/final-pairs.jsonl').open())}
matched=0;diff=[]
for r in map(json.loads,(O/'current.jsonl').open()):
 k=r['at'],r['bus'],r['target'],r['stopsAhead'];a={c:max(0,v) for c,v in r['forecast'].items()};b=old.get(k)
 if a==b:matched+=1
 else:diff.append({'key':k,'current':a,'oldReleaseOn':b})
# Baseline equivalence checks the actual current runtime on the same Red history.
assert not diff,('Current Red baseline drifted from prior release ON',diff[:1])
db=sqlite3.connect('file:'+str(A/'release-integration-data/outcomes-complete.db')+'?mode=ro',uri=True);db.row_factory=sqlite3.Row
seq=json.loads(db.execute('select stops_json from routes where id=3').fetchone()[0]);N=len(seq)
legChecks=0;journeyChecks=0;checkpointChecks=0;sourceCoverage=collections.Counter();metrics={};largest=[]
def metric(rs,arm):
 e=[abs(r[arm]['eta']-r['truthSec']) for r in rs];n=len(e)
 return {'n':n,'sources':len({r['sourceId'] for r in rs}),'targets':len({r.get('targetVisitId',r.get('nextTargetId')) for r in rs}),'MAE':sum(e)/n,'meanWidth':sum(r[arm]['high']-r[arm]['low'] for r in rs)/n,'WIS':sum((.5*abs(r[arm]['eta']-r['truthSec'])+.1*(r[arm]['high']-r[arm]['low'])+max(0,r[arm]['low']-r['truthSec'])+max(0,r['truthSec']-r[arm]['high']))/1.5 for r in rs)/n,'early':sum(r['truthSec']<r[arm]['low'] for r in rs),'late':sum(r['truthSec']>r[arm]['high'] for r in rs)}
for name in ['full-development-score','full-reused-afternoon-score','full-next-occurrence-review']:
 x=json.loads((O/(name+'.json')).read_text());second='next-occurrence' in name
 for j in x['journeys']:
  s=dict(db.execute('select * from stop_visits where id=?',(j['sourceId'],)).fetchone());targetId=j['nextTargetId'] if second else j['targetVisitId'];v=dict(db.execute('select * from stop_visits where id=?',(targetId,)).fetchone());assert s['route_id']==v['route_id']==3 and s['bus_name']==v['bus_name'];idx=s['stop_index'];dep=s['departed_at'];hops=0
  for lid in j['legIds']:
   l=dict(db.execute('select * from legs where id=?',(lid,)).fetchone());assert l['route_id']==3 and l['bus_name']==s['bus_name'] and l['from_index']==idx and l['departed_at']==dep and l['reached']==1
   assert l['from_stop_id']==seq[idx] and l['to_stop_id']==seq[l['to_index']] and (l['to_index']-idx)%N==l['hops']
   vs=list(db.execute("select * from stop_visits where route_id=3 and bus_name=? and stop_id=? and stop_index=? and anchored_at between ? and ? and (arrived_at=? or (outcome='passed' and departed_at=?))",(s['bus_name'],l['to_stop_id'],l['to_index'],s['anchored_at'],l['arrived_at'],l['arrived_at'],l['arrived_at'])))
   assert len(vs)==1;iv=vs[0];assert iv['how']!='gap';idx=l['to_index'];dep=iv['departed_at'];hops+=l['hops'];legChecks+=1
  assert iv['id']==v['id'];assert hops==(seq.index(j['target'])-s['stop_index'])%N+(N if second else 0);journeyChecks+=1
 rs=[r for r in x['checkpoints'] if r.get('baseline') and r.get('candidate')]
 for r in rs:
  v=db.execute('select arrived_at from stop_visits where id=?',(r['nextTargetId'] if second else r['targetVisitId'],)).fetchone();assert abs(r['truthSec']-(v[0]-r['at'])/1000)<1e-10;checkpointChecks+=1;sourceCoverage[r['sourceId']]+=1
 metrics[name]={a:metric(rs,a) for a in ['baseline','candidate']}
 for r in rs:
  largest.append({'cohort':name,'sourceId':r['sourceId'],'targetId':r['nextTargetId'] if second else r['targetVisitId'],'target':r['target'],'at':r['at'],'phase':r['phase'],'checkpointSec':r['checkpointSec'],'truthSec':r['truthSec'],'baseline':r['baseline'],'candidate':r['candidate'],'absErrorIncrease':abs(r['candidate']['eta']-r['truthSec'])-abs(r['baseline']['eta']-r['truthSec'])})
prior=[64318,58224,65347,48550,67957,68304,51469,54002,52633,52168,54777,53429]
priorStatus=[]
for sid in prior:
 v=db.execute('select id,bus_name,stop_id,pinned_at,departed_at,outcome,how from stop_visits where id=?',(sid,)).fetchone();priorStatus.append({'source':sid,'record':dict(v) if v else None,'scoredCheckpoints':sourceCoverage[sid],'status':'scored and retained' if sourceCoverage[sid] else 'outside scored replay or no eligible chain; prior audit remains, not newly validated'})
# Preserve prior decision evidence and exact recorded legitimate regression.
p=A/'overnight-2026-09-17/eta/cycle-12/alternative-summary.json';assert p.exists()
result={'inputHashesVerified':len(plan['inputHashes']),'currentBaselineExactArchivedReleaseOnRows':matched,'connectedJourneysVerified':journeyChecks,'legUsesVerified':legChecks,'checkpointTruthsVerified':checkpointChecks,'metrics':metrics,'priorLegitimateCases':priorStatus,'largestRegressions':sorted(largest,key=lambda r:r['absErrorIncrease'],reverse=True)[:15]}
(O/'verification.json').write_text(json.dumps(result,indent=2)+'\n');db.close();print(json.dumps({k:v for k,v in result.items() if k not in ['largestRegressions','priorLegitimateCases']},indent=2))
