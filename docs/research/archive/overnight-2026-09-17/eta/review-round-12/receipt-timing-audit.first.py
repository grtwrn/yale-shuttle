from pathlib import Path
import json,sqlite3,math
O=Path(__file__).resolve().parent
P=O.parent
cases=[c for c in json.loads((P/'cycle-6/missing-cases.json').read_text()) if c['causal']['pickupRows'][0]['hops']==29]
sources={c['sourceId']:c for c in cases}
db=sqlite3.connect('file:/home/gwarren/projects/yale-shuttle-watcher/conditional-replay-data/outcomes.db?mode=ro',uri=True)
db.row_factory=sqlite3.Row
for sid,c in sources.items():
    v=db.execute('select * from stop_visits where id=?',(sid,)).fetchone()
    assert v['route_id']==3 and v['bus_name']=='#'+c['bus'] and v['stop_id']==c['sourceStop']
    for column,key in [('anchored_at','sourceAnchoredAt'),('pinned_at','sourcePinnedAt'),('departed_at','sourceDepartedAt')]:
        assert v[column]==c['retrospective'][key]
db.close()
rows=[json.loads(l) for l in (O/'sanitized-receipts.jsonl').read_text().splitlines()]
assert len(cases)==38 and len(sources)==9 and len({(c['at'],c['bus']) for c in cases})==19
after={}
for sid,c in sources.items():
    offsets=[(r['receiptAt']-c['retrospective']['sourceDepartedAt'])/1000 for r in rows if r['sourceId']==sid and r['bus'].get('at_stop_id')==c['sourceStop'] and r['receiptAt']>c['retrospective']['sourceDepartedAt']]
    if offsets: after[sid]=max(offsets)
assert len(after)==5
source=sources[65347]; departure=source['retrospective']['sourceDepartedAt']
observed={r['bus']['observed_at']:r['bus'] for r in rows if r['sourceId']==65347}
post=sorted({(t-departure)/1000 for t,b in observed.items() if t>departure and b.get('at_stop_id')==11})
assert post==[4.975,9.99,15.137]
out_t=1789657102924;back_t=1789657112906
out=observed[out_t];back=observed[back_t]
assert out.get('at_stop_id')!=11 and back.get('at_stop_id')==11
assert out_t<back_t<departure
before_t=max(t for t,b in observed.items() if t<out_t and b.get('at_stop_id')==11)
before=observed[before_t]
assert back['at_stop_since']==before['at_stop_since']
def distance(a,b):
    p1,p2=map(math.radians,[a['lat'],b['lat']]); dlon=math.radians(b['lon']-a['lon'])
    return 6371000*2*math.asin(math.sqrt(math.sin((p2-p1)/2)**2+math.cos(p1)*math.cos(p2)*math.sin(dlon/2)**2))
excursion=distance(before,out)
assert 90<excursion<100
report=dict(sourceVisitClocksChecked=9,decisions=38,busPolls=19,postDepartureAtStopHandlerOffsetsSec=after,
    source65347FreshCollectionOffsetsSec=post,preDepartureExcursionMeters=excursion,
    preservedPin=True,scope='Retrospective transition provenance; no doors-open, live belief, first-publication or boarding inference.')
(O/'receipt-timing-audit.json').write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps(report,indent=2))
