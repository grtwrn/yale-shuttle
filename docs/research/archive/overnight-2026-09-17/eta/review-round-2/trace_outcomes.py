"""Exact connected outcome labels, isolated from current-code forecasting."""
import collections
import datetime
import hashlib
import json
import sqlite3
from pathlib import Path

ROOT = Path('/home/gwarren/projects/yale-shuttle-watcher')
OUT = Path('/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/cycle-2')
db = sqlite3.connect('file:' + str(ROOT / 'conditional-replay-data/outcomes.db') + '?mode=ro', uri=True)
db.row_factory = sqlite3.Row
seq = json.loads(db.execute('SELECT stops_json FROM routes WHERE id=3').fetchone()[0])
N = len(seq)
assert N == 29 and len(set(seq)) == N
manifest = json.loads((OUT / 'case-manifest.json').read_text())
visits = [dict(v) for v in db.execute('SELECT * FROM stop_visits WHERE route_id=3')]
by_id = {v['id']: v for v in visits}
legs = [dict(l) for l in db.execute('SELECT * FROM legs WHERE route_id=3')]
db.close()
by_leg = collections.defaultdict(list)
by_visit = collections.defaultdict(list)
for l in legs:
    by_leg[l['bus_name'], l['from_index'], l['departed_at']].append(l)
for v in visits:
    times = {v['arrived_at']}
    if v['outcome'] == 'passed': times.add(v['departed_at'])
    for t in times:
        if t is not None: by_visit[v['bus_name'], v['stop_id'], v['stop_index'], t].append(v)

def connect(s, target, full_lap=False):
    index, dep = s['stop_index'], s['departed_at']
    remaining = (seq.index(target) - index) % N
    if full_lap: remaining = N
    if not remaining or dep is None: return None, 'same source or missing departure'
    path = []
    for _ in seq:
        ls = by_leg[s['bus_name'], index, dep]
        if len(ls) != 1: return None, 'missing or ambiguous connected leg'
        l = ls[0]
        if not (l['reached'] == 1 and l['from_stop_id'] == seq[index] and
                l['to_stop_id'] == seq[l['to_index']] and l['arrived_at'] > dep and
                1 <= l['hops'] <= remaining and (l['to_index'] - index) % N == l['hops']):
            return None, 'invalid route/time or skipped target'
        vs = [v for v in by_visit[s['bus_name'], l['to_stop_id'], l['to_index'], l['arrived_at']]
              if s['anchored_at'] <= v['anchored_at'] <= l['arrived_at']]
        if len(vs) != 1: return None, 'missing or ambiguous connected visit'
        v = vs[0]
        if v['how'] == 'gap': return None, 'gap-resolved visit'
        path.append(dict(leg=l, visit=v))
        remaining -= l['hops']
        if not remaining:
            if not (v['stop_id'] == target and v['arrived_at'] is not None and
                    v['outcome'] in ['stopped', 'passed'] and v['closest_m'] <= 75):
                return None, 'unsupported target'
            return path, None
        if v['departed_at'] is None or v['departed_at'] < l['arrived_at']:
            return None, 'missing intermediate departure'
        index, dep = l['to_index'], v['departed_at']
    return None, 'incomplete route chain'

