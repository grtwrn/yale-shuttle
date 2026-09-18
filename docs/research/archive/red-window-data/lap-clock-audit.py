"""Compare contemporaneous legacy arrival and pinned visit clocks. Diagnostic only."""
import collections,json,pathlib,sqlite3,statistics
ROOT=pathlib.Path('/home/gwarren/projects/yale-shuttle-watcher');HERE=ROOT/'red-window-data'
d=sqlite3.connect('file:'+str(ROOT/'red-eta-data/replay-lap.db')+'?mode=ro',uri=True);d.row_factory=sqlite3.Row
inp=json.loads((HERE/'conditional-hold-input.json').read_text());out=[]
def describe(v):
 s=sorted(v)
 def q(p):
  i=(len(s)-1)*p;a=int(i);return s[a]+(s[min(a+1,len(s)-1)]-s[a])*(i-a)
 return dict(n=len(s),median=statistics.median(s),p10=q(.1),p90=q(.9)) if s else dict(n=0)
for m in inp['models']:
 pairs=[];excluded=collections.Counter()
 for r in m['prior']:
  # Must overlap the same visit and have departures within two minutes.
  candidates=[dict(z)for z in d.execute('SELECT * FROM arrivals WHERE route_id=3 AND stop_id=? AND bus_name=? AND arrived_at<=? AND departed_at>=? AND ABS(departed_at-?)<=120000',(r['stop'],r['bus'],r['d'],r['a'],r['d']))]
  if len(candidates)!=1:excluded[str(len(candidates))+' legacy matches']+=1;continue
  old=candidates[0];
  prior=d.execute('SELECT departed_at FROM arrivals WHERE route_id=3 AND stop_id=? AND bus_name=? AND departed_at<? ORDER BY arrived_at DESC LIMIT 1',(r['stop'],r['bus'],old['arrived_at'])).fetchone()
  oldlap=(old['arrived_at']-prior[0])/1000 if prior else None
  pairs.append(dict(modernId=r['id'],legacyId=old['id'],bus=r['bus'],modernLapSec=r['lap'],legacyLapSec=oldlap,pinMinusLegacyArrivalSec=(r['a']-old['arrived_at'])/1000,departureModernMinusLegacySec=(r['d']-old['departed_at'])/1000,holdModernMinusLegacySec=r['y']-(old['departed_at']-old['arrived_at'])/1000,lapModernMinusLegacySec=r['lap']-oldlap if r['lap'] is not None and oldlap is not None and abs(r['lap']-oldlap)<1200 else None))
 summary={k:describe([r[k]for r in pairs if r[k]is not None])for k in ['pinMinusLegacyArrivalSec','departureModernMinusLegacySec','holdModernMinusLegacySec','lapModernMinusLegacySec','modernLapSec','legacyLapSec']}
 out.append(dict(stop=m['stop'],priorVisits=len(m['prior']),matched=len(pairs),excluded=dict(excluded),summary=summary,pairs=pairs))
(HERE/'lap-clock-audit.json').write_text(json.dumps(dict(method='Contemporaneous prior-date modern visits paired with unique overlapping same-bus same-stop legacy arrivals whose departure is within120s. Diagnostic selection, not validation. Lap-difference summary excludes unmatched overnight/definition gaps>=1200s. Does not prove which clock is ground truth.',results=out),indent=2)+'\n')
for r in out:print(json.dumps({k:v for k,v in r.items()if k!='pairs'},indent=2))
