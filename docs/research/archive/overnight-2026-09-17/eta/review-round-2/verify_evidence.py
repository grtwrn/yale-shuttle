"""Independent checks of preserved cycle-2 results. No fitting or source writes."""
import bisect
import collections
import datetime
import hashlib
import json
import math
import sqlite3
import statistics
from pathlib import Path

ROOT = Path('/home/gwarren/projects/yale-shuttle-watcher')
SRC = ROOT / 'overnight-2026-09-17/eta/cycle-2'
OUT = Path(__file__).resolve().parent
read = lambda p: json.loads(p.read_text())
labels = read(SRC / 'trace-outcomes.json')
scores = read(SRC / 'trace-scores.json')
traces = [json.loads(line) for line in (SRC / 'current-trace.jsonl').open()]
manifest = read(SRC / 'case-manifest.json')
verified_hashes = 0
for plan in ['PLAN.json', 'TRACE_PLAN.json']:
    for name, expected in read(SRC / plan)['inputs'].items():
        assert hashlib.sha256(Path(name).read_bytes()).hexdigest() == expected, name
        verified_hashes += 1
for name, expected in read(SRC / 'trace-artifact-hashes.json').items():
    assert hashlib.sha256((SRC / name).read_bytes()).hexdigest() == expected, name
    verified_hashes += 1
probe_plan = read(SRC / 'COMPONENT_PROBE_PLAN.json')
for path, expected in [(Path(probe_plan['source']), probe_plan['sourceSHA256']),
                       (SRC / 'arrival-observer.generated.mts', probe_plan['generatedObserverSHA256'])]:
    assert hashlib.sha256(path.read_bytes()).hexdigest() == expected
    verified_hashes += 1
for name in ['trace-outcomes.json', 'trace-scores.json', 'intermediate-raw-audit.json', 'component-probe.json']:
    assert read(SRC / name) == read(OUT / name), name

db = sqlite3.connect(f'file:{ROOT}/conditional-replay-data/outcomes.db?mode=ro', uri=True)
db.row_factory = sqlite3.Row
visits = {v['id']: dict(v) for v in db.execute('select * from stop_visits where route_id=3')}
legs = {v['id']: dict(v) for v in db.execute('select * from legs where route_id=3')}
seq = json.loads(db.execute('select stops_json from routes where id=3').fetchone()[0])
assert len(seq) == len(set(seq)) == 29
raw = {(r['collected_at'], r['bus_name'], r['bus_id']): dict(r)
       for r in db.execute('select * from raw_positions where route_id=3')}
db.close()
by_bus = collections.defaultdict(list)
for row in traces:
    by_bus[row['bus']].append(row)
    obs = row['observation']
    assert obs['observed_at'] <= row['at']
    actual = raw[(obs['observed_at'], row['bus'], obs['bus_id'])]
    for key in ['lat', 'lon', 'heading', 'last_stop_id', 'route_id']:
        assert actual[key] == obs[key], (row['at'], key)
    for key in ['seenAt', 'fixAt', 'restSince', 'leftSince', 'leftAt', 'serverSince']:
        value = row['state'].get(key)
        assert value is None or value <= row['at'], (key, value)
    if row['releasePin']:
        assert row['releasePin']['since'] <= row['at']
    for forecast in row['forecasts']:
        assert 0 <= forecast['low'] <= forecast['eta'] <= forecast['high']
        assert all(math.isfinite(x) for x in forecast['distribution'])
        assert len(forecast['distribution']) == 50
        assert forecast['distribution'] == sorted(forecast['distribution'])
times = {bus: [r['at'] for r in rows] for bus, rows in by_bus.items()}
for bus, ts in times.items():
    assert ts == sorted(set(ts)), bus