results, missing = [], []
for c in manifest['selection']:
    s = by_id[c['sourceId']]
    for key, value in c['visit'].items():
        if key in s: assert s[key] == value
    record = dict(sourceId=s['id'], sourceStop=s['stop_id'], bus=s['bus_name'], source=s, endpoints=[])
    for target in [48, 4] + ([11] if s['stop_id'] == 121 else []):
        path, err = connect(s, target)
        if err:
            missing.append(dict(sourceId=s['id'], target=target, occurrence=0, reason=err)); continue
        first = path[-1]['visit']
        if target != 11:
            old = next(j for j in c['journeys'] if j['target'] == target)
            assert old['targetVisitId'] == first['id']
            assert old['targetArrivedAt'] == first['arrived_at']
            assert old['legIds'] == [p['leg']['id'] for p in path]
        record['endpoints'].append(dict(target=target, occurrence=0, outcome=first, path=path))
        if target == 11: continue
        second_path, err = connect(first, target, True)
        if err:
            missing.append(dict(sourceId=s['id'], target=target, occurrence=1, reason=err)); continue
        second = second_path[-1]['visit']
        intervening = [v for v in visits if v['bus_name'] == s['bus_name'] and v['stop_id'] == target and
                       v['arrived_at'] is not None and first['arrived_at'] < v['arrived_at'] < second['arrived_at']]
        assert not intervening
        assert sum(p['leg']['hops'] for p in second_path) == N
        record['endpoints'].append(dict(target=target, occurrence=1, outcome=second, path=path + second_path))
    if s['stop_id'] == 121:
        endpoint = next(e for e in record['endpoints'] if e['target'] == 11)
        path = endpoint['path']; win = endpoint['outcome']
        intervals = []
        for i, p in enumerate(path):
            l, v = p['leg'], p['visit']
            elapsed = (l['arrived_at'] - l['departed_at']) / 1000
            assert abs(elapsed - l['leg_sec']) < 1e-8
            residence = (v['departed_at'] - l['arrived_at']) / 1000 if i + 1 < len(path) else 0
            intervals.append(dict(legId=l['id'], fromStop=l['from_stop_id'], toStop=l['to_stop_id'],
                legElapsedSec=elapsed, recordedWithinLegHoldSec=l['hold_sec'],
                recordedWithinLegDriveSec=l['drive_sec'], visitId=v['id'],
                betweenLegResidenceSec=residence, visitOutcome=v['outcome'],
                anchorToPinSec=(v['pinned_at'] - v['anchored_at']) / 1000 if v['pinned_at'] else None))
        leg_seconds = sum(x['legElapsedSec'] for x in intervals)
        residence = sum(x['betweenLegResidenceSec'] for x in intervals)
        adjustment = (win['pinned_at'] - path[-1]['leg']['arrived_at']) / 1000
        total = (win['pinned_at'] - s['departed_at']) / 1000
        assert abs(total - leg_seconds - residence - adjustment) < 1e-8
        record['preWinchester'] = dict(pinElapsedSec=total, legElapsedSec=leg_seconds,
            withinLegHoldSec=sum(x['recordedWithinLegHoldSec'] for x in intervals),
            withinLegDriveSec=sum(x['recordedWithinLegDriveSec'] for x in intervals),
            betweenLegResidenceSec=residence, pinEndpointAdjustmentSec=adjustment,
            winchesterHoldSec=(win['departed_at'] - win['pinned_at']) / 1000, intervals=intervals)
    # Complete elapsed-time identity for every first/second occurrence.
    for endpoint in record['endpoints']:
        ps = endpoint['path']
        elapsed = sum((p['leg']['arrived_at'] - p['leg']['departed_at']) / 1000 for p in ps)
        residence = sum((b['leg']['departed_at'] - a['leg']['arrived_at']) / 1000 for a, b in zip(ps, ps[1:]))
        adjustment = (endpoint['outcome']['arrived_at'] - ps[-1]['leg']['arrived_at']) / 1000
        assert abs((endpoint['outcome']['arrived_at'] - s['departed_at']) / 1000 - elapsed - residence - adjustment) < 1e-8
    results.append(record)
report = dict(scope='Retrospective outcome labels only; never forecast inputs. Within-leg split is recorded detector evidence, not inferred from legacy arrivals dwell.',
              cases=results, missing=missing, connectedEndpoints=sum(len(c['endpoints']) for c in results),
              databaseSHA256=hashlib.sha256((ROOT/'conditional-replay-data/outcomes.db').read_bytes()).hexdigest())
(Path('/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/review-round-2/trace-outcomes.json')).write_text(json.dumps(report, indent=2)+'\n')
print(json.dumps(dict(connectedEndpoints=report['connectedEndpoints'], missing=missing,
                     summaries=[dict(sourceId=c['sourceId'], **{k:v for k,v in c['preWinchester'].items() if k!='intervals'}) for c in results if 'preWinchester' in c]), indent=2))
