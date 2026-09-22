"""Hosted rolling-history study; fixed Ks, embargoed fitting, deployed fallback."""
import bisect
import collections
import datetime as dt
import gzip
import json
import math
from pathlib import Path
import statistics as st
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'k-sweep'))
import evaluate as ev
from prepare import TZ

HERE = Path(__file__).resolve().parent
OUT = HERE / 'rolling-results'
FROZEN = ev.CUTOFF
KS = ev.KS
ARMS = [f'{mode}_K{k}' for mode in ('frozen', 'rolling') for k in KS]


def cutoff_for(day):
    previous = dt.date.fromisoformat(day) - dt.timedelta(days=1)
    return int(dt.datetime.combine(previous, dt.time(), TZ).timestamp() * 1000)


def available(v, cutoff):
    # known_at is the actual causal reducer emission poll, never the backdated
    # departure. Every source/intermediate/target visit must already be known.
    def finite(x):
        return isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x)
    arrival, departure = v.get('arrived_at'), v.get('departed_at')
    if not finite(arrival) or not finite(departure) or departure < arrival:
        return False
    known = v.get('known_at')
    return finite(known) and departure <= known < cutoff


class TrainingQuality(ev.Quality):
    """Existing gap/speed/route checks plus stable provider identity."""
    def __init__(self, raw):
        super().__init__(raw)
        groups = collections.defaultdict(list)
        for row in raw:
            groups[row['bus_name']].append(row)
        self.identities = {}
        for bus, rows in groups.items():
            rows.sort(key=lambda r: r['collected_at'])
            bad = [0]
            for a, b in zip(rows, rows[1:]):
                bad.append(bad[-1] + int(a['bus_id'] != b['bus_id']))
            self.identities[bus] = ([r['collected_at'] for r in rows], bad)

    def ok(self, bus, rid, start, end):
        if not super().ok(bus, rid, start, end):
            return False
        times, bad = self.identities[bus]
        lo = max(0, bisect.bisect_right(times, start) - 1)
        hi = min(len(times)-1, bisect.bisect_left(times, end))
        return bad[hi] == bad[lo]


def fit(visits, raw, cutoff):
    # Models reads this module constant while constructing its training paths.
    # Calls are sequential and predict() itself does not read the cutoff.
    ev.CUTOFF = cutoff
    admitted = [v for v in visits if available(v, cutoff)]
    # Even a bracketing GPS sample may not come from after the training cutoff.
    quality = TrainingQuality([r for r in raw if r['collected_at'] < cutoff])
    model = ev.Models(admitted, quality)
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
    return model, dict(cutoff=cutoff, admittedVisits=len(admitted), support=support)


def write(name, rows):
    with gzip.open(OUT / f'{name}.jsonl.gz', 'wt') as f:
        for row in rows:
            f.write(json.dumps(row, separators=(',', ':')) + '\n')


def forecast(row, arm):
    return row['deployed'] if arm == 'deployed' else row['candidates'][arm]


def metrics(rows, arm):
    visits = collections.defaultdict(list)
    sources, severe, new_severe, false_visits = set(), set(), set(), set()
    introduced_false_now = 0
    for r in rows:
        f, truth, visit = forecast(r, arm), r['truth'], r['label']['id']
        visits[visit].append(dict(mae=abs(f['eta'] - truth), width=f['high'] - f['low'],
            coverage=float(f['low'] <= truth <= f['high']), early=float(truth < f['low']),
            early30=float(truth < f['low'] - 30), early60=float(truth < f['low'] - 60),
            early120=float(truth < f['low'] - 120), late=float(truth > f['high'])))
        if arm != 'deployed':
            evidence = r['candidateEvidence'][arm]
            if evidence.get('origin') is not None:
                sources.add((r['bus'], evidence['source'], evidence['origin']))
        if truth < f['low'] - 60:
            severe.add(visit)
            if truth >= r['deployed']['low'] - 60:
                new_severe.add(visit)
        if f['eta'] <= 15 and truth > 120 and r['deployed']['eta'] > 15:
            introduced_false_now += 1
            false_visits.add(visit)
    if not visits:
        return dict(snapshots=0, visits=0, sourceTrips=0)
    return dict(snapshots=len(rows), visits=len(visits), sourceTrips=len(sources),
        days=len({ev.date(r['at']) for r in rows}), severeEarlyVisits=len(severe),
        introducedSevereEarlyVisits=len(new_severe),
        introducedFalseNowSnapshots=int(introduced_false_now), introducedFalseNowVisits=len(false_visits),
        falseNow=sum(forecast(r, arm)['eta'] <= 15 and r['truth'] > 120 for r in rows),
        **{k: st.mean(st.mean(v[k] for v in vs) for vs in visits.values())
           for k in next(iter(visits.values()))[0]})


