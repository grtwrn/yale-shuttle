import json,sqlite3,pathlib
O=pathlib.Path(__file__).resolve().parent;A=pathlib.Path('/home/gwarren/projects/yale-shuttle-watcher');x=json.loads((O/'change-audit.json').read_text());db=sqlite3.connect('file:'+str(A/'release-integration-data/outcomes-complete.db')+'?mode=ro',uri=True);db.row_factory=sqlite3.Row
out=[]
for r in x['largestUnrestrictedBandChanges']:
 v=[dict(q) for q in db.execute('select id,bus_name,stop_id,stop_index,arrived_at,anchored_at,pinned_at,departed_at,outcome,how,closest_m from stop_visits where route_id=3 and bus_name=? and stop_id=? and anchored_at between ? and ? order by anchored_at',(r['bus'],r['target'],r['at']-180000,r['at']+7200000))]
 for q in v:q['arrivalRelativeSec']=(q['arrived_at']-r['at'])/1000 if q['arrived_at'] else None
 out.append({'forecast':r,'nearbyTargetVisits':v,'interpretation':'Nearby visits are descriptive anchors, not automatically relabeled forecast outcomes; current/second occurrence and exact chain required.'})
(O/'all-large-tail-target-context.json').write_text(json.dumps(out,indent=2)+'\n');db.close();print('Preserved nearby visit context for all',len(out),'large band changes; no outcomes relabeled.')
