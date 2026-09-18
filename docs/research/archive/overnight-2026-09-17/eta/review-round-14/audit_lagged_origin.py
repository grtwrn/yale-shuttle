from pathlib import Path
import json,gzip,sqlite3,collections,bisect
O=Path(__file__).resolve().parent;B=O.parent/'cycle-15'
db=sqlite3.connect('file:/home/gwarren/projects/yale-shuttle-watcher/release-integration-data/outcomes-complete.db?mode=ro',uri=True);db.row_factory=sqlite3.Row
meta=json.loads((B/'current-meta.json').read_text());top={int(k):v['stops'] for k,v in meta['routeMeta'].items()}
visits={r['id']:dict(r) for r in db.execute('select * from stop_visits')}
selected=collections.defaultdict(list)
for line in (B/'connected-pairs.jsonl').open():
 r=json.loads(line)
 if r['current'][3]==0 or r['canonical'][3]==0:selected[r['poll']].append(r)
counts=collections.Counter();cases=[];perarm={}
for arm in ['current','canonical']:
 for line in gzip.open(B/(arm+'-wire.jsonl.gz'),'rt'):
  f=json.loads(line)
  if f['i'] not in selected:continue
  for r in selected[f['i']]:
   if r[arm][3]!=0:continue
   counts[arm+':zeroHopScored']+=1
   seq=top[r['route']];s=visits[r['sourceId']];t=visits[r['targetId']]
   bi=next(i for i,b in enumerate(f['wire']['buses']) if b[0]==r['bus'] and b[1]==meta['routeMeta'][str(r['route'])]['label'])
   b=f['wire']['buses'][bi];track=f['tracking'][b[1]+'|'+b[0]]
   rows=[x for x in f['wire']['rows'] if x[0]==bi]
   origins=[j for j in range(len(seq)) if all(seq[(j+x[5])%len(seq)]==x[1] for x in rows)];assert len(origins)==1
   assert origins[0]==r['targetIndex']
   if track[3]!=r['targetIndex']:
    counts[arm+':restIdentityNotProved']+=1;continue
   # Strong evidence only: the model rest clock equals a PRIOR visit's pin,
   # that visit has already departed, and an exact reached leg connects it
   # to the subsequently anchored source used by the submitted scorer.
   prior=[v for v in visits.values() if v['route_id']==r['route'] and v['bus_name'].lstrip('#')==r['bus'] and v['stop_index']==r['targetIndex'] and v['pinned_at']==track[4] and v['departed_at'] is not None and v['departed_at']<f['at'] and v['anchored_at']<s['anchored_at']]
   if len(prior)!=1:continue
   v=prior[0];ls=[dict(x) for x in db.execute('select * from legs where route_id=? and bus_name=? and from_index=? and departed_at=? and reached=1',(r['route'],v['bus_name'],v['stop_index'],v['departed_at']))]
   ls=[l for l in ls if l['to_index']==s['stop_index'] and l['arrived_at']==s['arrived_at']]
   if len(ls)!=1:continue
   counts[arm+':exactPriorRestAndLink']+=1
   assert t['id']!=v['id'] and t['arrived_at']>f['at']
   cases.append({'arm':arm,'score':r,'tracked':track,'priorRest':v,'latestSource':s,'directHistoricalLeg':ls[0],'followingTarget':t,'wireAtTarget':[x for x in rows if x[1]==r['targetStop']],'priorArrivalRelativeSec':(v['arrived_at']-f['at'])/1000})
result={'counts':counts,'cases':cases,'finding':'The submitted scorer only reserves a zero-hop current visit when latest historical source index equals target. Once detector source advances while model rest remains on a prior stop, it scores that already-arrived zero-hop row against a later lap. Exact prior pin and directly connected next source establish the defect here. These are retained transition/identity evidence, not permission to exclude inaccurate valid forecasts; following occurrence also needs explicit re-attribution.'}
(O/'lagged-origin-audit.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps({'counts':counts,'uniqueProvedPollTargets':len({(c['score']['poll'],c['score']['route'],c['score']['bus'],c['score']['targetIndex']) for c in cases}),'examples':[{'arm':c['arm'],'poll':c['score']['poll'],'oldVisit':c['priorRest']['id'],'assignedVisit':c['followingTarget']['id'],'priorArrivalRelativeSec':c['priorArrivalRelativeSec'],'assignedTruthSec':c['score']['truthSec']} for c in cases[:4]]},indent=2))
assert any(c['score']['poll']==220 and c['priorRest']['id']==56897 and c['followingTarget']['id']==57352 for c in cases)
# A semantic validation gate expected to fail on the builder's claimed final labels.
assert not cases, 'Final outcome labels still move lagged current-stop forecasts to a future lap; see lagged-origin-audit.json'