def ordering(rows, arm):
    groups = collections.defaultdict(list)
    for r in rows:
        groups[r['at'], r['bus'], r['route']].append(r)
    pairs, new = 0, dict.fromkeys(('eta', 'low', 'high'), 0)
    for rs in groups.values():
        rs = sorted(rs, key=lambda r: r['stopsAhead'])
        for a, b in zip(rs, rs[1:]):
            if not 0 < a['stopsAhead'] < b['stopsAhead']:
                continue
            pairs += 1
            for field in new:
                new[field] += (forecast(a, arm)[field] > forecast(b, arm)[field] + 30
                    and a['deployed'][field] <= b['deployed'][field] + 30)
    return dict(pairs=pairs, introducedReversals=new)


def handoffs(rows, arm):
    groups, records, gaps = collections.defaultdict(list), [], 0
    unlabelled, next_occurrence = 0, 0
    for r in rows:
        groups[r['bus'], r['route'], r['target']].append(r)
    for rs in groups.values():
        rs.sort(key=lambda r: r['at'])
        for a, b in zip(rs, rs[1:]):
            ae, be = a['candidateEvidence'][arm], b['candidateEvidence'][arm]
            if not (ae['changed'] or be['changed']):
                continue
            if ae['changed'] != be['changed']:
                transition = 'candidate-to-fallback' if ae['changed'] else 'fallback-to-candidate'
            elif any(ae.get(k) != be.get(k) for k in ('source', 'origin', 'wait')):
                transition = 'new-source-or-wait'
            elif arm.startswith('rolling_') and ev.date(a['at']) != ev.date(b['at']):
                transition = 'daily-refit'
            else:
                continue
            if not a.get('label') or not b.get('label'):
                unlabelled += 1
                continue
            if a['label']['id'] != b['label']['id']:
                next_occurrence += 1
                continue
            if not 0 < b['at'] - a['at'] <= 30000:
                gaps += 1
                continue
            seconds = (b['at'] - a['at']) / 1000
            records.append(dict(bus=b['bus'], at=b['at'], target=b['target'],
                transition=transition, reason=be['reason'],
                arrivalClockJump={k: forecast(b, arm)[k] - forecast(a, arm)[k] + seconds for k in ('eta','low','high')},
                deployedArrivalClockJump={k: b['deployed'][k] - a['deployed'][k] + seconds for k in ('eta','low','high')}))
    return dict(observed=len(records), transitionCounts=dict(collections.Counter(r['transition'] for r in records)),
        unobservedGapTransitions=gaps, unlabelledTransitions=unlabelled,
        differentPickupOccurrenceTransitions=next_occurrence, records=records)


def paired(rows, arm):
    return dict(candidate=metrics(rows, arm), deployed=metrics(rows, 'deployed'))


def self_test():
    cut = cutoff_for('2026-09-18')
    assert ev.date(cut) == '2026-09-17'
    v = dict(arrived_at=cut-100000, departed_at=cut-30000, known_at=cut-10000)
    assert available(v, cut)
    assert not available(dict(v, known_at=cut), cut)
    assert not available(dict(v, known_at=None), cut)
    assert not available(dict(v, known_at=cut-40000), cut)
    assert not available(dict(v, departed_at=None), cut)
    assert not available(dict(v, departed_at=cut+1), cut)
    assert not available(dict(v, arrived_at=cut), cut)
    # Calendar-day embargo remains correct across DST, not a fixed24h offset.
    assert ev.date(cutoff_for('2026-11-02')) == '2026-11-01'
    assert cutoff_for('2026-09-17') == FROZEN
    rows = [dict(bus_name='1', bus_id=1, route_id=3, lat=41.3, lon=-72.9, collected_at=t) for t in (10000,20000)]
    assert TrainingQuality(rows).ok('1', 3, 10000, 20000)
    assert not TrainingQuality([rows[0], dict(rows[1], bus_id=2)]).ok('1', 3, 10000, 20000)
    print('12 rolling-history boundary checks passed')


