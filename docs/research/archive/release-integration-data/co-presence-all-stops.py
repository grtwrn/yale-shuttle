"""Descriptive Red same-stop encounters, excluding reserved afternoon.
Overlap is a detector proxy for physical co-location, not doors or dispatch.
"""
import collections,json,pathlib,sqlite3,statistics
D=pathlib.Path(__file__).resolve().parent;CUTOFF=1789665240913
c=sqlite3.connect('file:'+str(D.parent/'conditional-replay-data/outcomes.db')+'?mode=ro',uri=True);c.row_factory=sqlite3.Row
byStop=collections.defaultdict(list)
for q in c.execute("select * from stop_visits where route_id=3 and anchored_at<=? and departed_at is not null and departed_at<=? and how!='gap' and closest_m<=75 and outcome in ('stopped','passed') order by anchored_at",(CUTOFF,CUTOFF)):
 v=dict(q);v['start']=v['pinned_at']if v['pinned_at']is not None else v['anchored_at'];byStop[v['stop_id']].append(v)
events=[]
for stop,vs in byStop.items():
 vs.sort(key=lambda v:v['start'])
 for i,b in enumerate(vs):
  for a in reversed(vs[:i]):
   if b['start']-a['start']>3600000:break
   if a['bus_name']==b['bus_name']:continue
   end=min(a['departed_at'],b['departed_at'])
   if end<=b['start']:continue
   events.append(dict(stop=stop,earlierId=a['id'],laterId=b['id'],earlierBus=a['bus_name'],laterBus=b['bus_name'],metAt=b['start'],overlapSec=(end-b['start'])/1000,earlierLeavesSecAfterMeet=(a['departed_at']-b['start'])/1000,laterLeavesSecAfterMeet=(b['departed_at']-b['start'])/1000,signedDepartureGapSec=(b['departed_at']-a['departed_at'])/1000,bothStopped=a['outcome']==b['outcome']=='stopped'))
summary=[]
for stop in sorted(byStop):
 es=[e for e in events if e['stop']==stop];st=[e for e in es if e['bothStopped']]
 if not es:continue
 summary.append(dict(stop=stop,encounters=len(es),bothStopped=len(st),overtakes=sum(e['signedDepartureGapSec']<0 for e in es),medianOverlapSec=statistics.median(e['overlapSec']for e in es),medianDepartureGapSec=statistics.median(abs(e['signedDepartureGapSec'])for e in es)))
out=dict(method=__doc__,cutoff=CUTOFF,summary=summary,events=events)
(D/'co-presence-all-stops.json').write_text(json.dumps(out,indent=2)+'\n');print(json.dumps(summary,indent=2));print('encounters',len(events),'bothstopped',sum(e['bothStopped']for e in events))
