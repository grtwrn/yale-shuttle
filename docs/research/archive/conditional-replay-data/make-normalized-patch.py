"""Build a prior-only conditional table using the actual live lap-clock contract.
Positive durations: modern pinned visits. Previous departures: LEGACY arrivals,
as collector.noteDeparture/seedLapClock actually supply, not the stale wire comment.
"""
import json,pathlib,sqlite3,statistics,datetime
from zoneinfo import ZoneInfo
ROOT=pathlib.Path('/home/gwarren/projects/yale-shuttle-watcher');D=ROOT/'conditional-replay-data';TZ=ZoneInfo('America/New_York')
p=json.load(open(D/'baseline-patch.json'));inp=json.load(open(ROOT/'red-window-data/conditional-hold-input.json'));db=sqlite3.connect('file:'+str(ROOT/'red-eta-data/replay-lap.db')+'?mode=ro',uri=True)
reports=[]
def q(xs,u):
 s=sorted(xs);i=(len(s)-1)*u;a=int(i);return s[a]+(s[min(a+1,len(s)-1)]-s[a])*(i-a)
for model in inp['models']:
 stop=model['stop'];cell=p['dwells']['3'][str(stop)];values=[];records=[];excluded={}
 for r in model['prior']:
  def prev(s):return db.execute('SELECT MAX(departed_at) FROM arrivals WHERE route_id=3 AND stop_id=? AND bus_name=? AND departed_at<=?',(s,r['bus'],r['a']-120000)).fetchone()[0]
  previous=prev(stop);opp=prev(121 if stop==11 else 11)
  day=lambda t:datetime.datetime.fromtimestamp(t/1000,TZ).date()
  lap=(r['a']-previous)/1000 if previous is not None else None
  if not(previous and opp and previous<opp<r['a'] and day(previous)==day(r['a'])):reason='missing same-service prior loop'
  elif not(.65*cell['lapM']<=lap<=1.65*cell['lapM']):reason='outside lap support'
  else:reason=None
  if reason:excluded[reason]=excluded.get(reason,0)+1;continue
  factor=min(2,max(.35,1+cell['lapN']/(cell['lapN']+19)*cell['lapB']*(lap-cell['lapM'])))
  value=r['y']/factor;values.append(value);records.append(dict(visitId=r['id'],pinAt=r['a'],readyAt=r['ready'],previousLegacyDeparture=previous,lapSec=lap,factor=factor,holdSec=r['y'],normalizedSec=value))
 assert all(r['readyAt']<1789358400000 for r in records)
 cell['lapQ']=[q(values,(i+.5)/10)for i in range(10)];cell['lapQn']=len(values)
 reports.append(dict(stop=stop,n=len(values),excluded=excluded,lapMedian=statistics.median(r['lapSec']for r in records),normalizedMedian=statistics.median(values),records=records))
(D/'normalized-live-clock-patch.json').write_text(json.dumps(p)+'\n');(D/'normalized-live-clock-fit.json').write_text(json.dumps(dict(cutoff='2026-09-14T04:00:00Z',contract='current pinned time minus previous legacy departure; positive pinned-to-departure hold',results=reports),indent=2)+'\n')
print([{k:v for k,v in r.items()if k!='records'}for r in reports])
