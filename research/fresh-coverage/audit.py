"""Hosted-only coverage audit. No model fitting or prediction error scoring."""
import hashlib
import json
from pathlib import Path
import shutil
import sys

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / 'archive-coverage'))
import coverage as cov


def main():
    out = HERE / 'results'
    out.mkdir(exist_ok=True)
    staged = out / 'normalized-input'
    staged.mkdir(exist_ok=False)
    provenance = {}
    for day in ('2026-09-20', '2026-09-21'):
        source = HERE / 'data' / day
        original = json.loads((source / 'manifest.json').read_text())
        capture = 'startedAt' in original
        meta = dict(day=day, generatedAt=original['startedAt'] if capture else original['generatedAt'],
                    tables={})
        provenance[day] = dict(originalManifestSha256=hashlib.sha256((source/'manifest.json').read_bytes()).hexdigest(),
            format='original API envelope' if capture else 'legacy row-only',
            captureStarted=meta['generatedAt'], labelsFinal=original.get('labelsFinal', 'not independently established'),
            calendarClosedOnly=True, untouchedHoldout=False)
        dest = staged / day
        dest.mkdir()
        for table, entry in original['tables'].items():
            path = source / entry['file']
            payload = path.read_bytes()
            assert hashlib.sha256(payload).hexdigest() == entry['sha256']
            assert len(payload) == entry['bytes']
            shutil.copyfile(path, dest / path.name)
            item = dict(entry)
            if capture:
                item.update(rows=entry['observedRows'], complete=entry['transportComplete'],
                            columns=entry['header']['columns'])
            meta['tables'][table] = item
        (dest / 'manifest.json').write_text(json.dumps(meta, indent=2)+'\n')
    freeze = json.loads((HERE/'data/2026-09-21/manifest.json').read_text())
    assert hashlib.sha256((HERE/'freeze-fleet.py').read_bytes()).hexdigest() == freeze['captureScriptSha256']
    topology = json.loads((HERE/'topology-reference.json').read_text())
    before = json.loads((HERE/'data/2026-09-21/fleet-before.json').read_text())
    after = json.loads((HERE/'data/2026-09-21/fleet-after.json').read_text())
    topology_comparison = []
    for route in topology['routes']:
        rid = str(route['id'])
        topology_comparison.append(dict(route=route['name'], id=route['id'],
            reference=route['stops'], capturedBefore=before['routes'].get(rid),
            capturedAfter=after['routes'].get(rid),
            referenceEqualsCaptured=route['stops'] == before['routes'].get(rid),
            stableDuringCapture=before['routes'].get(rid) == after['routes'].get(rid)))
    result = cov.audit(staged, topology, freeze['finishedAt'], ['2026-09-20','2026-09-21'])
    result['captureProvenance'] = provenance
    result['topologyComparison'] = topology_comparison
    result['caveats'] += [
        'Closed finality means calendar boundary only; Sep21 early export is explicitly unsettled.',
        'No ETA errors or candidate performance were scored. Sep21 is partially inspected development evidence.',
        'Use separately captured settlement/adjacent-day evidence for later causal reconstruction.',
    ]
    errors = [x for x in result['sources'] if x['errors']]
    assert len(result['sources']) == 14
    assert not errors, errors
    assert all(x['stream'] == 'verified' for x in result['sources'] if x['day'] == '2026-09-21')
    cov.write_report(result, out)
    print(json.dumps(dict(sources=len(result['sources']), inputErrors=len(errors),
                         routes=len(result['routes']), candidateScoresComputed=False)))


if __name__ == '__main__':
    main()
