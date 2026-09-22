"""Canonical occurrence study. Full computation is hosted, never on the Pi."""
import bisect
import collections
import hashlib
import json
import math
from pathlib import Path
import sys

HERE = Path(__file__).resolve().parent
OUT = HERE / 'results'
sys.path.insert(0, str(HERE.parent / 'useful-windows'))
import rolling as rr
ev = rr.ev
FROZEN, KS, ARMS = rr.FROZEN, rr.KS, rr.ARMS


def configure():
    payload = (OUT / 'canonical-topology.json').read_bytes()
    audit = json.loads((OUT / 'training-visits-audit.json').read_text())
    assert hashlib.sha256(payload).hexdigest() == audit['canonicalSha256']
    ev.ROUTES = {r['id']: r for r in json.loads(payload)['routes']}
    if (OUT / 'preparation.json').exists():
        ev.WAITS = {int(k): v for k, v in json.loads((OUT / 'preparation.json').read_text())['waits'].items()}


def prepare():
    configure()
    grouped = collections.defaultdict(list)
    admitted = 0
    for v in ev.read(OUT / 'training-visits.jsonl.gz'):
        if not rr.available(v, FROZEN) or v['how'] == 'gap' or v['outcome'] not in ('stopped', 'passed') or v['stand_sec'] is None:
            continue
        assert ev.ROUTES[v['route_id']]['stops'][v['stop_index']] == v['stop_id']
        grouped[v['route_id'], v['stop_index']].append(v)
        admitted += 1
    waits = {rid: [] for rid in ev.ROUTES}
    stats = []
    for (rid, index), vs in sorted(grouped.items()):
        values = sorted(v['stand_sec'] for v in vs)
        x = (len(values)-1) * .75
        q75 = values[math.floor(x)] * (1-x%1) + values[math.ceil(x)] * (x%1)
        dates = sorted({ev.date(v['arrived_at']) for v in vs})
        major = len(vs) >= 30 and len(dates) >= 3 and q75 >= 180
        if major:
            waits[rid].append(index)
        stats.append(dict(route=rid, index=index, stop=ev.ROUTES[rid]['stops'][index],
                          n=len(vs), days=len(dates), dates=dates, p75=q75, major=major))
    result = dict(cutoff=FROZEN, waits=waits, waitStats=stats, admittedVisits=admitted,
                  rule='completed canonical visits known before cutoff; n>=30, dates>=3, stand p75>=180')
    (OUT / 'preparation.json').write_text(json.dumps(result, indent=2))
    print(json.dumps(dict(waits=waits, admittedVisits=admitted)))


class Models(ev.Models):
    def predict(self, r, arm):
        base = dict(forecast=r['baseline'], changed=False, reason='not warm/fresh')
        if not r['ready']:
            return base
        rid, ti = r['route'], r.get('targetIndex')
        seq = ev.ROUTES[rid]['stops']; n = len(seq)
        if ti is None:
            return dict(base, reason='ambiguous occurrence: ' + r['occurrenceReason'])
        assert seq[ti] == r['target']
        w = ev.previous_wait(rid, ti); k, limit = ev.ARMS[arm]
        if w is None or ti not in ev.targets(rid, w, limit):
            return dict(base, reason='outside target group')
        if n <= k:
            return dict(base, reason='K exceeds single-occurrence loop support')
        index, source = r['index'], (w-k) % n
        origin = r['origins'].get(str(source))
        if not origin:
            return dict(base, reason='source departure unavailable')
        assert origin['departed'] <= origin['knownAt'] <= r['asof']
        release = r['origins'].get(str(w))
        if (r.get('releasedOrigins', {}).get(f'{k}/{w}') == origin['departed']
                or (release and release['departed'] > origin['departed'])
                or ev.distance(source, index, n) > k or (index == w and r['phase'] == 'drive')):
            return dict(base, reason='released/live')
        if index != w and (ev.distance(index, ti, n) or n) <= ev.distance(index, w, n):
            return dict(base, reason='pickup before wait')
        if not 0 < r['stopsAhead'] < n:
            return dict(base, reason='occurrence disagreement')
        anchor = r['anchorIndex']
        progress = ev.distance(source, anchor, n)
        if progress > k or r['stopsAhead'] != k + ev.distance(w, ti, n) - progress:
            return dict(base, reason='occurrence disagreement')
        forecasts = {}; elapsed = (r['at']-origin['departed'])/1000
        for target in ev.targets(rid, w, limit):
            f = self.fit(rid, k, w, target, origin['departed'])
            if f is None:
                return dict(base, reason='group lacks historical support',
                            unsupportedTarget=seq[target], unsupportedTargetIndex=target)
            value = {key: max(0, f[key]-elapsed) for key in ('eta', 'low', 'high')}
            if value['eta'] <= 60:
                return dict(base, reason='group countdown expired')
            forecasts[target] = value
        return dict(forecast=forecasts[ti], changed=True, reason='checkpoint',
                    wait=w, source=source, origin=origin['departed'])


