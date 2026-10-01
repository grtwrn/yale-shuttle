from pathlib import Path
import json, gzip, hashlib, sqlite3, collections, math
O=Path(__file__).resolve().parent; B=O.parent/'cycle-14'; A=O.parents[2]
def load(p):return json.loads(p.read_text())
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def rows(p):
 with p.open() as f:
  for s in f:yield json.loads(s)
# Fresh processes must actually reproduce the saved forecasts and tracking evidence.
identical=[]
for name in ['current.jsonl','canonical.jsonl','current-tracking.jsonl','canonical-tracking.jsonl','full-pairs.jsonl','negative-bounds.json','hop-changes.json','longitudinal.json','change-audit.json','all-large-tail-target-context.json','all-route-export-verification.json','all-route-red-input-comparison.json']:
 assert sha(O/name)==sha(B/name),name;identical.append(name)
for name in ['full-development-score.json','full-reused-afternoon-score.json','full-next-occurrence-review.json']:
 x,y=load(O/name),load(B/name);x.pop('input');y.pop('input');assert x==y,name
# Check raw physical occurrence matching independently of pair_score.py.
index={}; totals=collections.Counter(); changes=collections.Counter();large=[]
for r in rows(O/'current.jsonl'):
 h=r['stopsAhead'];k=(r['at'],r['bus'],r['target'],(h-1)//29)
 assert k not in index;index[k]=r;totals['first' if k[3]==0 else 'second']+=1
 totals['hEquals29']+=h==29;totals['currentNegativeLow']+=r['forecast']['low']<0
for b in rows(O/'canonical.jsonl'):
 k=(b['at'],b['bus'],b['target'],(b['stopsAhead']-1)//29);a=index[k];assert 'matched' not in a;a['matched']=True
 assert (a['observedAt'],a['warmMs'])==(b['observedAt'],b['warmMs']);totals['canonicalNegativeLow']+=b['forecast']['low']<0
 if a['stopsAhead']!=b['stopsAhead']:
  assert abs(a['stopsAhead']-b['stopsAhead'])==1;changes['oneHop']+=1
 delta=max(abs(a['forecast'][c]-b['forecast'][c]) for c in ['eta','low','high'])
 if delta>60:large.append({'key':k,'maxDelta':delta,'current':a['forecast'],'canonical':b['forecast']})
 a['canonical']=b
assert all(r.get('matched') for r in index.values());assert totals['first']==93380 and totals['second']==56640
assert changes['oneHop']==202 and len(large)==5
# Independently verify each scored arm is the correct raw physical forecast,
# then derive the truth and descriptive endpoint/date counts without using paired files.
db=sqlite3.connect('file:/home/gwarren/projects/yale-shuttle-watcher/release-integration-data/outcomes-complete.db?mode=ro',uri=True)
counts={};metrics={};checked=0
for name,occ in [('full-development-score',0),('full-reused-afternoon-score',0),('full-next-occurrence-review',1)]:
 x=load(O/(name+'.json'));events=[r for r in x['checkpoints'] if r.get('baseline') is not None and r.get('candidate') is not None]
 for r in events:
  k=(r['at'],'#'+r['bus'],r['target'],occ);raw=index[k]
  for arm,rawArm in [('baseline',raw),('candidate',raw['canonical'])]:
   assert r[arm]=={c:max(0,v) for c,v in rawArm['forecast'].items()},(name,k,arm)
  target=r.get('targetVisitId',r.get('nextTargetId'));truth=db.execute('select arrived_at,route_id,bus_name,stop_id from stop_visits where id=?',(target,)).fetchone()
  assert truth[1:]==(3,'#'+r['bus'],r['target']);assert abs(r['truthSec']-(truth[0]-r['at'])/1000)<1e-9;checked+=1
 counts[name]={'checkpoints':len(events),'sources':len({r['sourceId'] for r in events}),'targets':len({r.get('targetVisitId',r.get('nextTargetId')) for r in events}),'dates':dict(collections.Counter(r['day'] for r in events)),'outcomes':dict(collections.Counter(r['targetOutcome'] for r in events))}
 metrics[name]={}
 for arm in ['baseline','candidate']:
  metrics[name][arm]={'MAE':sum(abs(r[arm]['eta']-r['truthSec']) for r in events)/len(events),'early':sum(r['truthSec']<r[arm]['low'] for r in events),'late':sum(r['truthSec']>r[arm]['high'] for r in events)}
# Four out-of-window forecasts have nearby completed arrival proxies; never replace labels.
contexts=load(O/'all-large-tail-target-context.json');post=[]
for c in contexts:
 r=c['forecast'];past=[v for v in c['nearbyTargetVisits'] if v['arrivalRelativeSec'] is not None and -30<v['arrivalRelativeSec']<0]
 if past:post.append({'key':(r['at'],r['bus'],r['target'],r['hops']),'nearbyPriorTargets':[(v['id'],v['arrivalRelativeSec']) for v in past]})
assert len(post)==4
# Distinguish mutable-final-state evidence from actual poll-time snapshots.
fixture={}; temporal={}
for origin,label in [(B,'builder'),(O/'immutable','reviewerImmutable')]:
 fixture[label]={};temporal[label]={}
 for arm in ['current','canonical']:
  n=json.loads(gzip.decompress((origin/f'{arm}-fixture-normal.json.gz').read_bytes()))
  future=sum(e.get('belief',{}).get('seenAt',-math.inf)>r['at'] for r in n for _,e in r['entries'])
  temporal[label][arm]={'futureDatedEntries':future,'firstAndLastEntriesEqual':n[0]['entries']==n[-1]['entries']}
  if label=='reviewerImmutable':assert future==0 and n[0]['entries']!=n[-1]['entries']
  fixture[label][arm]={}
  for mode in ['reverse','restart10','restart20','restart30']:
   rr=json.loads(gzip.decompress((origin/f'{arm}-fixture-{mode}.json.gz').read_bytes()));cc=collections.Counter()
   for r in rr:
    z=n[r['i']];cc['polls']+=1
    cc['entryMatches']+=sorted(r['entries'])==sorted(z['entries']);cc['seenMatches']+=sorted(r['seen'])==sorted(z['seen'])
    def physical(w):
     return {(w['buses'][row[0]][1],w['buses'][row[0]][0],row[1],row[5]):(row[1:],w['distributions'][j]) for j,row in enumerate(w['rows'])}
    cc['wireMatches']+=physical(r['wire'])==physical(z['wire'])
    if label=='reviewerImmutable' and arm=='canonical':assert cc['entryMatches']==cc['seenMatches']==cc['wireMatches']==cc['polls']
   fixture[label][arm][mode]=dict(cc)
  if label=='reviewerImmutable':
   for mode in ['normal','reverse','restart10','restart20','restart30']:
    rr=json.loads(gzip.decompress((origin/f'{arm}-fixture-{mode}.json.gz').read_bytes()));old=json.loads(gzip.decompress((B/f'{arm}-fixture-{mode}.json.gz').read_bytes()))
    assert len(rr)==len(old) and all(a['wire']==b['wire'] for a,b in zip(rr,old)),(arm,mode,'wire changed by capture')
result={'byteIdenticalOutputs':identical,'scoreFilesEqualExceptInputPath':3,'rawCounts':dict(totals),'hopChanges':dict(changes),'checkpointRawForecastAndDBTruthChecks':checked,'checkpointCounts':counts,'metrics':metrics,'allLargeBandChanges':large,'postArrivalLabelRows':post,'temporalSnapshots':temporal,'fixture':fixture,'allImmutableWiresEqualOriginal':True}
(O/'independent-audit.json').write_text(json.dumps(result,indent=2)+'\n');db.close()
print(json.dumps({k:v for k,v in result.items() if k not in ['allLargeBandChanges','postArrivalLabelRows','fixture']},indent=2))
