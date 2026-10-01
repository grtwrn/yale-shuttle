"""Independent read-only audit of the saved operating-pattern component screen."""
import collections,datetime,hashlib,json,math,pathlib,statistics
from zoneinfo import ZoneInfo
D=pathlib.Path(__file__).resolve().parent;P=D/'operating-pattern-screen.json';x=json.loads(P.read_text());rows=x['featureRows'];lookup={r['id']:r for r in rows}
assert len(lookup)==len(rows),'duplicate feature/target row'
assert 65237 not in lookup,'known truncated target must not enter component fit'
TZ=ZoneInfo('America/New_York');cut=lambda s:datetime.datetime.fromisoformat(s).replace(tzinfo=TZ).timestamp()*1000
F,T=cut('2026-09-10'),cut('2026-09-14');joins=collections.Counter()
for r in rows:
 assert r['a']<=r['d']<=r['ready']
 assert abs(r['y']-(r['d']-r['a'])/1000)<1e-9
 for name in ['own','fleet','other']:
  ps=[lookup[i]for i in r[name+'Ids']]
  assert bool(ps)==r[name+'Available']
  for p in ps:
   assert p['id']!=r['id'] and p['ready']<=r['a'] and p['day']==r['day']
   if name=='fleet':assert p['stop']==r['stop'] and p['bus']!=r['bus'] and p['ready']>=r['a']-3600000
   if name=='own':assert p['stop']==r['stop'] and p['bus']==r['bus']
   if name=='other':assert p['stop']!=r['stop'] and p['bus']==r['bus']
   joins[name]+=1
out=[]
for z in x['results']:
 rr=[r for r in rows if r['stop']==z['stop']]
 groups={'train':[r for r in rr if r['ready']<F],'calibration':[r for r in rr if r['a']>=F and r['ready']<T],'test':[r for r in rr if r['a']>=T]}
 for name,rs in groups.items():assert len(rs)==z[name+'N']
 assert max(r['ready']for r in groups['train'])<min(r['a']for r in groups['calibration'])
 assert max(r['ready']for r in groups['calibration'])<min(r['a']for r in groups['test'])
 laps=z['arms']['lap'];candidate=z['arms']['lap_clock15'];truth={r['id']:r for r in groups['test']}
 for arm,v in z['arms'].items():
  assert len(v['predictions'])==len(truth) and {r['id']for r in v['predictions']}==set(truth)
  assert all(r['truth']==truth[r['id']]['y'] and 0<=r['low']<=r['point']<=r['high'] for r in v['predictions'])
  rr=v['predictions'];n=len(rr)
  mae=statistics.mean(abs(r['point']-r['truth'])for r in rr)
  wis=statistics.mean((.5*abs(r['point']-r['truth'])+.1*(r['high']-r['low'])+max(0,r['low']-r['truth'])+max(0,r['truth']-r['high']))/1.5 for r in rr)
  assert abs(mae-v['summary']['mae'])<1e-8 and abs(wis-v['summary']['WIS'])<1e-8
 byday={d:{k:candidate['byDate'][d][k]-a[k]for k in ['mae','WIS','p90Abs','width','early','late','over120']}for d,a in laps['byDate'].items()}
 concentration={}
 for name,rs in groups.items():
  perday={}
  for day in sorted({r['day']for r in rs}):
   cell=[r for r in rs if r['day']==day]
   angles=[2*math.pi*((datetime.datetime.fromtimestamp(r['d']/1000,TZ).hour*60)+datetime.datetime.fromtimestamp(r['d']/1000,TZ).minute+datetime.datetime.fromtimestamp(r['d']/1000,TZ).second/60)/15 for r in cell]
   a=statistics.mean(math.cos(t)for t in angles);b=statistics.mean(math.sin(t)for t in angles)
   perday[day]=dict(n=len(cell),R=math.hypot(a,b),phaseMinutes=(math.atan2(b,a)%(2*math.pi))*15/(2*math.pi))
  concentration[name]=perday
 out.append(dict(stop=z['stop'],dates={name:dict(collections.Counter(r['day']for r in rs))for name,rs in groups.items()},clock15MinusLapByDate=byday,departureConcentration15ByDate=concentration,clock15TailComparison={k:[laps['summary'][k],candidate['summary'][k]]for k in ['mae','medianAbs','p90Abs','WIS','width','early','late','over120','under120']}))
report=dict(inputSha256=hashlib.sha256(P.read_bytes()).hexdigest(),method=__doc__,checks='Unique target IDs, completion-before-split, same-day completed-history joins and family identity, identical arm outcome cohorts, ordered nonnegative quantiles, independent MAE/WIS recomputation. No exact historical event-receipt proof.',rows=len(rows),completedHistoryJoinCount=dict(joins),results=out)
(D/'operating-pattern-review.json').write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps(report,indent=2))
