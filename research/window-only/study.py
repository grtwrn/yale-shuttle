"""Hosted-only fixed window transformation. No fitting and no relabelling."""
import collections
import gzip
import hashlib
import json
import math
from pathlib import Path
import shutil
import statistics as st
import sys

HERE = Path(__file__).resolve().parent
INPUT = HERE / 'input/canonical-windows/results'
OUT = HERE / 'results'
KS = (1, 2, 3, 5, 8, 10, 15)
ARMS = tuple(f'{mode}_K{k}' for mode in ('frozen', 'rolling') for k in KS)


def transform(deployed, candidate, supported):
    if not supported:
        assert candidate == deployed, 'Unsupported canonical forecast was not deployed fallback'
        return dict(deployed)
    return dict(eta=deployed['eta'], low=min(deployed['low'], candidate['low'], deployed['eta']),
                high=max(deployed['eta'], candidate['high']))


def key(row):
    return row['at'], row['bus'], row['route'], row['target']


def read(path):
    with gzip.open(path, 'rt') as source:
        return [json.loads(line) for line in source if line.strip()]


def write(name, rows):
    with gzip.open(OUT / (name + '.jsonl.gz'), 'wt') as target:
        for row in rows:
            target.write(json.dumps(row, separators=(',', ':')) + '\n')


def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def projection(row):
    # Same serialized stream on both sides, including exact canonical label
    # ordering/values, physical occurrence and both recorded comparators.
    return json.dumps({field: row[field] for field in (
        'at', 'bus', 'route', 'target', 'targetIndex', 'label', 'truth', 'baseline',
        'deployed', 'deployedChanged', 'deployedEvidence')}, separators=(',', ':')) + '\n'


def metrics(rows, arm, underlying=False):
    visits = collections.defaultdict(list)
    sources, dates, severe, new_severe, false_visits = set(), set(), set(), set(), set()
    false_now = new_false = 0
    for r in rows:
        f = r['deployed'] if arm == 'deployed' else r['underlyingCandidates' if underlying else 'candidates'][arm]
        d, truth, visit = r['deployed'], r['truth'], r['label']['id']
        visits[visit].append(dict(mae=abs(f['eta']-truth), width=f['high']-f['low'],
            coverage=float(f['low'] <= truth <= f['high']), early=float(truth < f['low']),
            early30=float(truth < f['low']-30), early60=float(truth < f['low']-60),
            early120=float(truth < f['low']-120), late=float(truth > f['high']),
            late30=float(truth > f['high']+30), late60=float(truth > f['high']+60),
            late120=float(truth > f['high']+120), earlyExcessSec=max(0, f['low']-truth),
            lateExcessSec=max(0, truth-f['high'])))
        dates.add(rr.ev.date(r['at']))
        if arm != 'deployed':
            evidence = r['candidateEvidence'][arm]
            if evidence.get('origin') is not None:
                sources.add((r['bus'], evidence['source'], evidence['origin']))
        if truth < f['low']-60:
            severe.add(visit)
            if truth >= d['low']-60:
                new_severe.add(visit)
        if f['eta'] <= 15 and truth > 120:
            false_now += 1
            if d['eta'] > 15:
                new_false += 1
                false_visits.add(visit)
    if not visits:
        return dict(snapshots=0, visits=0, sourceTrips=0, dates=[])
    return dict(snapshots=len(rows), visits=len(visits), sourceTrips=len(sources), dates=sorted(dates),
        severeEarlyVisits=len(severe), introducedSevereEarlyVisits=len(new_severe),
        falseNow=false_now, introducedFalseNowSnapshots=new_false,
        introducedFalseNowVisits=len(false_visits),
        **{k: st.mean(st.mean(v[k] for v in vs) for vs in visits.values())
           for k in next(iter(visits.values()))[0]})


def paired(rows, arm):
    return dict(deployed=metrics(rows, 'deployed'), candidate=metrics(rows, arm))


def common(rows, arms=ARMS):
    return dict(deployed=metrics(rows, 'deployed'), arms={a: metrics(rows, a) for a in arms})


