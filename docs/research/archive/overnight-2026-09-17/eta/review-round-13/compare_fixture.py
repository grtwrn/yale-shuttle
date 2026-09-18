from pathlib import Path
import json,gzip,collections
O=Path(__file__).resolve().parent
def read(a,m):return json.loads(gzip.decompress((O/f'{a}-fixture-{m}.json.gz').read_bytes()))
def state(r):return {'entries':sorted(r['entries'],key=lambda x:x[0]),'seen':sorted(r['seen'],key=lambda x:x[0])}
def wire(r):
 w=r['wire'];assert w is not None
 out={};dist=w.get('distributions')
 for i,row in enumerate(w['rows']):
  b=w['buses'][row[0]];k=(b[1],b[0],row[1],row[5]);assert k not in out
  out[k]={'row':row[1:],'quantiles':dist[i] if dist else None}
 return out
results={};routes=collections.Counter();occurrence=collections.Counter()
for a in ['current','canonical']:
 normal=read(a,'normal');results[a]={}
 for mode in ['reverse','restart10','restart20','restart30']:
  test=read(a,mode);counts=collections.Counter();extreme=[]
  for r in test:
   n=normal[r['i']];x,y=wire(n),wire(r);counts['frames']+=1;counts['wireMatches']+=x==y;counts['stateMatches']+=state(n)==state(r)
   counts['lostRows']+=len(set(x)-set(y));counts['gainedRows']+=len(set(y)-set(x))
   for k in set(x)&set(y):
    counts['pairedRows']+=1;counts['changedRows']+=x[k]['row']!=y[k]['row'];counts['changedQuantiles']+=x[k]['quantiles']!=y[k]['quantiles']
    if x[k]!=y[k]:extreme.append({'i':r['i'],'key':k,'maxBandDelta':max(abs(c-d) for c,d in zip(x[k]['row'][1:4],y[k]['row'][1:4]))})
  results[a][mode]={'counts':counts,'largestChanges':sorted(extreme,key=lambda r:r['maxBandDelta'],reverse=True)[:5]}
 for r in normal:
  for k in wire(r):routes[k[0]]+=1
for mode,r in results['canonical'].items():
 c=r['counts'];assert c['wireMatches']==c['frames'] and c['stateMatches']==c['frames'],(mode,c)
(O/'fixture-comparison.json').write_text(json.dumps({'results':results,'armCombinedRowsByRoute':routes,'comparison':'Physical route/bus/stop/hops join. Complete ModelEntry maps/typed arrays preserved and sorted; seenAt sorted. Raw wire ordering is not a physical identity change.'},indent=2)+'\n')
print(json.dumps({a:{m:r['counts'] for m,r in rs.items()} for a,rs in results.items()},indent=2))
