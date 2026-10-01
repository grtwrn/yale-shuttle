"""All-day descriptive audit of connected Red journeys, with separate elapsed clocks.
Read-only; preserves the chain criteria from the short-trip audit. No accuracy claim.
"""
import ast,collections,datetime,json,pathlib,sqlite3,statistics,zoneinfo
ROOT=pathlib.Path('/home/gwarren/projects/yale-shuttle-watcher'); HERE=ROOT/'red-window-data'
db=sqlite3.connect('file:'+str(ROOT/'red-eta-data/replay-lap.db')+'?mode=ro',uri=True);db.row_factory=sqlite3.Row
seq=json.loads(db.execute('SELECT stops_json FROM routes WHERE id=3').fetchone()[0]);TZ=zoneinfo.ZoneInfo('America/New_York')
# Reuse reviewed exact-link functions without executing the selected-cohort/GPS audit.
module=ast.parse((HERE/'short-trip-audit.py').read_text())
exec(compile(ast.Module(body=[n for n in module.body if isinstance(n,ast.FunctionDef) and n.name in ['rows','chain']],type_ignores=[]),'<audit-chain>','exec'))
def et(t):return datetime.datetime.fromtimestamp(t/1000,TZ)
def quant(v,p):
 v=sorted(v);i=(len(v)-1)*p;a=int(i);return v[a]+(v[min(a+1,len(v)-1)]-v[a])*(i-a)
def stats(rs):
 v=[r['seconds'] for r in rs]
 return dict(n=len(rs),dates=len({r['date'] for r in rs}),short=sum(r['short'] for r in rs),min=round(min(v),1),p10=round(quant(v,.1),1),median=round(statistics.median(v),1),p90=round(quant(v,.9),1)) if v else dict(n=0,dates=0,short=0)
sources=rows("SELECT * FROM stop_visits WHERE route_id=3 AND stop_id=11 AND stop_index=14 ORDER BY pinned_at")
excluded=collections.Counter(); obs=[]; connected=collections.Counter();fail=[]
for s in sources:
 if not(s['outcome']=='stopped' and s['pinned_at'] is not None and s['arrived_at'] is not None and s['departed_at'] is not None and s['arrived_at']<=s['departed_at'] and s['how']!='gap' and s['closest_m'] is not None and s['closest_m']<=75):
  excluded['source incomplete/non-stopped/gap/distant']+=1;continue
 for target in [48,4]:
  path,error=chain(s,target)
  if error:
   excluded[str(target)+': '+error]+=1;fail.append(dict(sourceId=s['id'],target=target,reason=error,hour=et(s['pinned_at']).hour));continue
  arrival=path[-1]['visit']['arrived_at'];connected[str(target)]+=1
  for clock in ['pin','departure',55,405]:
   start=s['departed_at'] if clock=='departure' else s['pinned_at']+(clock*1000 if isinstance(clock,int) else 0)
   if isinstance(clock,int) and not s['arrived_at']<=start<s['departed_at']:continue
   sec=(arrival-start)/1000
   if sec<0:raise ValueError('negative time')
   threshold=120 if target==48 else 420
   local=et(start)
   obs.append(dict(journeyId=f"3:{s['id']}:{path[-1]['visit']['id']}",sourceId=s['id'],target=target,clock=str(clock),bus=s['bus_name'],at=start,date=local.date().isoformat(),hour=local.hour,seconds=sec,short=sec<=threshold,threshold=threshold,sourceStandSec=(s['departed_at']-s['pinned_at'])/1000,sourceWaitSec=max(0,(s['departed_at']-start)/1000),departureToTargetSec=(arrival-s['departed_at'])/1000))
summary=[]
for target in [48,4]:
 for clock in ['pin','departure','55','405']:
  rs=[r for r in obs if r['target']==target and r['clock']==clock]
  summary.append(dict(target=target,clock=clock,overall=stats(rs),byHour={str(h):stats([r for r in rs if r['hour']==h]) for h in sorted({r['hour'] for r in rs})},byBus={str(b):stats([r for r in rs if r['bus']==b])for b in sorted({r['bus']for r in rs})}))
output=dict(method='All qualifying exact-linked Red Winchester source visits in local Sep3–16 recording; stopped targets only; no time-of-day matching. Separate pin, departure, 55s and405s clocks. Short thresholds120s toDivision and420s toRosenkranz are descriptive, not fitted or safety bounds. Residual cohorts condition on remaining atsource at that elapsed clock, not live posterior stand state. Endpoint labels are collector stop proxies, not door-open truth.',sourceVisits=len(sources),connected=dict(connected),exclusions=dict(excluded),failures=fail,summary=summary,observations=obs)
(HERE/'short-trip-hours.json').write_text(json.dumps(output,indent=2)+'\n')
lines=['# All-day short-journey audit','',output['method'],'',f"Source visits: {len(sources)}; connected stopped Division targets: {connected['48']}; Rosenkranz: {connected['4']}.",'',f'Exclusions: {dict(excluded)}.','']
for item in summary:
 lines += [f"## Target {item['target']}, clock {item['clock']}",'',f"Overall: {item['overall']}",'','| Local hour | Journeys | Dates | Short | Median seconds | p10–p90 seconds |','|---|---:|---:|---:|---:|---:|']
 for h,s in item['byHour'].items():lines.append(f"| {h} | {s['n']} | {s['dates']} | {s['short']} | {s['median']} | {s['p10']}–{s['p90']} |")
 lines+=['']
(HERE/'short-trip-hours.md').write_text('\n'.join(lines)+'\n')
print(json.dumps({k:v for k,v in output.items() if k not in ['observations','failures']},indent=2))
