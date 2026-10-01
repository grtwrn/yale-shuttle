from pathlib import Path
import json,sqlite3,heapq,collections
O=Path(__file__).resolve().parent;A=O.parents[2];db=sqlite3.connect('file:'+str(A/'release-integration-data/outcomes-complete.db')+'?mode=ro',uri=True);db.row_factory=sqlite3.Row
large=[json.loads(l) for l in (O/'large-tail-changes.jsonl').open()];s=json.loads((O/'score.json').read_text());selected={}
for kind,rs in [('large-band',sorted(large,key=lambda r:r['maxBandDelta'],reverse=True)[:12]),('point-regression',s['largestPointRegressions'][:12])]:
 for r in rs:
  k=(r['at'],r['route'],r['bus'],r['targetIndex'],r['occurrence']);x=selected.setdefault(k,{'forecast':r,'selectedBy':[]});x['selectedBy'].append(kind)
for x in selected.values():
 r=x['forecast'];x['records']={}
 for name,key in [('source','sourceId'),('target','targetId')]:
  if r[key] is not None:
   v=db.execute('select id,bus_name,route_id,stop_id,stop_index,anchored_at,pinned_at,arrived_at,departed_at,outcome,how from stop_visits where id=?',(r[key],)).fetchone();x['records'][name]=dict(v);assert v['route_id']==r['route'] and v['bus_name'].lstrip('#')==r['bus']
 x['legs']=[dict(db.execute('select id,route_id,bus_name,from_index,to_index,hops,departed_at,arrived_at,reached from legs where id=?',(i,)).fetchone()) for i in r['legIds']]
 raw=[dict(v) for v in db.execute('select collected_at,route_id,bus_name,lat,lon,last_stop_id from raw_positions where route_id=? and bus_name=? and collected_at between ? and ? order by collected_at,id',(r['route'],'#'+r['bus'],r['at']-15000,r['at']+15000))]
 x['rawWindow']=raw;x['labelDecision']='Retained unchanged. This is an audit of recorded clocks/coordinates, not positive proof of a measurement error or boardability.'
summary={'largeBandRows':len(large),'byRoute':collections.Counter(str(r['route']) for r in large),'postArrivalLabeled':sum(r['truthSec'] is not None and r['truthSec']<0 for r in large),'connectedNonnegative':sum(r['truthSec'] is not None and r['truthSec']>=0 and bool(r['legIds']) for r in large),'unknownTruth':sum(r['truthSec'] is None for r in large),'selectedAudits':list(selected.values()),'exclusions':[]};db.close();(O/'largest-case-audit.json').write_text(json.dumps(summary,indent=2)+'\n');print(json.dumps({k:v for k,v in summary.items() if k!='selectedAudits'},indent=2))