def red_slices(rows):
    # Red has unique physical stops. Target-only geometry is separate from the
    # actual production qualification flag; neither changes candidate support.
    def wait(row):
        values = {e['wait'] for e in row['candidateEvidence'].values() if e.get('changed')}
        assert len(values) <= 1, 'Fixed wait assignment disagrees between Ks'
        return next(iter(values), None)
    def production_targets(row):
        return wait(row) == 14 and row['targetIndex'] is not None and 15 <= row['targetIndex'] <= 28
    current = [r for r in rows if production_targets(r)]
    expanded = [r for r in rows if not production_targets(r)]
    result = {'currentTargets15to28': current, 'expandedTargets': expanded,
              'expandedUnionIndex0': [r for r in rows if wait(r) == 14 and r['targetIndex'] == 0],
              'expandedWait0Targets1to14': [r for r in rows if wait(r) == 0 and r['targetIndex'] is not None and 1 <= r['targetIndex'] <= 14]}
    for name, rs in (('all', rows), ('currentTargets15to28', current), ('expandedTargets', expanded)):
        for active in (True, False):
            result[f'{name}/' + ('deployedCheckpointApplied' if active else 'deployedLiveFallback')] = [r for r in rs if r['deployedChanged'] == active]
    return result


def gates(pair, ordering):
    d, c = pair['deployed'], pair['candidate']
    if not c['snapshots']:
        return ['no changed support']
    failed = []
    for name, ok in (
        ('width improvement below60s', d['width']-c['width'] >= 60),
        ('MAE degradation exceeds20s', c['mae']-d['mae'] <= 20),
        ('coverage below80%', c['coverage'] >= .8),
        ('coverage loss exceeds2pp', d['coverage']-c['coverage'] <= .02 + 1e-12),
        ('introduced severe early visits', c['introducedSevereEarlyVisits'] == 0),
        ('early rate increase exceeds1pp', c['early']-d['early'] <= .01 + 1e-12),
        ('introduced false-now', c['introducedFalseNowSnapshots'] == 0),
        ('introduced ordering reversal', not any(ordering['introducedReversals'].values()))):
        if not ok:
            failed.append(name)
    return failed  # Action/handoff/fresh-date gates remain separate; never a promotion flag.


