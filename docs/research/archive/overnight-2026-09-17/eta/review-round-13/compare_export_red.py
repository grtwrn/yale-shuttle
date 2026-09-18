import json,pathlib,collections
O=pathlib.Path(__file__).resolve().parent;A=pathlib.Path('/home/gwarren/projects/yale-shuttle-watcher');red={r['at']:r['buses'] for r in map(json.loads,(A/'release-integration-data/raw-complete-frames.jsonl').open())};changes=collections.Counter();matches=0;busmatches=0;unknown=0;examples=[];projected=0
for r in map(json.loads,(pathlib.Path('/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/cycle-14/all-route-raw-frames.jsonl')).open()):
 if r['at'] not in red:continue
 orig={b['bus_name']:b for b in red[r['at']]};now={b['bus_name']:b for b in r['buses'] if b['route_id']==3};matches+=1
 for name in orig.keys()|now.keys():
  if name not in orig or name not in now:unknown+=1;continue
  a,b=orig[name],now[name];busmatches+=1
  for k in a.keys()|b.keys():
   if a.get(k)!=b.get(k):
    changes[k]+=1
    if len(examples)<8:examples.append({'at':r['at'],'bus':name,'field':k,'old':a.get(k),'allFleet':b.get(k)})
  restricted=dict(b);laps={k:v for k,v in b.get('lap',{}).items() if k in ['11','121']}
  if laps:restricted['lap']=laps
  else:restricted.pop('lap',None)
  assert restricted==a,(r['at'],name);projected+=1
assert matches==len(red)
x={'matchedRedPolls':matches,'matchedBusRows':busmatches,'differentAvailability':unknown,'fieldChanges':changes,'examples':examples,'exactRowsAfterOriginalRedLapKeyProjection':projected,'interpretation':'Only intentional extra lap-age keys differ. Restricting all-fleet lap map to original11/121 makes all46790Redbusrows exactly equal at16253original poll clocks. Future full-fleet arms must both use same expanded observations, not compare against earlier Red-only forecasts.'}
(O/'all-route-red-input-comparison.json').write_text(json.dumps(x,indent=2)+'\n');print(json.dumps({k:v for k,v in x.items() if k!='examples'},indent=2))