chain_count = leg_count = 0
shared_targets = collections.defaultdict(set)
for case in labels['cases']:
    source = visits[case['sourceId']]
    assert source == case['source']
    for endpoint in case['endpoints']:
        index, departed = source['stop_index'], source['departed_at']
        hops = 0
        elapsed_ms = 0
        for p in endpoint['path']:
            leg, visit = legs[p['leg']['id']], visits[p['visit']['id']]
            assert leg == p['leg'] and visit == p['visit']
            assert leg['bus_name'] == visit['bus_name'] == source['bus_name']
            assert leg['from_index'] == index and leg['departed_at'] == departed
            assert leg['from_stop_id'] == seq[index]
            assert leg['reached'] == 1 and leg['arrived_at'] > departed
            assert (leg['to_index'] - index) % 29 == leg['hops']
            assert leg['to_stop_id'] == seq[leg['to_index']] == visit['stop_id']
            assert leg['arrived_at'] == visit['arrived_at'] or (
                visit['outcome'] == 'passed' and leg['arrived_at'] == visit['departed_at'])
            assert visit['how'] != 'gap'
            assert source['anchored_at'] <= visit['anchored_at'] <= leg['arrived_at']
            hops += leg['hops']
            elapsed_ms += leg['arrived_at'] - leg['departed_at']
            if p is not endpoint['path'][-1]:
                assert visit['departed_at'] is not None and visit['departed_at'] >= leg['arrived_at']
                elapsed_ms += visit['departed_at'] - leg['arrived_at']
            index, departed = leg['to_index'], visit['departed_at']
            leg_count += 1
        target = visits[endpoint['outcome']['id']]
        assert target == endpoint['outcome']
        assert target['id'] == endpoint['path'][-1]['visit']['id']
        assert target['closest_m'] <= 75 and target['outcome'] in ('stopped', 'passed')
        assert hops == (seq.index(endpoint['target']) - source['stop_index']) % 29 + 29 * endpoint['occurrence']
        elapsed_ms += target['arrived_at'] - endpoint['path'][-1]['leg']['arrived_at']
        assert elapsed_ms == target['arrived_at'] - source['departed_at']
        if endpoint['occurrence']:
            first = next(e for e in case['endpoints'] if e['target'] == endpoint['target'] and not e['occurrence'])
            assert not [v for v in visits.values() if v['bus_name'] == source['bus_name']
                        and v['stop_id'] == endpoint['target'] and v['arrived_at'] is not None
                        and first['outcome']['arrived_at'] < v['arrived_at'] < target['arrived_at']]
        shared_targets[target['id']].add(case['sourceId'])
        chain_count += 1

# Independently enumerate every requested checkpoint and pair it to the first
# available actual poll and the correct occurrence; no saved score-row selection.
expected, missing = {}, set()
for case in labels['cases']:
    source = case['source']
    asks = [('standing', e, source['pinned_at'] + 1000*e) for e in (0, 60, 180, 300)
            if source['pinned_at'] + 1000*e < source['departed_at']]
    asks += [('departure', e, source['departed_at'] + 1000*e) for e in (0, 15, 60)]
    for ep in case['endpoints']:
        first = next(e for e in case['endpoints'] if e['target'] == ep['target'] and not e['occurrence'])
        for phase, e, at in asks:
            if at >= first['outcome']['arrived_at']:
                continue
            key = case['sourceId'], ep['target'], ep['occurrence'], phase, e
            i = bisect.bisect_left(times[case['bus']], at)
            row = by_bus[case['bus']][i] if i < len(times[case['bus']]) else None
            good = row and row['at'] <= at+15000 and row['warmMs'] >= 600000
            good = good and row['observedAt'] is not None and row['at']-row['observedAt'] < 45000
            good = good and row['at'] < first['outcome']['arrived_at']
            good = good and (phase != 'standing' or row['at'] < source['departed_at'])
            candidates = [] if not good else [f for f in row['forecasts'] if f['target'] == ep['target']
                          and 29*ep['occurrence'] < f['stopsAhead'] < 29*(ep['occurrence']+1)]
            assert len(candidates) <= 1
            if not candidates:
                missing.add(key)
                continue
            expected[key] = (row['at'], candidates[0], (ep['outcome']['arrived_at']-row['at'])/1000)
