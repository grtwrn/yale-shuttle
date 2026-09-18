from pathlib import Path
import json,collections,statistics
r=Path(__file__).parent;s=json.loads((r/'score.json').read_text());groups=collections.defaultdict(list)
for x in s['checkpoints']:
 if x['sourceStop']!=11:continue
 groups[(x['target'],x['phase'],x['checkpointSec'])].append(x)
summary=[]
for key,xs in sorted(groups.items()):
 def stat(arm):
  return {'n':len(xs),'visits':len({x['sourceId'] for x in xs}),'width':round(statistics.mean(x[arm]['high']-x[arm]['low'] for x in xs),1),'meanLow':round(statistics.mean(x[arm]['low'] for x in xs),1),'early':sum(x['truthSec']<x[arm]['low'] for x in xs),'missWith60secBuffer':sum(x['truthSec']<x[arm]['low']-60 for x in xs),'late':sum(x['truthSec']>x[arm]['high'] for x in xs)}
 summary.append({'target':key[0],'phase':key[1],'elapsed':key[2],'baseline':stat('baseline'),'candidate':stat('candidate'),'newEarly':sum(x['baseline']['low']<=x['truthSec']<x['candidate']['low'] for x in xs)})
regressions=[x for x in s['checkpoints'] if x['baseline']['low']<=x['truthSec']<x['candidate']['low']]
(r/'summary.json').write_text(json.dumps({'groups':summary,'newEarlyCount':len(regressions),'newEarlyVisits':len({x['sourceId'] for x in regressions}),'newEarly':regressions},indent=2))
print(json.dumps(summary,indent=2))
