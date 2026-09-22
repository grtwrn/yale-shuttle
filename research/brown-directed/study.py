"""Four fixed Brown arms; all prior parity gates must pass before labels/scores."""
import collections
import gzip
import hashlib
import importlib.util
import json
import math
from pathlib import Path
import shutil
import statistics as st
import sys

HERE = Path(__file__).resolve().parent
OUT = HERE / 'results'
CANONICAL = HERE / 'input/canonical/canonical-windows/results'
WINDOW = HERE / 'input/window'
LEADS = ('frozen_K8', 'rolling_K5')
CELLS = ('original', 'directed')
ARMS = tuple(f'{lead}_{cell}' for lead in LEADS for cell in CELLS)


def module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    result = importlib.util.module_from_spec(spec)
    sys.modules[name] = result
    spec.loader.exec_module(result)
    return result


def read(path):
    with gzip.open(path, 'rt') as file:
        return [json.loads(line) for line in file if line.strip()]


def write(name, rows):
    with gzip.open(OUT / (name + '.jsonl.gz'), 'wt') as file:
        for row in rows:
            file.write(json.dumps(row, separators=(',', ':')) + '\n')


def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as file:
        for chunk in iter(lambda: file.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def key(r):
    return r['at'], r['bus'], r['route'], r['target']


def split(arm):
    return arm.rsplit('_', 1)


def consistency(rows, arm):
    groups = collections.defaultdict(list)
    for r in rows:
        d, c = r['deployed'], r['candidates'][arm]
        delta = (c['high']-c['low']) - (d['high']-d['low'])
        groups[r['label']['id']].append(dict(narrower=delta < 0, wider=delta > 0, unchanged=delta == 0))
    return {k: st.mean(st.mean(float(v[k]) for v in vs) for vs in groups.values())
            for k in ('narrower', 'wider', 'unchanged')} if groups else {}


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    assert json.loads((OUT/'parity-summary.json').read_text())['Brown']['discrepancyKeys'] == 0
    assert json.loads((OUT/'feature-parity.json').read_text())['originalLeadAndNonBrownFeatureParity']
    assert json.loads((OUT/'model-parity.json').read_text())['pathFitDifferences'] == 0
    protected = ('unscored.jsonl.gz', 'forecasts.jsonl.gz', 'summary.json', 'audit.json',
                 'action-audit.json', 'rider-risk/rider-risk-records.jsonl.gz')
    before = {file: digest(WINDOW / file) for file in protected}
    canonical_files = ('unscored.jsonl.gz','forecasts.jsonl.gz','training-visits.jsonl.gz','features.jsonl.gz','canonical-topology.json','preparation.json')
    canonical_before = {file: digest(CANONICAL/file) for file in canonical_files}
    raw_hashes = {}
    for line in (WINDOW / 'immutable-inputs.sha256').read_text().splitlines():
        expected, file = line.split(maxsplit=1)
        assert digest(Path(file)) == expected
        raw_hashes[file] = expected
    shutil.copyfile(WINDOW / 'immutable-inputs.sha256', OUT / 'immutable-inputs.sha256')
    for file in ('canonical-topology.json', 'preparation.json'):
        shutil.copyfile(CANONICAL / file, OUT / file)
    canonical = module('canonical_study', HERE.parent / 'canonical-windows/study.py')
    canonical.OUT = CANONICAL
    canonical.configure()
    rr, ev = canonical.rr, canonical.ev
    window = module('window_study', HERE.parent / 'window-only/study.py')
    window.rr = rr
    assert ev.MODEL_CAP == 5400 and ev.WAITS[19] == [0, 5]
    original = [r for r in read(CANONICAL / 'unscored.jsonl.gz') if r['route'] == 19]
    old_window = {key(r): r for r in read(WINDOW / 'unscored.jsonl.gz') if r['route'] == 19}
    feature_arms = {cell: {key(r): r for r in read(OUT/(name+'-features.jsonl.gz')) if r['route']==19 and r['at']>=ev.TEST}
                    for cell,name in (('original','baseline'),('directed','candidate'))}
    features = {key(r): {cell: feature_arms[cell][key(r)] for cell in CELLS} for r in original}
    assert len(original) == len(features) == len(old_window)
    assert all('label' not in r and 'truth' not in r and ev.date(r['at']) in
               ('2026-09-17', '2026-09-18', '2026-09-19', '2026-09-20') for r in original)
    visits = read(CANONICAL / 'training-visits.jsonl.gz')
    raw = read(ev.IN / 'raw_positions.jsonl.gz')
    frozen, frozen_audit = canonical.fit(visits, raw, canonical.FROZEN)
    training, generated, mismatches = {'frozen': frozen_audit}, [], []
    checks = collections.Counter()
    for day in sorted({ev.date(r['at']) for r in original}):
        rolling, training[day] = canonical.fit(visits, raw, rr.cutoff_for(day))
        for r in original:
            if ev.date(r['at']) != day:
                continue
            candidates, underlying, reasons, evidence = {}, {}, {}, {}
            for lead, model in (('frozen_K8', frozen), ('rolling_K5', rolling)):
                for cell in CELLS:
                    arm = lead + '_' + cell
                    feature = dict(features[key(r)][cell], baseline=r['deployed'])
                    result = model.predict(feature, 'K' + lead.split('_K')[1])
                    f = result['forecast']
                    if result['changed']:
                        f = {k: math.floor(v + .5) for k, v in f.items()}
                    e = {k: v for k, v in result.items() if k != 'forecast'}
                    hybrid = window.transform(r['deployed'], f, result['changed'])
                    assert hybrid['eta'] == r['deployed']['eta'] and hybrid['low'] <= r['deployed']['low']
                    assert all(math.isfinite(v) for v in hybrid.values())
                    assert 0 <= hybrid['low'] <= hybrid['eta'] <= hybrid['high']
                    if not result['changed']:
                        assert hybrid == r['deployed']
                    candidates[arm], underlying[arm], reasons[arm], evidence[arm] = hybrid, f, result['reason'], e
                    checks['supported' if result['changed'] else 'unsupported'] += 1
                    if cell == 'original':
                        for field, value, expected in (
                            ('forecast', f, r['candidates'][lead]), ('evidence', e, r['candidateEvidence'][lead]),
                            ('reason', result['reason'], r['candidateReasons'][lead]),
                            ('hybrid', hybrid, old_window[key(r)]['candidates'][lead])):
                            if value != expected:
                                mismatches.append(dict(key=key(r), arm=lead, field=field, previous=expected, new=value))
                        checks['originalLeadComparisons'] += 1
            generated.append(dict(r, candidates=candidates, underlyingCandidates=underlying,
                candidateReasons=reasons, candidateEvidence=evidence, clockFeatures=features[key(r)]))
    (OUT / 'forecast-control-discrepancies.json').write_text(json.dumps(mismatches, indent=2))
    assert not mismatches, 'Original lead differs: HALT before joining/scoring outcomes'
    write('unscored', generated)
    unscored_hash = digest(OUT / 'unscored.jsonl.gz')
    # No labels are attached or opened before all arms and original-control checks persist.
    labels = [r for r in read(CANONICAL / 'forecasts.jsonl.gz') if r['route'] == 19]
    generated_by_key = {key(r): r for r in generated}
    scored, lookup = [], {}
    source_hash, joined_hash = hashlib.sha256(), hashlib.sha256()
    for old in labels:
        r = dict(generated_by_key[key(old)], label=old['label'], truth=old['truth'], outcomeReason=old['outcomeReason'])
        assert window.projection(r) == window.projection(old)
        source_hash.update(window.projection(old).encode())
        joined_hash.update(window.projection(r).encode())
        scored.append(r)
        lookup[key(r)] = r['label']
    assert source_hash.digest() == joined_hash.digest()
    write('forecasts', scored)
    enriched = [dict(r, label=lookup.get(key(r))) for r in generated]
    union = [r for r in scored if any(r['candidates'][a] != r['deployed'] for a in ARMS)]
    original_union = [r for r in scored if any(r['candidates'][a + '_original'] != r['deployed'] for a in LEADS)]
    scopes = {'all': scored, 'fourArmUnion': union, 'originalLeadUnion': original_union}
    summary = dict(arms=ARMS, leads=LEADS, generated=len(generated), labelled=len(scored),
        availability=dict(physicalVisits=len({r['label']['id'] for r in scored}),
            dates=sorted({ev.date(r['at']) for r in scored}), generatedUnlabelled=len(generated)-len(scored)),
        comparisons={}, armsDetail={}, training=training,
        note='Fixed four-arm directed-leg development comparison. Exact deployed point/early protection; no promotion or new dates.')
    summary['leadComparisons'] = {}
    for lead in LEADS:
        names = (lead+'_original', lead+'_directed')
        paired = [r for r in scored if any(r['candidates'][a] != r['deployed'] for a in names)]
        summary['leadComparisons'][lead] = window.common(paired,names)
    for name, rows in scopes.items():
        summary['comparisons'][name] = window.common(rows, ARMS)
    for arm in ARMS:
        rows = [r for r in scored if r['candidates'][arm] != r['deployed']]
        order = rr.ordering(scored, arm)
        handoff = rr.handoffs(enriched, arm)
        lead, cell = split(arm)
        if cell == 'original':
            prior = json.loads((WINDOW / 'summary.json').read_text())['routes']['19'][lead]['handoffs']
            assert handoff == prior, 'Original handoff cohort/clock changed'
        summary['armsDetail'][arm] = dict(changed=window.paired(rows, arm),
            consistency={name: consistency(rs, arm) for name, rs in scopes.items()},
            generatedReasons=dict(collections.Counter(r['candidateReasons'][arm] for r in generated)),
            unmatchedReasons=dict(collections.Counter(r['candidateReasons'][arm] for r in enriched if not r['label'])),
            ordering=order, generatedOrdering=rr.ordering(generated, arm), handoffs=handoff,
            commonNumericalGateFailures=window.gates(window.paired(union, arm), order),
            days={day: window.paired([r for r in union if ev.date(r['at']) == day], arm) for day in sorted({ev.date(r['at']) for r in scored})},
            stops={str(t): window.paired([r for r in union if r['targetIndex'] == t], arm) for t in sorted({r['targetIndex'] for r in union})})
    assert digest(OUT / 'unscored.jsonl.gz') == unscored_hash
    assert before == {file: digest(WINDOW / file) for file in protected}
    assert canonical_before == {file: digest(CANONICAL/file) for file in canonical_files}
    assert raw_hashes == {file: digest(Path(file)) for file in raw_hashes}
    (OUT / 'summary.json').write_text(json.dumps(summary, indent=2) + '\n')
    audit = dict(rawHashes=raw_hashes, canonicalInputHashes=canonical_before, canonicalBytesUnchanged=True, priorWindowHashes=before, priorWindowBytesUnchanged=True,
        checks=dict(checks), generatedRows=len(generated), labelledRows=len(scored),
        originalFeatureAndLeadIdentity=True, physicalSourcePathFitGatesPassed=True, unscoredPersistedBeforeLabels=True,
        unscoredSha256=unscored_hash, canonicalLabelBaselineProjectionSha256=source_hash.hexdigest(),
        joinedLabelBaselineProjectionSha256=joined_hash.hexdigest(),
        pointChanges=0, laterLowerBounds=0, unsupportedChanges=0)
    (OUT / 'audit.json').write_text(json.dumps(audit, indent=2) + '\n')
    print(json.dumps(audit))


if __name__ == '__main__':
    main()
