"""Causal Red layover covariates, scored on later days. Requires numpy.

Usage: python3 lap-spacing-audit.py REPLAY_DB PAYLOAD WATCHER_DIR OUTPUT
GPS spacing is directed route distance expressed as a fraction of a typical
lap, not a future observed arrival. No neighbour's future arrival is a feature.
"""
import bisect
import collections
import datetime as dt
import json
from pathlib import Path
import sqlite3
import sys
import numpy as np

db_path, payload_path, watcher_dir, output = sys.argv[1:]
payload = json.loads(Path(payload_path).read_text())
xy = np.array(payload['route_paths']['3']) * np.array([111195., 83500.])
starts, vec = xy[:-1], np.diff(xy, axis=0)
lengths = np.linalg.norm(vec, axis=1)
den = np.maximum(lengths ** 2, 1e-6)
offset = np.r_[0., np.cumsum(lengths)]
lap_m = offset[-1]

def progress(bus):
    point = np.array([bus['lat'] * 111195., bus['lon'] * 83500.])
    frac = np.clip(((point - starts) * vec).sum(axis=1) / den, 0, 1)
    dist = np.linalg.norm(starts + frac[:, None] * vec - point, axis=1)
    index = int(np.argmin(dist))
    return None if dist[index] > 100 else float(offset[index] + frac[index] * lengths[index])

frames = {}
for file in sorted(Path(watcher_dir).glob('samples*.jsonl')):
    for line in file.open():
        try:
            f = json.loads(line)
            t = int(dt.datetime.fromisoformat(f['at']).timestamp() * 1000)
            buses = [b for b in f.get('buses', []) if b.get('route_id') == 3]
            if buses and f.get('feedAgeMs', 999999) <= 20000:
                frames[t] = buses
        except (ValueError, KeyError):
            continue
times = sorted(frames)
db = sqlite3.connect(db_path)
db.row_factory = sqlite3.Row
visits = [dict(r) for r in db.execute("""SELECT * FROM stop_visits
 WHERE route_id=3 AND stop_id IN (11,121) AND departed_at IS NOT NULL
 AND pinned_at IS NOT NULL AND outcome='stopped' AND stand_sec BETWEEN 15 AND 1800
 ORDER BY pinned_at""")]
departures = collections.defaultdict(list)
for r in db.execute("""SELECT bus_name,stop_id,departed_at FROM stop_visits
 WHERE route_id=3 AND stop_id IN (11,121) AND departed_at IS NOT NULL
 ORDER BY departed_at"""):
    departures[r['stop_id']].append((r['departed_at'], r['bus_name']))

rows = []
excluded = collections.Counter()
for v in visits:
    # Evaluate 20 s after the recorded rest began, when the live detector can
    # know it is a stop. Remaining stand, rather than future total, is scored.
    t = v['pinned_at'] + 20000
    if v['departed_at'] <= t:
        continue
    index = bisect.bisect_right(times, t) - 1
    if index < 0 or t - times[index] > 20000:
        excluded['no_fresh_watcher_frame'] += 1
        continue
    buses = frames[times[index]]
    own = next((b for b in buses if b['bus_name'] == v['bus_name']), None)
    if own is None:
        continue
    age = own.get('lap', {}).get(str(v['stop_id']))
    if age is not None:
        age += (t - times[index]) / 1000 - 20  # lap duration at rest onset
    if age is None or not 1200 <= age <= 5400:
        excluded['no_recent_lap'] += 1
        continue
    prev = [x for x in departures[v['stop_id']] if x[0] <= t - 60000 and x[1] != v['bus_name']]
    if not prev or t - prev[-1][0] > 3600000:
        excluded['no_recent_leader_departure'] += 1
        continue
    here = progress(own)
    others = [progress(b) for b in buses if b['bus_name'] != own['bus_name']]
    others = [p for p in others if p is not None]
    if here is None or not others:
        excluded['no_projected_neighbour'] += 1
        continue
    ahead = min((p - here) % lap_m for p in others)
    behind = min((here - p) % lap_m for p in others)
    rows.append(dict(day=dt.datetime.fromtimestamp(t / 1000, dt.timezone.utc).date().isoformat(),
                     stop=v['stop_id'], bus=v['bus_name'], at=t,
                     remaining=(v['departed_at'] - t) / 1000,
                     lap=age, previous=(t - prev[-1][0]) / 1000,
                     ahead=ahead / lap_m * 3035, behind=behind / lap_m * 3035))

arms = {'stop_median': [], 'lap': ['lap'], 'lap_previous': ['lap', 'previous'],
        'lap_spacing': ['lap', 'ahead', 'behind'],
        'lap_previous_spacing': ['lap', 'previous', 'ahead', 'behind']}
scores = collections.defaultdict(list)
folds = []
for day in sorted({r['day'] for r in rows}):
    train = [r for r in rows if r['day'] < day]
    test = [r for r in rows if r['day'] == day]
    if len(train) < 20 or len(test) < 3:
        continue
    folds.append({'day': day, 'train': len(train), 'test': len(test)})
    for name, fields in arms.items():
        for stop in [11, 121]:
            tr = [r for r in train if r['stop'] == stop]
            te = [r for r in test if r['stop'] == stop]
            if len(tr) < 10:
                continue
            y = np.array([r['remaining'] for r in tr])
            if fields:
                X = np.array([[r[f] for f in fields] for r in tr])
                mean, scale = X.mean(axis=0), np.maximum(X.std(axis=0), 1)
                X = np.c_[np.ones(len(tr)), (X - mean) / scale]
                # Fixed weak ridge to keep small-day collinear spacing stable.
                penalty = np.eye(X.shape[1]); penalty[0, 0] = 0
                beta = np.linalg.solve(X.T @ X + penalty, X.T @ y)
                predict = lambda r: float(np.r_[1, (np.array([r[f] for f in fields]) - mean) / scale] @ beta)
            else:
                predict = lambda r: float(np.median(y))
            for r in te:
                pred = max(0., predict(r))
                scores[name].append(dict(day=day, stop=stop, at=r['at'], actual=r['remaining'], predicted=pred, error=pred-r['remaining']))

summary = {name: {'n': len(v), 'mae': round(float(np.mean([abs(r['error']) for r in v])), 1),
                  'p90_abs': round(float(np.quantile([abs(r['error']) for r in v], .9)), 1),
                  'by_day': {d: round(float(np.mean([abs(r['error']) for r in v if r['day'] == d])), 1) for d in sorted({r['day'] for r in v})}}
           for name, v in scores.items() if v}
result = dict(features=len(rows), days=dict(collections.Counter(r['day'] for r in rows)),
              excluded=dict(excluded), folds=folds, summary=summary,
              limits=['Same upstream GPS and detector outcomes, not independent physical truth.',
                      'Neighbour spacing uses directed nearest-polyline projection; junction ambiguity remains.',
                      'Spacing seconds are a distance proxy based on a 3035 s typical loop, not a predicted neighbour arrival.',
                      'Small number of service days; hypothesis screen only, no production fit promoted.'],
              rows=rows, predictions=dict(scores))
Path(output).write_text(json.dumps(result, indent=2))
print(json.dumps({k: v for k, v in result.items() if k not in ('rows', 'predictions')}, indent=2))
