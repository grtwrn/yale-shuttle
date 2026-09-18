from pathlib import Path
import json,collections,sqlite3,bisect
O=Path(__file__).resolve().parent;A=Path('/home/gwarren/projects/yale-shuttle-watcher')
tracks={a:[json.loads(l) for l in (O/(a+'-tracking.jsonl')).open()] for a in ['current','canonical']}
back={};changes={};idx={a:{(r['at'],r['bus']):r for r in rs} for a,rs in tracks.items()}
for a,rs in tracks.items():
 prev={};back[a]=[]
 for r in rs:
  p=prev.get(r['bus']);prev[r['bus']]=r
  if p and r['at']-p['at']<=60000 and min(r['lead'],p['lead'])>=0:
   d=(r['lead']-p['lead'])%29
   if d>14:back[a].append({'at':r['at'],'bus':r['bus'],'priorLead':p['lead'],'lead':r['lead'],'forwardModuloDelta':d})
for c in ['lead','restStop']:
 arr=[]
 for k,a in idx['current'].items():
  b=idx['canonical'][k]
  if a.get(c)!=b.get(c):arr.append({'at':k[0],'bus':k[1],'current':a.get(c),'canonical':b.get(c)})
 windows=[]
 for r in sorted(arr,key=lambda r:(r['bus'],r['at'])):
  if windows and windows[-1]['bus']==r['bus'] and r['at']-windows[-1]['end']<=15000:
   windows[-1]['end']=r['at'];windows[-1]['polls']+=1;windows[-1]['values'].add((r['current'],r['canonical']))
  else:windows.append({'bus':r['bus'],'start':r['at'],'end':r['at'],'polls':1,'values':{(r['current'],r['canonical'])}})
 for w in windows:w['values']=sorted(w['values'])
 changes[c]=windows
counts=collections.Counter();large=[]
for r in map(json.loads,(O/'full-pairs.jsonl').open()):
 a,b=r['baseline'],r['candidate'];d=max(abs(a[c]-b[c]) for c in ['eta','low','high'])
 if d>60:counts['bandChangeOver60']+=1;large.append({'at':r['at'],'bus':r['bus'],'target':r['target'],'hops':r['stopsAhead'],'current':a,'canonical':b,'maxBandDelta':d})
 if abs(a['eta']-b['eta'])>60:counts['medianChangeOver60']+=1
 for arm,p in [('current',a),('canonical',b)]:
  if p['low']<0:counts[arm+'NegativeLow']+=1
long=json.loads((O/'longitudinal.json').read_text());tail=json.loads((O/'connected-tail-changes.json').read_text());db=sqlite3.connect('file:'+str(A/'release-integration-data/outcomes-complete.db')+'?mode=ro',uri=True);db.row_factory=sqlite3.Row
reg=[]
for r in long['largestPointRegressions'][:10]+tail:
 v=dict(db.execute('select * from stop_visits where id=?',(r['targetId'],)).fetchone());sources=[dict(db.execute('select id,bus_name,stop_id,pinned_at,departed_at,outcome,how from stop_visits where id=?',(i,)).fetchone()) for i in r['sourceIds']];assert v['arrived_at']-r['at']==round(r['truthSec']*1000)
 reg.append({'forecast':r,'target':{k:v[k] for k in ['id','bus_name','stop_id','arrived_at','departed_at','outcome','how','closest_m']},'sources':sources,'decision':'Retain. Exact connected endpoint already verified; no measurement-error exclusion supported.'})
x={'counts':counts,'numericBackwardLeadTransitions':back,'backwardMeaning':'lead is shown leg index. Modulo delta>14 marks a numerical backward change, not proof of physically reversing or a new tracker violation. Compare exact events; do not enforce monotonic ETA.','changedWindows':changes,'largestUnrestrictedBandChanges':sorted(large,key=lambda r:r['maxBandDelta'],reverse=True)[:20],'regressionAndTailAudits':reg}
(O/'change-audit.json').write_text(json.dumps(x,indent=2)+'\n');db.close();print(json.dumps({'counts':counts,'numericBackwardLeadTransitions':{a:len(v) for a,v in back.items()},'changeWindows':{c:len(v) for c,v in changes.items()},'auditedRegressionsAndTailRows':len(reg)},indent=2))
