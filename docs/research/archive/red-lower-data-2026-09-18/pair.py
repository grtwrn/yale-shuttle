from pathlib import Path
import json,itertools
r=Path(__file__).parent
prior=r.parent/'overnight-2026-09-17/eta/cycle-14/current.jsonl'
count=changed=0
with (r/'baseline.jsonl').open() as b,(r/'candidate.jsonl').open() as c,prior.open() as original,(r/'pairs.jsonl').open('w') as out:
 for bl,cl,ol in itertools.zip_longest(b,c,original):
  assert bl and cl and ol,'availability mismatch'
  x,y,z=map(json.loads,(bl,cl,ol))
  identity=('at','bus','target','stopsAhead','segmentId')
  assert all(x[k]==y[k]==z[k] for k in identity)
  assert x['forecast']==z['forecast'],'current production baseline must reproduce overnight archive exactly'
  assert x['forecast']['eta']==y['forecast']['eta'] and x['forecast']['high']==y['forecast']['high'],'only lower may change'
  assert y['forecast']['low']>=x['forecast']['low']-1e-8
  row={**x,'baseline':x.pop('forecast'),'candidate':y['forecast']}
  out.write(json.dumps(row)+'\n');count+=1;changed+=row['baseline']['low']!=row['candidate']['low']
print(json.dumps({'paired':count,'changedLow':changed,'pointUpperIdentityAndBaselineExact':True}))