def fit(visits, raw, cutoff):
    ev.CUTOFF = cutoff
    admitted = [v for v in visits if rr.available(v, cutoff)]
    model = Models(admitted, rr.TrainingQuality([r for r in raw if r['collected_at'] < cutoff]))
    for cell, paths in model.paths.items():
        if cell[0] == 3:
            model.paths[cell] = [p for p in paths if p['duration'] <= 2700]
    assert all(p['end'] < cutoff for paths in model.paths.values() for p in paths)
    support = {}
    for rid in ev.ROUTES:
        for k in KS:
            paths = [p for cell, ps in model.paths.items() if cell[:2] == (rid, k) for p in ps]
            support[f'{rid}/K{k}'] = dict(paths=len(paths), sourceTrips=len({p['sourceId'] for p in paths}),
                                         dates=sorted({p['day'] for p in paths}))
    return model, dict(cutoff=cutoff, admittedVisits=len(admitted), support=support, modelAudit=dict(model.audit))


class Outcomes:
    def __init__(self, visits, quality):
        self.quality = quality
        self.physical = collections.defaultdict(list)
        self.tracks = collections.defaultdict(list)
        for v in visits:
            if v['arrived_at'] is not None:
                self.physical[v['bus_name'], v['route_id'], v['stop_id']].append(v)
                self.tracks[v['bus_name'], v['route_id']].append(v)
        for group in (self.physical, self.tracks):
            for vs in group.values():
                vs.sort(key=lambda v: (v['arrived_at'], v['id']))
        self.times = {key: [v['arrived_at'] for v in vs] for key, vs in self.physical.items()}
        self.track_times = {key: [v['arrived_at'] for v in vs] for key, vs in self.tracks.items()}

    def label(self, r):
        if r.get('targetIndex') is None:
            return None, 'causal target occurrence unresolved'
        key = r['bus'], r['route'], r['target']
        vs = self.physical.get(key, []); ts = self.times.get(key, [])
        i = bisect.bisect_right(ts, r['at'])
        if i and vs[i-1]['departed_at'] is not None and r['at'] < vs[i-1]['departed_at']:
            return None, 'already at physical pickup'
        if i == len(vs):
            return None, 'no next physical pickup'
        v = vs[i]
        # Do not skip this physical boarding opportunity to find a later pass.
        if v['stop_index'] != r['targetIndex']:
            return None, 'intervening physical pickup has different occurrence'
        if v['arrived_at']-r['at'] > 2_700_000:
            return None, 'arrival beyond45min'
        if not ev.valid(v) or not rr.available(v, float('inf')):
            return None, 'unresolved or distant pickup/departure'
        if not self.quality.ok(r['bus'], r['route'], r['at'], v['departed_at']):
            return None, 'GPS/provider disconnected through departure'
        track_key = r['bus'], r['route']; track = self.tracks[track_key]; times = self.track_times[track_key]
        start = bisect.bisect_right(times, r['at'])
        previous, progress = r['anchorIndex'], 0
        n = len(ev.ROUTES[r['route']]['stops'])
        for visit in track[start:]:
            hop = ev.distance(previous, visit['stop_index'], n)
            if hop > 5:
                return None, 'unresolved forward occurrence path'
            progress += hop; previous = visit['stop_index']
            if progress > r['stopsAhead']:
                return None, 'pickup hop occurrence disagreement'
            if visit['id'] == v['id']:
                if progress != r['stopsAhead']:
                    return None, 'pickup hop occurrence disagreement'
                break
        return dict(id=v['id'], arrival=v['arrived_at'], departure=v['departed_at'],
                    outcome=v['outcome'], targetIndex=v['stop_index'], knownAt=v['known_at']), None


def key(r):
    return r['at'], r['bus'], r['route'], r['target']


