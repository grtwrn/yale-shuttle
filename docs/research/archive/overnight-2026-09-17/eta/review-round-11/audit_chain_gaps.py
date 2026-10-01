"""Explain unresolved identity links without filling gaps or changing labels."""
from pathlib import Path
import collections,json,sqlite3
O=Path(__file__).resolve().parent;P=O.parent
rows=json.loads((O/'alternative-outcomes.json').read_text())
db=sqlite3.connect('file:'+str(P.parents[1]/'conditional-replay-data/outcomes.db')+'?mode=ro',uri=True);db.row_factory=sqlite3.Row
seq=json.loads(db.execute('select stops_json from routes where id=3').fetchone()[0]);N=len(seq)
visits={v['id']:dict(v) for v in db.execute('select * from stop_visits where route_id=3')}
legs=collections.defaultdict(list)
for l in db.execute('select * from legs where route_id=3'):legs[l['bus_name'],l['from_index'],l['departed_at']].append(dict(l))
out=[];seen=set()
for r in rows:
    a=r['alternative']
    if 'unresolved' not in a or (r['sourceId'],a['predecessorVisitId']) in seen:continue
    seen.add((r['sourceId'],a['predecessorVisitId']));v=visits[a['predecessorVisitId']];start=v
    target=visits[r['sourceId']]['stop_id'];remaining=(seq.index(target)-v['stop_index'])%N or N
    trace=[]
    while remaining:
        candidates=legs[v['bus_name'],v['stop_index'],v['departed_at']]
        if len(candidates)!=1:
            trace.append(dict(reason='missing or ambiguous exact outgoing leg',visit=v,legIds=[l['id'] for l in candidates]));break
        l=candidates[0]
        matches=[x for x in visits.values() if x['bus_name']==v['bus_name'] and x['stop_index']==l['to_index']
                 and (x['arrived_at']==l['arrived_at'] or (x['outcome']=='passed' and x['departed_at']==l['arrived_at']))
                 and start['anchored_at']<=x['anchored_at']<=l['arrived_at']]
        if len(matches)!=1:
            nearby=[{k:x[k] for k in ['id','stop_id','stop_index','anchored_at','arrived_at','departed_at','outcome','how']}
                    for x in visits.values() if x['bus_name']==v['bus_name'] and x['stop_index']==l['to_index']
                    and abs(x['anchored_at']-l['arrived_at'])<120000]
            trace.append(dict(reason='missing or ambiguous exact arrival visit',leg=l,matches=[x['id'] for x in matches],nearbyForDiagnosisOnly=nearby));break
        nxt=matches[0];trace.append(dict(legId=l['id'],visitId=nxt['id'],stop=nxt['stop_id']))
        remaining-=l['hops']
        if remaining and nxt['departed_at'] is None:
            trace.append(dict(reason='missing intermediate departure',visit=nxt));break
        v=nxt
    out.append(dict(focalSourceId=r['sourceId'],alternativeBus=a['bus'],predecessorVisitId=a['predecessorVisitId'],
                    cases=sum(x['sourceId']==r['sourceId'] and 'unresolved' in x['alternative'] for x in rows),trace=trace))
db.close();assert sum(x['cases'] for x in out)==6
(O/'unresolved-chain-audit.json').write_text(json.dumps({'groups':out,'decision':'All six remain unresolved; nearby records are not substituted. No measurement-error exclusion or database repair is established.'},indent=2)+'\n')
print(json.dumps(out,indent=2))
