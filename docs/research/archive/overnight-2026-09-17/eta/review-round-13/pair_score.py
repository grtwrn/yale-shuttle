from pathlib import Path
import json,collections,subprocess,math
O=Path(__file__).resolve().parent;A=Path('/home/gwarren/projects/yale-shuttle-watcher/release-integration-data')
def read(p):return [json.loads(l) for l in p.open()]
arms={a:read(O/(a+'.jsonl')) for a in ['current','canonical']}
def key(r):return(r['at'],r['bus'],r['target'],int(r['stopsAhead']>29))
idx={a:{key(r):r for r in rows} for a,rows in arms.items()}
for a in arms:assert len(idx[a])==len(arms[a]),'Ambiguous occurrence'
status=collections.Counter();changes=collections.Counter();negative=[];hops=[];extremes=[]
fds={k:(O/f'full-{k}-pairs.jsonl').open('w') for k in ['development','reused-afternoon']}
with (O/'full-pairs.jsonl').open('w') as out:
 for k in sorted(set(idx['current'])|set(idx['canonical'])):
  a,b=idx['current'].get(k),idx['canonical'].get(k);r=dict(a or b);r.pop('forecast');r.update(baseline=a['forecast'] if a else None,candidate=b['forecast'] if b else None,baselineStopsAhead=a['stopsAhead'] if a else None,candidateStopsAhead=b['stopsAhead'] if b else None)
  status['paired' if a and b else 'current_only' if a else 'canonical_only']+=1
  for arm,x in [('current',a),('canonical',b)]:
   if x:
    p=x['forecast'];assert all(math.isfinite(p[c]) for c in ['eta','low','high']);assert p['low']<=p['eta']<=p['high']
    if p['low']<0:negative.append({'key':k,'arm':arm,'forecast':p})
  if a and b:
   assert a['warmMs']==b['warmMs'] and a['observedAt']==b['observedAt']
   if a['stopsAhead']!=b['stopsAhead']:hops.append({'key':k,'current':a['stopsAhead'],'canonical':b['stopsAhead']})
   for c in ['eta','low','high']:
    if a['forecast'][c]!=b['forecast'][c]:changes[c]+=1
   if a['forecast']!=b['forecast']:extremes.append({'key':k,'baseline':a['forecast'],'candidate':b['forecast'],'maxBandDelta':max(abs(a['forecast'][c]-b['forecast'][c]) for c in ['eta','low','high'])})
  s=json.dumps(r)+'\n';out.write(s);fds['development' if r['at']<=1789665240913 else 'reused-afternoon'].write(s)
for f in fds.values():f.close()
track={a:{(r['at'],r['bus']):r for r in read(O/(a+'-tracking.jsonl'))} for a in arms}
assert set(track['current'])==set(track['canonical'])
tracking=collections.Counter()
for k in track['current']:
 a,b=track['current'][k],track['canonical'][k]
 for arm,r in [('current',a),('canonical',b)]:assert abs(r['pSum']-1)<1e-8
 for c in ['lead','rested','restSince','restStop','lap']:
  if a.get(c)!=b.get(c):tracking[c]+=1
summary={'armRows':{a:len(rows) for a,rows in arms.items()},'occurrencePairing':'at,bus,target,hops>29 (second future traversal). Original arm hops retained; differences reported. No raw negative bound clipped in stored pairs.','availability':status,'changed':changes,'changedHops':len(hops),'trackingRows':len(track['current']),'trackingChanged':tracking,'rawNegativeBounds':len(negative),'largestBandChanges':sorted(extremes,key=lambda r:r['maxBandDelta'],reverse=True)[:20]}
for name,obj in [('pair-summary',summary),('negative-bounds',negative),('hop-changes',hops)]: (O/(name+'.json')).write_text(json.dumps(obj,indent=2)+'\n')
for part in fds:
 cmd=['python3','/home/gwarren/projects/yale-shuttle-watcher/red-window-data/full-path-score.py','--pairs',str(O/f'full-{part}-pairs.jsonl'),'--db',str(A/'outcomes-complete.db'),'--out',str(O/f'full-{part}-score.json'),'--min-warm-sec','600']
 with (O/f'full-{part}-score.log').open('w') as f:subprocess.run(cmd,stdout=f,stderr=subprocess.STDOUT,check=True)
s=(A/'final-next-occurrence-review.py').read_text().replace("P=D/'final-pairs.jsonl'","P=D/'full-pairs.jsonl'").replace("str(D/'outcomes-complete.db')",f"str(pathlib.Path('{A}/outcomes-complete.db'))").replace("(D/'raw-complete-frames.jsonl').open()",f"(pathlib.Path('{A}/raw-complete-frames.jsonl')).open()").replace("D/'final-next-occurrence-review.json'","D/'full-next-occurrence-review.json'")
(O/'score_next.py').write_text(s)
with (O/'full-next-occurrence.log').open('w') as f:subprocess.run(['python3',str(O/'score_next.py')],stdout=f,stderr=subprocess.STDOUT,check=True)
print(json.dumps({k:v for k,v in summary.items() if k!='largestBandChanges'},indent=2))
