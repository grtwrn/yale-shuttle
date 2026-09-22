"""Small synthetic regressions. CI only, alongside the full hosted audit."""
import gzip
import hashlib
import json
from pathlib import Path
import tempfile
import unittest

from coverage import audit, bounds, finality, inspect_file, interval_supported

DAY = '2026-09-17'
AT = bounds(DAY)[0] + 9 * 3_600_000
TOP = {'routes': [{'id': 2, 'name': 'Orange Day'}, {'id': 14, 'name': 'Orange Night'}]}


def write_file(root, table, rows):
    folder = root / DAY
    folder.mkdir(exist_ok=True)
    payload = gzip.compress(('\n'.join(json.dumps(r) for r in rows) + '\n').encode())
    path = folder / (table + '.jsonl.gz')
    path.write_bytes(payload)
    return dict(path=f'{DAY}/{path.name}', file=path.name, bytes=len(payload),
                sha256=hashlib.sha256(payload).hexdigest(), rows=len(rows), complete=True)


def fixture(root, gps=True, rider=True, exported='2026-09-18T07:40:00Z'):
    common = dict(bus_id=101, bus_name='300', route_id=2)
    raw = [{**common, 'collected_at': AT + n * 30_000} for n in range(7)] if gps else []
    visit = {**common, 'id': 1, 'anchored_at': AT, 'arrived_at': AT,
             'departed_at': AT + 180_000, 'how': 'observed', 'outcome': 'stopped'}
    pred = {**common, 'id': 1, 'predicted_at': AT, 'surface': 'trip' if rider else 'upstream', 'client_build': 'bundle'}
    tables = {'raw_positions': raw, 'stop_visits': [visit], 'arrivals': [{**common, 'id': 1, 'arrived_at': AT}], 'predictions_log': [pred]}
    entries = {t: write_file(root, t, rows) for t, rows in tables.items()}
    (root / DAY / 'manifest.json').write_text(json.dumps(dict(day=DAY, generatedAt=exported, tables=entries)))
    return entries


class CoverageTest(unittest.TestCase):
    def test_et_boundaries_follow_dst(self):
        self.assertEqual(bounds('2026-11-01')[1] - bounds('2026-11-01')[0], 25 * 3_600_000)
        self.assertEqual(bounds('2026-03-08')[1] - bounds('2026-03-08')[0], 23 * 3_600_000)

    def test_finality_does_not_confuse_snapshot_date_and_export_date(self):
        self.assertEqual(finality(DAY, '2026-09-17T16:00:00Z', '2026-09-21T00:00:00Z'), 'partial')
        self.assertEqual(finality(DAY, None, '2026-09-21T00:00:00Z'), 'unknown_export_finality')
        self.assertEqual(finality(DAY, '2026-09-18T07:40:00Z'), 'closed')

    def test_good_observed_route_and_absent_route_are_distinct(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            fixture(root)
            result = audit(root, TOP)
            orange, night = result['routes']
            self.assertTrue(orange['readyForCompleteDayComparison'])
            self.assertEqual(orange['gpsSupportedVisitIntervals'], 1)
            self.assertEqual(night['status'], 'unknown_service')
            self.assertFalse(night['readyForCompleteDayComparison'])

    def test_successful_empty_gps_export_fails_service_coverage(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            fixture(root, gps=False)
            result = audit(root, TOP)
            self.assertTrue(all(not s['errors'] for s in result['sources']))
            orange = result['routes'][0]
            self.assertEqual(orange['serviceBucketsWithoutGps'], 1)
            self.assertIn('gps_absent_with_observed_service', orange['reasons'])

    def test_upstream_rows_do_not_supply_rider_prediction_coverage(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            fixture(root, rider=False)
            orange = audit(root, TOP)['routes'][0]
            self.assertEqual(orange['predictionSurfaces'], {'upstream': 1})
            self.assertIn('no_rider_prediction_rows', orange['reasons'])

    def test_gps_on_another_route_or_bus_does_not_cover_visit(self):
        for other in [{'route_id': 14}, {'bus_name': '301'}]:
            with self.subTest(other=other), tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                entries = fixture(root)
                rows = [dict(bus_id=101, bus_name='300', route_id=2, collected_at=AT + n * 30_000, **{}) for n in range(7)]
                for row in rows:
                    row.update(other)
                entries['raw_positions'] = write_file(root, 'raw_positions', rows)
                (root / DAY / 'manifest.json').write_text(json.dumps(dict(day=DAY, generatedAt='2026-09-18T07:40:00Z', tables=entries)))
                orange = audit(root, TOP)['routes'][0]
                self.assertEqual(orange['serviceBucketsWithoutGps'], 1)
                self.assertEqual(orange['gpsSupportedVisitIntervals'], 0)

    def test_visit_endpoints_do_not_hide_interior_gap(self):
        self.assertFalse(interval_supported([AT, AT + 180_000], AT, AT + 180_000))
        self.assertTrue(interval_supported([AT + n * 30_000 for n in range(7)], AT, AT + 180_000))
        self.assertFalse(interval_supported([AT + 60_000, AT + 90_000], AT, AT + 90_000))

    def test_hash_size_schema_count_timestamp_and_conflict_are_checked(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            rows = [dict(bus_id=1, route_id=2, collected_at=AT), dict(bus_id=1, route_id=14, collected_at=AT), dict(bus_id=2, route_id=2, collected_at=bounds(DAY)[1])]
            entry = write_file(root, 'raw_positions', rows)
            entry.update(sha256='bad', bytes=0, rows=999, columns=['bus_id'])
            _, info = inspect_file(root / entry['path'], entry, 'raw_positions', DAY)
            self.assertEqual(set(info['errors']), {'sha256_mismatch', 'byte_count_mismatch', 'manifest_row_count_mismatch', 'schema_columns_mismatch', 'invalid_or_out_of_day_timestamp', 'conflicting_duplicate_identity'})

    def test_trailer_required_when_header_preserved(self):
        header = dict(table='raw_positions', day=DAY, **dict(zip(('from', 'to'), bounds(DAY))))
        row = dict(bus_id=1, route_id=2, collected_at=AT)
        cases = [([header, row, {'end': True, 'rows': 1}], set()),
                 ([header, row], {'missing_or_misplaced_trailer'}),
                 ([header, row, {'end': True, 'rows': 2}], {'stream_row_count_mismatch'}),
                 ([header, {'end': True, 'rows': 0}, row], {'missing_or_misplaced_trailer'})]
        for objects, expected in cases:
            with self.subTest(expected=expected), tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                entry = write_file(root, 'raw_positions', objects)
                entry.pop('rows')
                _, info = inspect_file(root / entry['path'], entry, 'raw_positions', DAY)
                self.assertEqual(set(info['errors']), expected)

    def test_research_manifest_does_not_invent_original_counts_or_finality(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            entries = fixture(root)
            (root / DAY / 'manifest.json').unlink()
            (root / 'manifest.json').write_text(json.dumps({'sources': [{k: e[k] for k in ('path', 'bytes', 'sha256')} for e in entries.values()]}))
            result = audit(root, TOP, frozen_at='2026-09-21T00:00:00Z')
            self.assertEqual(result['days'][0]['finality'], 'unknown_export_finality')
            self.assertTrue(all(s['stream'] == 'not_preserved' for s in result['sources']))
            self.assertFalse(result['routes'][0]['readyForCompleteDayComparison'])


if __name__ == '__main__':
    unittest.main()
