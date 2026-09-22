"""Hosted training-path/fit parity only; no outcome labels or scores are opened."""
import collections
import gzip
import hashlib
import importlib.util
import json
from pathlib import Path
import sys

HERE = Path(__file__).resolve().parent
OUT = HERE / 'results'
CANONICAL = HERE / 'input/canonical/canonical-windows/results'

def read(p):
    with gzip.open(p, 'rt') as f:
        return [json.loads(s) for s in f if s.strip()]

def write(name, rows):
    with gzip.open(OUT / (name + '.jsonl.gz'), 'wt') as f:
        for row in rows:
            f.write(json.dumps(row, separators=(',', ':'), sort_keys=True) + '\n')

def module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    result = importlib.util.module_from_spec(spec)
    sys.modules[name] = result
    spec.loader.exec_module(result)
    return result

def physical(v):
    return {k: v[k] for k in ('bus_name', 'bus_id', 'route_id', 'stop_index', 'stop_id',
                              'arrived_at', 'departed_at', 'known_at')}

def canonical_bytes(row):
    return json.dumps(row, separators=(',', ':'), sort_keys=True)

def paths(model, visits):
    by_id = {v['id']: v for v in visits}
    rows = []
    for cell, ps in model.paths.items():
        if cell[0] != 19:
            continue
        for p in ps:
            row = {k: v for k, v in p.items() if k not in ('sourceId', 'targetId')}
            row.update(cell=cell, source=physical(by_id[p['sourceId']]), target=physical(by_id[p['targetId']]))
            rows.append(row)
    return sorted(rows, key=canonical_bytes)

def main():
    control = json.loads((OUT / 'feature-parity.json').read_text())
    assert control['originalLeadAndNonBrownFeatureParity'] and control['sourceDepartureKnownAtParity']
    c = module('directed_canonical', HERE.parent / 'canonical-windows/study.py')
    c.OUT = CANONICAL
    c.configure()
    assert c.ev.MODEL_CAP == 5400 and c.ev.WAITS[19] == [0, 5]
    raw = read(c.ev.IN / 'raw_positions.jsonl.gz')
    baseline, candidate = read(OUT / 'baseline-visits.jsonl.gz'), read(OUT / 'candidate-visits.jsonl.gz')
    features = read(OUT / 'baseline-features.jsonl.gz') + read(OUT / 'candidate-features.jsonl.gz')
    features = [r for r in features if r['route'] == 19 and r['at'] >= c.ev.TEST]
    days = sorted({c.ev.date(r['at']) for r in features})
    fixed_days = ['2026-09-17', '2026-09-18', '2026-09-19', '2026-09-20']
    assert days and set(days).issubset(fixed_days)
    cutoffs = sorted({c.FROZEN, *(c.rr.cutoff_for(day) for day in fixed_days)})
    audits, differences, fits = [], [], []
    for cutoff in cutoffs:
        old, old_audit = c.fit(baseline, raw, cutoff)
        new, new_audit = c.fit(candidate, raw, cutoff)
        a, b = paths(old, baseline), paths(new, candidate)
        write(f'baseline-paths-{cutoff}', a)
        write(f'candidate-paths-{cutoff}', b)
        ac, bc = collections.Counter(map(canonical_bytes, a)), collections.Counter(map(canonical_bytes, b))
        for key in sorted(ac.keys() | bc.keys()):
            if ac[key] != bc[key]:
                differences.append(dict(cutoff=cutoff, kind='training path', path=json.loads(key),
                                        baseline=ac[key], candidate=bc[key]))
        # Fit parity includes every fixed Brown source clock in the archive and
        # all target groups for both retained leads, including unsupported fits.
        queries = set()
        for r in features:
            for k in (5, 8):
                for wait in c.ev.WAITS[19]:
                    source = str((wait-k) % len(c.ev.ROUTES[19]['stops']))
                    origin = r['origins'].get(source)
                    if origin:
                        assert origin['departed'] <= origin['knownAt'] <= r['asof']
                        for target in c.ev.targets(19, wait):
                            queries.add((19, k, wait, target, origin['departed']))
        for query in sorted(queries):
            x, y = old.fit(*query), new.fit(*query)
            fits.append(dict(cutoff=cutoff, query=query, baseline=x, candidate=y))
            if x != y:
                differences.append(dict(cutoff=cutoff, kind='fit', query=query, baseline=x, candidate=y))
        audits.append(dict(cutoff=cutoff, baseline=old_audit, candidate=new_audit,
                           BrownPaths=len(a), BrownFitQueries=len(queries)))
    write('path-fit-discrepancies', differences)
    write('fit-comparisons', fits)
    result = dict(gate='HALTED: path/fit discrepancy' if differences else 'PATH/FIT PARITY PASSED; original forecast controls still required',
                  pathFitDifferences=len(differences), cutoffs=audits, scoresProduced=False,
                  originalModelParametersUnchanged=True, physicalIdentityIncludesActualKnownAt=True)
    (OUT / 'model-parity.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(dict(gate=result['gate'], cutoffs=len(cutoffs), fitQueries=len(fits), differences=len(differences))))
    assert not differences, 'Frozen path/fit gate failed: HALT before scoring'

if __name__ == '__main__':
    main()
