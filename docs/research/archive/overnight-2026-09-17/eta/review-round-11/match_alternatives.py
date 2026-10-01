"""Retrospective alternative outcomes; never generates forecast inputs."""
from pathlib import Path
import ast, collections, datetime, gzip, hashlib, json, math, sqlite3, statistics

O = Path(__file__).resolve().parent
P = O.parent
ROOT = P.parents[1]
load = lambda p: json.loads(p.read_text())
for name, want in load(O/'PLAN.json')['inputHashes'].items():
    assert hashlib.sha256(Path(name).read_bytes()).hexdigest() == want, name
cases = [c for c in load(P/'cycle-6/missing-cases.json') if c['causal']['pickupRows'][0]['hops'] == 29]
assert len(cases) == 38
arms = {name: {(r['session'], r['at']): r for r in map(json.loads, (P/f'cycle-6/{name}-decisions.jsonl').open())}
        for name in ['ordered', 'fallthrough']}
frames = {f['at']: f for f in map(json.loads, gzip.open(P/'cycle-5/traversal-guard/fleet-wire.jsonl.gz', 'rt'))}
dbpath = ROOT/'conditional-replay-data/outcomes.db'
db = sqlite3.connect('file:'+str(dbpath)+'?mode=ro', uri=True)
db.row_factory = sqlite3.Row
seq = json.loads(db.execute('select stops_json from routes where id=3').fetchone()[0])
N = len(seq)
visits = [dict(v) for v in db.execute('select * from stop_visits where route_id=3')]
legs = [dict(l) for l in db.execute('select * from legs where route_id=3')]
byid = {v['id']: v for v in visits}
by_leg, by_visit = collections.defaultdict(list), collections.defaultdict(list)
for l in legs: by_leg[l['bus_name'], l['from_index'], l['departed_at']].append(l)
for v in visits:
    for t in {v['arrived_at'], *([v['departed_at']] if v['outcome'] == 'passed' else [])}:
        if t is not None: by_visit[v['bus_name'], v['stop_id'], v['stop_index'], t].append(v)
tree = ast.parse((P/'cycle-2/trace_outcomes.py').read_text())
fn = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == 'connect')
exec(compile(ast.Module(body=[fn], type_ignores=[]), '<reviewed connect only>', 'exec'))

def summarize(rows):
    scored = [r for r in rows if r['alternative'].get('errorSec') is not None]
    e = [abs(r['alternative']['errorSec']) for r in scored]
    before = [r for r in scored if r['focal']['availableByRecordedDeparture']]
    return dict(n=len(rows), scored=len(scored), unavailable=len(rows)-len(scored),
        focalSources=len({r['sourceId'] for r in rows}), busPolls=len({(r['at'],r['focal']['bus']) for r in rows}),
        alternativeSourceVisits=len({r['alternative']['sourceVisitId'] for r in scored}),
        maeSec=statistics.mean(e) if e else None, p90AbsSec=sorted(e)[math.ceil(.9*len(e))-1] if e else None,
        maxAbsSec=max(e, default=None), earlyMisses=sum(r['alternative']['earlyMiss'] for r in scored),
        lateMisses=sum(r['alternative']['lateMiss'] for r in scored),
        beforeFocalDeparture=sum(r['focal']['availableByRecordedDeparture'] for r in rows), beforeFocalDepartureScored=len(before),
        afterFocalDeparture=sum(not r['focal']['availableByRecordedDeparture'] for r in rows),
        alternativeArrivesLaterThanFocal=sum(r['alternative']['actualArrivalDifferenceFromFocalSec'] > 0 for r in before),
        meanArrivalDifferenceSec=statistics.mean(r['alternative']['actualArrivalDifferenceFromFocalSec'] for r in before) if before else None,
        hypotheticalWalkFaster=sum(r['alternative']['actualConnectedSec'] > r['directWalkSec'] for r in scored))

