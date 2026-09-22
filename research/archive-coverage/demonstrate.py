"""Fixed regression expectation for known archival loss; not a promotion test."""
import json
from pathlib import Path

report = json.loads((Path(__file__).parent / 'results/coverage.json').read_text())
assert not any(s['errors'] for s in report['sources']), 'Input integrity failed'
by_key = {(r['day'], r['route']): r for r in report['routes']}
for day in ('2026-09-11', '2026-09-14', '2026-09-15'):
    row = by_key[day, 2]
    assert row['totals'].get('gps', 0) == 0, row
    assert row['totals']['visit'] > 0 and row['serviceBucketsWithoutGps'] > 0, row
    assert not row['readyForCompleteDayComparison'], row
    assert 'gps_absent_with_observed_service' in row['reasons'], row
for day in ('2026-09-16', '2026-09-17', '2026-09-18'):
    row = by_key[day, 2]
    assert row['totals']['gps'] > 0 and row['gpsSupportedVisitIntervals'] > 0, row
    # Characterize remaining gaps; a large nonzero GPS count is not a pass.
    assert not row['readyForCompleteDayComparison'], row
assert all(d['finality'] == 'unknown_export_finality' for d in report['days'])
print(json.dumps({'knownOrangeLossDetected': ['2026-09-11', '2026-09-14', '2026-09-15'],
                  'orange': [by_key[day, 2] for day in sorted({k[0] for k in by_key})]}, indent=2))