def main():
    global rr
    sys.path.insert(0, str(HERE.parent / 'useful-windows'))
    import rolling as rr
    OUT.mkdir(parents=True, exist_ok=True)
    raw_hashes = {}
    for line in (INPUT / 'immutable-inputs.sha256').read_text().splitlines():
        expected, file = line.split(maxsplit=1)
        assert digest(Path(file)) == expected, f'Raw input changed: {file}'
        raw_hashes[file] = expected
    shutil.copyfile(INPUT / 'immutable-inputs.sha256', OUT / 'immutable-inputs.sha256')
    for file in ('canonical-topology.json', 'preparation.json', 'training-visits-audit.json'):
        shutil.copyfile(INPUT / file, OUT / file)
    original = read(INPUT / 'unscored.jsonl.gz')
    generated, counts = [], collections.Counter()
    for row in original:
        assert 'label' not in row and 'truth' not in row
        assert set(row['candidates']) == set(ARMS)
        candidates = {}
        for arm in ARMS:
            supported = row['candidateEvidence'][arm]['changed']
            d = row['deployed']
            f = transform(d, row['candidates'][arm], supported)
            assert f['eta'] == d['eta'] and f['low'] <= d['low']
            assert all(math.isfinite(f[k]) for k in ('eta', 'low', 'high'))
            assert 0 <= f['low'] <= f['eta'] <= f['high']
            if not supported:
                assert f == d
            counts['supported' if supported else 'unsupported'] += 1
            counts['changedWindows'] += f != d
            candidates[arm] = f
        generated.append(dict(row, underlyingCandidates=row['candidates'], candidates=candidates))
    write('unscored', generated)
    unscored_digest = digest(OUT / 'unscored.jsonl.gz')
    # Labels are first opened AFTER every transformed prediction is persisted.
    canonical_labels = read(INPUT / 'forecasts.jsonl.gz')
    original_by_key = {key(r): r for r in original}
    generated_by_key = {key(r): r for r in generated}
    assert len(original_by_key) == len(original) == len(generated_by_key)
    scored, label_lookup = [], {}
    source_identity, output_identity = hashlib.sha256(), hashlib.sha256()
    for canonical in canonical_labels:
        k = key(canonical)
        assert k not in label_lookup
        assert {field: value for field, value in canonical.items()
                if field not in ('label', 'truth', 'outcomeReason')} == original_by_key[k]
        r = dict(generated_by_key[k], label=canonical['label'], truth=canonical['truth'],
                 outcomeReason=canonical['outcomeReason'])
        assert projection(r) == projection(canonical)
        source_identity.update(projection(canonical).encode())
        output_identity.update(projection(r).encode())
        for arm in ARMS:
            assert not (r['truth'] < r['candidates'][arm]['low'] and r['truth'] >= r['deployed']['low'])
        scored.append(r)
        label_lookup[k] = r['label']
    assert source_identity.digest() == output_identity.digest()
    write('forecasts', scored)
    assert digest(OUT / 'unscored.jsonl.gz') == unscored_digest
    enriched = [dict(r, label=label_lookup.get(key(r))) for r in generated]
    canonical_summary = json.loads((INPUT / 'summary.json').read_text())
    summary = dict(note='Fixed hybrid bounds on reused canonical dates; no fitted distribution or production promotion.',
        availability=canonical_summary['availability'], routes={}, commonComparisons={}, refreshComparisons={}, redScope={},
        training=canonical_summary['training'], generatedSnapshots=len(generated), labelledSnapshots=len(scored))
    for rid in (int(k) for k in summary['availability']):
        rs = [r for r in scored if r['route'] == rid]
        all_route = [r for r in enriched if r['route'] == rid]
        shared = [r for r in rs if any(r['candidates'][arm] != r['deployed'] for arm in ARMS)]
        summary['commonComparisons'][rid] = dict(cohort='same union changed by any hybrid arm', **common(shared))
        summary['refreshComparisons'][rid] = {}
        summary['routes'][rid] = {}
        for k in KS:
            a, b = f'frozen_K{k}', f'rolling_K{k}'
            union = [r for r in rs if r['candidates'][a] != r['deployed'] or r['candidates'][b] != r['deployed']]
            summary['refreshComparisons'][rid][k] = dict(cohort='same hybrid frozen/rolling union', **common(union, (a, b)))
            if rid == 3:
                summary['redScope'][k] = {name: common(subset, (a, b)) for name, subset in red_slices(union).items()}
        for arm in ARMS:
            changed = [r for r in rs if r['candidates'][arm] != r['deployed']]
            underlying_union = [r for r in rs if r['candidates'][arm] != r['deployed'] or r['underlyingCandidates'][arm] != r['deployed']]
            order = rr.ordering(rs, arm)
            pair = paired(changed, arm)
            summary['routes'][rid][arm] = dict(all=paired(rs, arm), changed=pair,
                underlyingComparison=dict(cohort='same underlying-or-hybrid changed union',
                    deployed=metrics(underlying_union, 'deployed'), underlying=metrics(underlying_union, arm, True),
                    hybrid=metrics(underlying_union, arm)),
                generatedReasons=dict(collections.Counter(r['candidateReasons'][arm] for r in all_route)),
                unmatchedReasons=dict(collections.Counter(r['candidateReasons'][arm] for r in all_route if not r['label'])),
                ordering=order, handoffs=rr.handoffs(all_route, arm),
                changedNumericalGateFailures=gates(pair, order),
                commonNumericalGateFailures=gates(paired(shared, arm), order),
                days={day: paired([r for r in shared if rr.ev.date(r['at']) == day], arm) for day in sorted({rr.ev.date(r['at']) for r in rs})},
                stops={str(index): paired([r for r in shared if r['targetIndex'] == index], arm) for index in sorted({r['targetIndex'] for r in shared})})
    (OUT / 'summary.json').write_text(json.dumps(summary, indent=2) + '\n')
    audit = dict(canonicalRun=35684356219, canonicalCommit='3f7b5e9d86ed532107663747809ae0727119d49f',
        rawHashes=raw_hashes, inputHashes={file: digest(INPUT / file) for file in ('unscored.jsonl.gz', 'forecasts.jsonl.gz', 'canonical-topology.json', 'immutable-inputs.sha256')},
        transformedUnscoredSha256=unscored_digest, canonicalIdentitySha256=source_identity.hexdigest(),
        transformedIdentitySha256=output_identity.hexdigest(), labelledRows=len(scored), generatedRows=len(generated),
        checks=dict(counts), pointChanges=0, laterLowerBounds=0, unsupportedChanges=0,
        unscoredPersistedBeforeLabels=True, labelOrderAndValuesIdentical=True)
    (OUT / 'audit.json').write_text(json.dumps(audit, indent=2) + '\n')
    print(json.dumps(audit))


if __name__ == '__main__':
    main()
