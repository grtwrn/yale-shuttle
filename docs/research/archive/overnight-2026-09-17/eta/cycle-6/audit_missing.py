"""Classify saved served inputs; retrospective labels never enter forecasts."""
import ast, collections, datetime, gzip, hashlib, json, math, sqlite3
from pathlib import Path

O = Path(__file__).resolve().parent
B = O.parent / 'cycle-5/traversal-guard'
ROOT = O.parents[2]
plan = json.loads((O/'PLAN.json').read_text())
for p, expected in plan['inputs'].items():
    assert hashlib.sha256(Path(p).read_bytes()).hexdigest() == expected, p
frames = {f['at']: f for f in map(json.loads, gzip.open(B/'fleet-wire.jsonl.gz', 'rt'))}
rows = list(map(json.loads, (B/'decisions.jsonl').open()))
payload = json.loads((B/'calibration-payload.json').read_text())
db = sqlite3.connect('file:'+str(ROOT/'conditional-replay-data/outcomes.db')+'?mode=ro', uri=True)
db.row_factory = sqlite3.Row
seq = json.loads(db.execute('select stops_json from routes where id=3').fetchone()[0])
N = len(seq)
visits = [dict(v) for v in db.execute('select * from stop_visits where route_id=3')]
legs = [dict(l) for l in db.execute('select * from legs where route_id=3')]
byid = {v['id']:v for v in visits}
by_leg, by_visit = collections.defaultdict(list), collections.defaultdict(list)
for l in legs: by_leg[l['bus_name'], l['from_index'], l['departed_at']].append(l)
for v in visits:
    for t in {v['arrived_at'], *([v['departed_at']] if v['outcome']=='passed' else [])}:
        if t is not None: by_visit[v['bus_name'], v['stop_id'], v['stop_index'], t].append(v)
tree = ast.parse((O.parent/'cycle-2/trace_outcomes.py').read_text())
fn = next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='connect')
exec(compile(ast.Module(body=[fn],type_ignores=[]),'<reviewed connect only>', 'exec'))

def distance(a,b):
    p,q = math.radians(a['lat']),math.radians(b['lat'])
    h = math.sin((q-p)/2)**2 + math.cos(p)*math.cos(q)*math.sin(math.radians(b['lon']-a['lon'])/2)**2
    return 6371000*2*math.asin(math.sqrt(h))

out, reasons, post, source_counts = [], collections.Counter(), collections.Counter(), collections.Counter()
gps_checks = 0
for r in rows:
    o = next(o for o in r['options'] if o['mode']=='shuttle')
    if o.get('journeyArrival'): continue
    trace = next(t for t in r['trace'] if t['kind']=='journey')
    assert not trace.get('board') and not trace.get('destination')
    f = frames[r['at']]; w = f['server_eta']; s = byid[r['sourceId']]
    bi = next(i for i,b in enumerate(w['buses']) if b[0]==o['busName'])
    bus = next(b for b in f['buses'] if b['bus_name'].lstrip('#')==o['busName'])
    assert bus['at_stop_id']==o['boardStopId']==s['stop_id']
    assert bus['bus_name']==s['bus_name'] and r['offsetM']==0 and o['walkToSec']==0
    def wire_rows(stop):
        return sorted([dict(stopId=x[1],eta=x[2],low=max(0,x[3]),high=max(0,x[4]),hops=x[5],distribution=w['distributions'][i])
                       for i,x in enumerate(w['rows']) if x[0]==bi and x[1]==stop],key=lambda x:x['hops'])
    boards, targets = wire_rows(o['boardStopId']), wire_rows(o['alightStopId'])
    assert boards and targets and not any(b['hops']==0 for b in boards)
    if boards[0]['hops'] < targets[0]['hops']:
        reason='modeled pickup still ahead before first destination'
        assert boards[0]['hops']==1
    else:
        reason='only next-lap pickup; first destination precedes it'
        assert boards[0]['hops']==N
    raw = [dict(x) for x in db.execute('select * from raw_positions where bus_name=? and collected_at=?',(bus['bus_name'],r['at']))]
    assert len(raw)==1 and all(raw[0][k]==bus[k] for k in ['lat','lon','heading','route_id'])
    gps_checks += 1
    path, err = connect(s,o['alightStopId']); assert not err, err
    endpoint = path[-1]['visit']; hops = sum(p['leg']['hops'] for p in path)
    # h=1 is an approach to this source, h=N is its NEXT lap. Never attach
    # this source's first destination to that next-lap boarding occurrence.
    assert targets[0]['hops'] == hops + (1 if boards[0]['hops']==1 else 0)
    after = r['at'] > s['departed_at']
    reasons[reason]+=1; post[str(after)]+=1; source_counts[str(s['id'])]+=1
    truth=(endpoint['arrived_at']-r['at'])/1000+o['walkFromSec']
    out.append(dict(session=r['session'],at=r['at'],sourceId=s['id'],bus=o['busName'],sourceStop=s['stop_id'],target=o['alightStopId'],
        causal=dict(reason=reason,rawBus=bus,servedPosition=w['buses'][bi][2:],pickupRows=boards,destinationRows=targets,
                    distanceToStopM=distance(bus,payload['stop_coords'][str(s['stop_id'])]),fallbackTotalSec=o['totalSec']),
        retrospective=dict(sourceAnchoredAt=s['anchored_at'],sourcePinnedAt=s['pinned_at'],sourceDepartedAt=s['departed_at'],afterRecordedDeparture=after,
            secondsToRecordedDeparture=(s['departed_at']-r['at'])/1000,targetVisit=endpoint['id'],targetArrivedAt=endpoint['arrived_at'],
            legIds=[p['leg']['id'] for p in path],routeHops=hops,actualConnectedSec=truth,
            fallbackErrorSec=o['totalSec']-truth,sourceBoardingAvailableAtPoll=not after)))
db.close()
assert len(rows)==4688 and len(out)==68 and len({(r['at'],r['bus']) for r in out})==34
summary=dict(decisions=len(rows),missing=len(out),distinctBusPolls=34,distinctSources=len(source_counts),sessions=len({r['session'] for r in out}),
             reasons=dict(reasons),afterRecordedDeparture=dict(post),sourceCounts=dict(source_counts),exactRawGpsChecks=gps_checks,
             crossTab={reason:dict(collections.Counter('after recorded departure' if x['retrospective']['afterRecordedDeparture'] else 'before recorded departure'
                          for x in out if x['causal']['reason']==reason)) for reason in reasons},
             limits='Selected reused Red history; reconstructed collector flags; recorded departure is retrospective. Both destination occurrences retained where served; no new outcome exclusions. All access walks are zero in these missing cases.')
(O/'missing-cases.json').write_text(json.dumps(out,indent=2)+'\n')
(O/'missing-summary.json').write_text(json.dumps(summary,indent=2)+'\n')
print(json.dumps(summary,indent=2))