results = []
for c in cases:
    key = c['session'], c['at']; at = c['at']; original = arms['ordered'][key]['option']; diagnostic = arms['fallthrough'][key]
    trace = next(t for t in diagnostic['trace'] if t['kind'] == 'journey')
    b, target = trace['board'], trace['destination']; alt = diagnostic['option']; name = '#'+b['busName']
    assert original.get('journeyArrival') is None and alt['journeyArrival']['busName'] == b['busName']
    assert original['busName'] != b['busName'] and original['walkToSec'] == alt['walkToSec'] == 0
    f = frames[at]; wire = f['server_eta']; bi = next(i for i, x in enumerate(wire['buses']) if x[0] == b['busName'])
    lead = wire['buses'][bi][2]
    expected_hops = (seq.index(c['sourceStop']) - lead) % N or N
    assert b['stopsAhead'] == expected_hops
    assert target['stopsAhead'] - b['stopsAhead'] == (seq.index(c['target']) - seq.index(c['sourceStop'])) % N
    raw = next(x for x in f['buses'] if x['bus_name'] == name)
    rawdb = db.execute('select lat,lon,heading,route_id from raw_positions where bus_name=? and collected_at=?', (name, at)).fetchall()
    assert len(rawdb) == 1 and all(rawdb[0][k] == raw[k] for k in ['lat','lon','heading','route_id'])
    assert raw['route_id'] == 3
    focal = byid[c['sourceId']]
    current = sorted([v for v in visits if v['bus_name'] == name and v['anchored_at'] <= at], key=lambda v: (v['anchored_at'],v['id']))[-1]
    potential = sorted([v for v in visits if v['bus_name'] == name and v['stop_id'] == c['sourceStop']
                        and v['anchored_at'] >= current['anchored_at'] and (v['departed_at'] is None or v['departed_at'] >= at)],
                       key=lambda v: (v['anchored_at'],v['id']))
    record = dict(session=key[0], at=at, sourceId=c['sourceId'], target=c['target'],
        date=datetime.datetime.fromtimestamp(at/1000,datetime.timezone.utc).strftime('%Y-%m-%d'),
        focal=dict(bus=c['bus'], availableByRecordedDeparture=at<=focal['departed_at'],
                   originalTotalSec=original['totalSec'], actualConnectedSec=c['retrospective']['actualConnectedSec'],
                   targetVisitId=c['retrospective']['targetVisit'], sourceDepartedAt=focal['departed_at']),
        directWalkSec=original['directWalkSec'],
        alternative=dict(bus=b['busName'], totalSec=alt['totalSec'], boardHops=b['stopsAhead'], destinationHops=target['stopsAhead'],
                         servedLead=lead, predecessorVisitId=current['id'], sourceVisitId=potential[0]['id'] if potential else None),
        occurrences=[])
    a = record['alternative']
    assert current['how'] != 'gap'
    before, err = connect(current, c['sourceStop'], current['stop_id'] == c['sourceStop'])
    if err: a['unresolved'] = 'predecessor-to-source: '+err
    elif not potential or before[-1]['visit']['id'] != potential[0]['id']: a['unresolved'] = 'chronological and connected source disagree'
    else:
        source = potential[0]; a['predecessorLegIds'] = [p['leg']['id'] for p in before]
        chain, err = connect(source, c['target'])
        if err: a['unresolved'] = 'source-to-target: '+err
        else:
            endpoint = chain[-1]['visit']; actual = (endpoint['arrived_at']-at)/1000 + alt['walkFromSec']; j = alt['journeyArrival']
            assert sum(p['leg']['hops'] for p in chain) == target['stopsAhead']-b['stopsAhead']
            a.update(targetVisitId=endpoint['id'], legIds=[p['leg']['id'] for p in chain], sourceArrivedAt=source['arrived_at'],
                     sourceDepartedAt=source['departed_at'], actualPickupSec=(source['arrived_at']-at)/1000,
                     actualConnectedSec=actual, errorSec=alt['totalSec']-actual,
                     earlyMiss=endpoint['arrived_at']+alt['walkFromSec']*1000<j['lowMs'],
                     lateMiss=endpoint['arrived_at']+alt['walkFromSec']*1000>j['highMs'],
                     intervalWidthSec=(j['highMs']-j['lowMs'])/1000,
                     actualArrivalDifferenceFromFocalSec=actual-c['retrospective']['actualConnectedSec'])
            # Audit the corresponding next pickup and destination even when not served.
            next_chain, next_err = connect(source, c['sourceStop'], True)
            next_source = next_chain[-1]['visit'] if next_chain else None
            next_target_chain, next_target_err = connect(next_source, c['target']) if next_source else (None, 'next source unavailable')
            for label, stop, hops, visit, error in [
                ('pickup-1', c['sourceStop'], b['stopsAhead'], source, None),
                ('destination-1', c['target'], target['stopsAhead'], endpoint, None),
                ('pickup-2', c['sourceStop'], b['stopsAhead']+N, next_source, next_err),
                ('destination-2', c['target'], target['stopsAhead']+N, next_target_chain[-1]['visit'] if next_target_chain else None, next_target_err),
            ]:
                wr = [x for x in wire['rows'] if x[0] == bi and x[1] == stop and x[5] == hops]
                assert len(wr) <= 1
                record['occurrences'].append(dict(kind=label, hops=hops, forecastAvailable=bool(wr),
                    visitId=visit['id'] if visit else None, outcomeUnavailable=error,
                    predictedSec=wr[0][2] if wr else None, actualSec=(visit['arrived_at']-at)/1000 if visit else None,
                    connectedLegIds=([p['leg']['id'] for p in next_chain] + ([p['leg']['id'] for p in next_target_chain] if next_target_chain else []))
                        if label == 'destination-2' and next_chain else None))
    if not record['occurrences']:
        for label, stop, hops in [('pickup-1', c['sourceStop'], b['stopsAhead']),
                                 ('destination-1', c['target'], target['stopsAhead']),
                                 ('pickup-2', c['sourceStop'], b['stopsAhead']+N),
                                 ('destination-2', c['target'], target['stopsAhead']+N)]:
            wr = [x for x in wire['rows'] if x[0] == bi and x[1] == stop and x[5] == hops]
            assert len(wr) <= 1
            record['occurrences'].append(dict(kind=label, hops=hops, forecastAvailable=bool(wr),
                visitId=None, outcomeUnavailable=a['unresolved'], predictedSec=wr[0][2] if wr else None,
                actualSec=None, connectedLegIds=None))
    results.append(record)
db.close()
assert len(results) == 38
summary = dict(overall=summarize(results), byDate={d:summarize([r for r in results if r['date']==d]) for d in sorted({r['date'] for r in results})},
    byFocalSource={str(s):summarize([r for r in results if r['sourceId']==s]) for s in sorted({r['sourceId'] for r in results})},
    unresolved=dict(collections.Counter(r['alternative']['unresolved'] for r in results if 'unresolved' in r['alternative'])),
    occurrenceAvailability={k:dict(rows=len(xs), forecasts=sum(x['forecastAvailable'] for x in xs), outcomes=sum(x['visitId'] is not None for x in xs))
                           for k in ['pickup-1','destination-1','pickup-2','destination-2']
                           for xs in [[x for r in results for x in r['occurrences'] if x['kind']==k]]},
    databaseSHA256=hashlib.sha256(dbpath.read_bytes()).hexdigest(),
    limitations=load(O/'OUTCOME_PLAN.json')['limits'])
(O/'alternative-outcomes.json').write_text(json.dumps(results,indent=2)+'\n')
(O/'alternative-summary.json').write_text(json.dumps(summary,indent=2)+'\n')
print(json.dumps(summary,indent=2))