saved = {(r['sourceId'], r['target'], r['occurrence'], r['phase'], r['checkpointSec']): r
         for r in scores['checkpoints']}
assert set(saved) == set(expected) and len(saved) == len(scores['checkpoints'])
saved_missing = {(r['sourceId'], r['target'], r['occurrence'], r['phase'], r['checkpointSec'])
                 for r in scores['missingForecasts']}
assert saved_missing == missing
for key, (at, forecast, truth) in expected.items():
    r = saved[key]
    assert (r['at'], r['current'], r['truthSec']) == (at, forecast, truth)
    assert r['errorPredictedMinusActual'] == forecast['eta'] - truth

def metrics(rows):
    if not rows:
        return {'n': 0}
    ae = sorted(abs(r['current']['eta']-r['truthSec']) for r in rows)
    pos = (len(ae)-1)*.9
    lo = math.floor(pos)
    p90 = ae[lo] + (pos-lo)*(ae[min(lo+1, len(ae)-1)]-ae[lo])
    wis = []
    for r in rows:
        f, y = r['current'], r['truthSec']
        interval_score = f['high']-f['low'] + 10*max(0, f['low']-y) + 10*max(0, y-f['high'])
        wis.append((.5*abs(f['eta']-y)+.1*interval_score)/1.5)
    return dict(n=len(rows), sources=len({r['sourceId'] for r in rows}), targets=len({r['targetVisitId'] for r in rows}),
                maeSec=statistics.mean(ae), medianAbsSec=statistics.median(ae), p90AbsSec=p90,
                WIS=statistics.mean(wis), widthSec=statistics.mean(r['current']['high']-r['current']['low'] for r in rows),
                early=sum(r['truthSec'] < r['current']['low'] for r in rows), late=sum(r['truthSec'] > r['current']['high'] for r in rows))
for group, strata in scores['selectedMetrics'].items():
    target, occurrence = map(int, group.split('/'))
    rows = [r for r in saved.values() if r['target'] == target and r['occurrence'] == occurrence]
    for stratum, actual in strata.items():
        wanted = metrics([r for r in rows if stratum == 'all' or r['targetOutcome'] == 'stopped'])
        assert actual.keys() == wanted.keys()
        for field, value in wanted.items():
            assert math.isclose(value, actual[field], rel_tol=1e-12, abs_tol=1e-9), (group, stratum, field)

archive_count = 0
exact = {(r['bus'], r['at']): r for r in traces}
for c in manifest['selection']:
    for old in c['allCheckpoints']:
        row = exact[c['visit']['bus_name'], old['at']]
        f, = [f for f in row['forecasts'] if f['target'] == old['target'] and 0 < f['stopsAhead'] < 29]
        assert all(f[k] == old['candidate'][k] for k in ('eta', 'low', 'high'))
        archive_count += 1

summary = dict(frozenHashChecks=verified_hashes, rawDatabaseObservationMatches=len(traces),
               connectedEndpoints=chain_count, connectedLegRecordChecks=leg_count,
               firstDestinationEndpoints=sum(e['target'] != 11 and e['occurrence'] == 0 for c in labels['cases'] for e in c['endpoints']),
               secondDestinationEndpoints=sum(e['occurrence'] == 1 for c in labels['cases'] for e in c['endpoints']),
               missingChains=len(labels['missing']), independentlyEnumeratedCheckpoints=len(saved),
               independentlyEnumeratedMissingForecasts=len(missing), archivedForecastMatches=archive_count,
               independentlyRecomputedMetricGroups=8,
               sharedTargetVisits={str(k): sorted(v) for k, v in shared_targets.items() if len(v)>1})
(OUT / 'evidence-check.json').write_text(json.dumps(summary, indent=2)+'\n')
print(json.dumps(summary, indent=2))