def main():
    configure(); rr.OUT = OUT
    visits = ev.read(OUT / 'training-visits.jsonl.gz')
    raw = ev.read(ev.IN / 'raw_positions.jsonl.gz')
    baseline = {key(r): r for r in ev.read(HERE.parent / 'useful-windows/results/deployed.jsonl.gz')}
    rows = []
    for f in ev.read(OUT / 'features.jsonl.gz'):
        if f['at'] < ev.TEST:
            continue
        old = baseline[key(f)]
        assert f['baseline'] == old['baseline'] and f['stopsAhead'] == old['stopsAhead']
        rows.append(dict(f, deployed=old['deployed'], deployedChanged=old['deployedChanged'], deployedEvidence=old['deployedEvidence']))
    frozen, frozen_audit = fit(visits, raw, FROZEN)
    training, generated, parity = {'frozen': frozen_audit}, [], 0
    for day in sorted({ev.date(r['at']) for r in rows}):
        cutoff = rr.cutoff_for(day)
        rolling, training[day] = fit(visits, raw, cutoff)
        for r in rows:
            if ev.date(r['at']) != day:
                continue
            candidates, reasons, evidence = {}, {}, {}
            feature = dict(r, baseline=r['deployed'])
            for mode, model in (('frozen', frozen), ('rolling', rolling)):
                for k in KS:
                    arm = f'{mode}_K{k}'
                    result = model.predict(feature, f'K{k}')
                    if ev.ROUTES[r['route']]['stops'].count(r['target']) == 1 and r['targetIndex'] is not None:
                        control = ev.Models.predict(model, feature, f'K{k}')
                        assert result['forecast'] == control['forecast'] and result['changed'] == control['changed']
                        parity += 1
                    f = result['forecast']
                    if result['changed']:
                        f = {field: math.floor(value+.5) for field, value in f.items()}
                    else:
                        assert f == r['deployed']
                    assert all(math.isfinite(f[x]) for x in ('eta', 'low', 'high')) and 0 <= f['low'] <= f['eta'] <= f['high']
                    candidates[arm], reasons[arm] = f, result['reason']
                    evidence[arm] = {key: value for key, value in result.items() if key != 'forecast'}
            if cutoff == FROZEN:
                assert all(candidates[f'frozen_K{k}'] == candidates[f'rolling_K{k}'] for k in KS)
            generated.append(dict(r, candidates=candidates, candidateReasons=reasons, candidateEvidence=evidence))
    assert parity > 1000
    rr.write('unscored', generated)
    # Full physical outcomes are attached only after every forecast is persisted.
    outcomes = Outcomes(ev.read(OUT / 'training-visits.jsonl.gz'), rr.TrainingQuality(raw))
    historical = {key(r): r for r in ev.read(ev.IN / 'long90/scored.jsonl.gz') if r['at'] >= ev.TEST}
    scored, enriched, labels_audit = [], [], collections.Counter()
    for r in generated:
        label, reason = outcomes.label(r)
        row = dict(r, label=label, outcomeReason=reason)
        if label:
            row['truth'] = (label['arrival']-r['at'])/1000
            scored.append(row)
            old = historical.get(key(r))
            labels_audit['newly_available' if old is None else 'same_arrival_time' if old['label']['arrival'] == label['arrival'] else 'different_arrival_time'] += 1
        enriched.append(row)
    rr.write('forecasts', scored)
    summary = dict(training=training, routes={}, availability={}, refreshComparisons={},
        controls=dict(uniqueTargetNumericParity=parity, exactDeployedFallbackJoin=len(rows), frozenRollingSep17Equivalent=True),
        labelCohortChange=dict(counts=dict(labels_audit), explanation='Reconstructed canonical physical visits; identical new cohort for all arms and deployed overlay.'),
        note='Reused development dates; no automatic promotion; sampled logs and missing GPS history remain limitations.')
    for rid in ev.ROUTES:
        rs = [r for r in scored if r['route'] == rid]
        all_route = [r for r in enriched if r['route'] == rid]
        unmatched = [r for r in all_route if not r['label']]
        summary['availability'][rid] = dict(name=ev.ROUTES[rid]['name'], generated=len(all_route),
            resolvedOccurrences=sum(r['targetIndex'] is not None for r in all_route), labelled=len(rs),
            physicalVisits=len({r['label']['id'] for r in rs}),
            occurrenceReasons=dict(collections.Counter(r['occurrenceReason'] for r in all_route)),
            outcomeReasons=dict(collections.Counter(r['outcomeReason'] for r in unmatched)))
        summary['routes'][rid] = {}; summary['refreshComparisons'][rid] = {}
        for k in KS:
            a, b = f'frozen_K{k}', f'rolling_K{k}'
            union = [r for r in rs if r['candidates'][a] != r['deployed'] or r['candidates'][b] != r['deployed']]
            summary['refreshComparisons'][rid][k] = dict(frozen=rr.metrics(union, a), rolling=rr.metrics(union, b), deployed=rr.metrics(union, 'deployed'))
        for arm in ARMS:
            changed = [r for r in rs if r['candidates'][arm] != r['deployed']]
            summary['routes'][rid][arm] = dict(all=rr.paired(rs, arm), changed=rr.paired(changed, arm),
                generatedReasons=dict(collections.Counter(r['candidateReasons'][arm] for r in all_route)),
                unmatchedReasons=dict(collections.Counter(r['candidateReasons'][arm] for r in unmatched)),
                unsupportedTargets=dict(collections.Counter(str(r['candidateEvidence'][arm].get('unsupportedTargetIndex')) for r in all_route if r['candidateEvidence'][arm].get('unsupportedTargetIndex') is not None)),
                ordering=rr.ordering(rs, arm), handoffs=rr.handoffs(all_route, arm),
                days={day: rr.paired([r for r in changed if ev.date(r['at']) == day], arm) for day in sorted({ev.date(r['at']) for r in rs})},
                stops={str(index): rr.paired([r for r in changed if r['targetIndex'] == index], arm) for index in sorted({r['targetIndex'] for r in changed})})
    (OUT / 'summary.json').write_text(json.dumps(summary, indent=2))
    print(json.dumps(dict(controls=summary['controls'], availability=summary['availability'])))


if __name__ == '__main__':
    prepare() if '--prepare' in sys.argv else main()