def main():
    OUT.mkdir(exist_ok=True)
    visits = ev.read(OUT / 'training-visits.jsonl.gz')
    raw = ev.read(ev.IN / 'raw_positions.jsonl.gz')
    rows = [r for r in ev.read(HERE / 'results/deployed.jsonl.gz') if r['at'] >= ev.TEST]
    frozen, audit = fit(visits, raw, FROZEN)
    training, generated = {'frozen': audit}, []
    for day in sorted({ev.date(r['at']) for r in rows}):
        cutoff = cutoff_for(day)
        assert cutoff <= min(r['at'] for r in rows if ev.date(r['at']) == day)
        rolling, training[day] = fit(visits, raw, cutoff)
        for r in rows:
            if ev.date(r['at']) != day:
                continue
            candidates, reasons, evidence = {}, {}, {}
            # Every unsupported/expired path returns the currently deployed ETA.
            feature = dict(r, baseline=r['deployed'])
            for mode, model in (('frozen', frozen), ('rolling', rolling)):
                for k in KS:
                    arm = f'{mode}_K{k}'
                    result = model.predict(feature, f'K{k}')
                    f = result['forecast']
                    if result['changed']:
                        # Match the production wire's Math.round for nonnegative
                        # seconds, including minute/reminder decision boundaries.
                        f = {field: math.floor(value + .5) for field, value in f.items()}
                    assert all(math.isfinite(f[x]) for x in ('eta', 'low', 'high'))
                    assert 0 <= f['low'] <= f['eta'] <= f['high']
                    if not result['changed']:
                        assert f == r['deployed']
                    candidates[arm], reasons[arm] = f, result['reason']
                    evidence[arm] = {key: value for key, value in result.items() if key != 'forecast'}
            if cutoff == FROZEN:
                assert all(candidates[f'frozen_K{k}'] == candidates[f'rolling_K{k}'] for k in KS)
            generated.append(dict(r, candidates=candidates, candidateReasons=reasons, candidateEvidence=evidence))
    write('unscored', generated)  # Label file is deliberately opened only below.
    def key(r):
        return r['at'], r['bus'], r['route'], r['target']
    historical_labels = {key(r): r for r in ev.read(ev.IN / 'long90/scored.jsonl.gz') if r['at'] >= ev.TEST}
    outcome_quality = TrainingQuality(raw)
    labels = {k: r for k, r in historical_labels.items()
        if outcome_quality.ok(r['bus'], r['route'], r['at'], r['label']['arrival'])}
    scored = [dict(r, label=labels[key(r)]['label'], truth=labels[key(r)]['truth']) for r in generated if key(r) in labels]
    enriched = [dict(r, label=labels[key(r)]['label'] if key(r) in labels else None) for r in generated]
    write('forecasts', scored)
    summary = dict(training=training, routes={}, refreshComparisons={}, note='Reused diagnostic dates; no automatic promotion',
        snapshots=len(generated), scoredSnapshots=len(scored), unmatchedSnapshots=len(generated)-len(scored))
    for rid in ev.ROUTES:
        rs = [r for r in scored if r['route'] == rid]
        all_route = [r for r in enriched if r['route'] == rid]
        unmatched = [r for r in all_route if not r['label']]
        summary['routes'][rid] = {}
        summary['refreshComparisons'][rid] = {}
        for k in KS:
            frozen_arm, rolling_arm = f'frozen_K{k}', f'rolling_K{k}'
            union = [r for r in rs if r['candidates'][frozen_arm] != r['deployed'] or r['candidates'][rolling_arm] != r['deployed']]
            summary['refreshComparisons'][rid][k] = dict(
                frozen=metrics(union, frozen_arm), rolling=metrics(union, rolling_arm),
                deployed=metrics(union, 'deployed'), cohort='same union of either changed arm')
        for arm in ARMS:
            changed = [r for r in rs if r['candidates'][arm] != r['deployed']]
            summary['routes'][rid][arm] = dict(all=paired(rs, arm), changed=paired(changed, arm),
                fallbacks=dict(collections.Counter(r['candidateReasons'][arm] for r in rs)),
                generatedReasons=dict(collections.Counter(r['candidateReasons'][arm] for r in all_route)),
                unmatchedReasons=dict(collections.Counter(r['candidateReasons'][arm] for r in unmatched)),
                generatedSnapshots=len(all_route), unmatchedSnapshots=len(unmatched),
                unmatchedOutcomeReasons=dict(collections.Counter('stricter GPS/provider continuity' if key(r) in historical_labels else 'no original resolved outcome' for r in unmatched)),
                ordering=ordering(rs, arm), handoffs=handoffs(all_route, arm),
                days={day: paired([r for r in changed if ev.date(r['at']) == day], arm) for day in sorted({ev.date(r['at']) for r in rs})},
                stops={stop: paired([r for r in changed if r['target'] == stop], arm) for stop in sorted({r['target'] for r in changed})})
    (OUT / 'summary.json').write_text(json.dumps(summary, indent=2))
    print(json.dumps(dict(snapshots=len(generated), scored=len(scored), trainingCutoffs={d: a['cutoff'] for d,a in training.items()})))


if __name__ == '__main__':
    self_test() if '--self-test' in sys.argv else main()
