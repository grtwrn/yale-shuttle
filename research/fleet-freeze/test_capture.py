import contextlib
import datetime as dt
import gzip
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import urllib.error
import urllib.parse
from zoneinfo import ZoneInfo

spec = importlib.util.spec_from_file_location('capture', Path(__file__).with_name('capture.py'))
capture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(capture)


class Clock(dt.datetime):
    @classmethod
    def now(cls, tz=None):
        fixed = cls(2026, 9, 22, 7, 45, tzinfo=dt.timezone.utc)
        return fixed.astimezone(tz) if tz else fixed.replace(tzinfo=None)


class Response(io.BytesIO):
    headers = {'Date': 'Tue, 22 Sep 2026 07:45:00 GMT', 'Content-Type': 'application/x-ndjson'}


class CaptureTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name)
        (self.home / '.yale-shuttle-admin-token').write_text('test-token-do-not-print')
        self.output = self.home / 'capture'
        self.suffix, self.trailer, self.corrupt, self.http_failure = {}, {}, {}, set()
        self.requests = []
        self.streams = {}
        for patcher in [patch.object(capture.Path, 'home', return_value=self.home),
                        patch.object(capture.dt, 'datetime', Clock),
                        patch.object(capture.urllib.request, 'urlopen', side_effect=self.open)]:
            patcher.start()
            self.addCleanup(patcher.stop)

    def open(self, request, timeout):
        url = request if isinstance(request, str) else request.full_url
        self.requests.append(url)
        if '/api/archive/day?' not in url:
            return Response(json.dumps({'build': 'fixed-build', 'routes': {}}).encode())
        self.assertEqual(request.get_header('X-admin-token'), 'test-token-do-not-print')
        query = urllib.parse.parse_qs(urllib.parse.urlsplit(url).query)
        day, table = query['day'][0], query['table'][0]
        if table in self.http_failure:
            raise urllib.error.HTTPError(url, 503, 'unavailable', {}, None)
        date = dt.date.fromisoformat(day)
        start = Clock.combine(date, dt.time(), ZoneInfo('America/New_York'))
        end = Clock.combine(date + dt.timedelta(days=1), dt.time(), ZoneInfo('America/New_York'))
        header = dict(table=table, day=day, **{'from': int(start.timestamp()*1000), 'to': int(end.timestamp()*1000)},
                      columns=['id'], build='fixed-build')
        lines = [json.dumps(header), self.corrupt.get(table, '{"id":1}')]
        trailer = self.trailer.get(table, {'end': True, 'rows': 1})
        if trailer is not None:
            lines.append(json.dumps(trailer))
        lines.extend(self.suffix.get(table, []))
        data = ('\n'.join(lines) + '\n').encode()
        self.streams[table] = data
        return Response(data)

    def run_capture(self, day='2026-09-21', *extra):
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            try:
                capture.main([day, str(self.output), *extra])
                code = 0
            except SystemExit as error:
                code = error.code
        self.assertNotIn('test-token-do-not-print', output.getvalue())
        return code, json.loads((self.output / 'manifest.json').read_text())

    def test_preserves_exact_wrappers_and_hashes_without_finality_claim(self):
        code, manifest = self.run_capture()
        self.assertEqual(code, 0)
        self.assertTrue(manifest['calendarDayClosed'])
        self.assertFalse(manifest['labelsFinal'])
        self.assertEqual(manifest['holdoutStatus'], 'not assessed by export')
        self.assertEqual(len(manifest['tables']), 7)
        for table, entry in manifest['tables'].items():
            data = (self.output / entry['file']).read_bytes()
            self.assertEqual(gzip.decompress(data), self.streams[table])
            self.assertEqual(hashlib.sha256(data).hexdigest(), entry['sha256'])
            self.assertEqual(hashlib.sha256(self.streams[table]).hexdigest(), entry['rawSha256'])
            self.assertEqual(entry['observedRows'], 1)

    def test_open_day_requires_explicit_context_option(self):
        with self.assertRaises(AssertionError):
            self.run_capture('2026-09-22')
        self.assertEqual(self.requests, [])
        code, manifest = self.run_capture('2026-09-22', '--allow-open-day')
        self.assertEqual(code, 0)
        self.assertFalse(manifest['calendarDayClosed'])
        self.assertFalse(manifest['labelsFinal'])

    def test_future_day_refused_even_with_context_option(self):
        with self.assertRaises(AssertionError):
            self.run_capture('2026-09-23', '--allow-open-day')
        self.assertEqual(self.requests, [])

    def test_existing_directory_is_never_overwritten(self):
        self.run_capture()
        before = (self.output / 'manifest.json').read_bytes()
        self.requests.clear()
        with self.assertRaises(FileExistsError):
            self.run_capture()
        self.assertEqual(self.requests, [])
        self.assertEqual((self.output / 'manifest.json').read_bytes(), before)

    def test_missing_and_wrong_trailers_do_not_stop_other_exports(self):
        self.trailer = {'raw_positions': None, 'arrivals': {'end': True, 'rows': 2},
                        'stop_visits': {'end': True, 'rows': True}}
        code, manifest = self.run_capture()
        self.assertEqual(code, 1)
        for table in capture.TABLES:
            self.assertEqual(manifest['tables'][table]['transportComplete'], table not in self.trailer)

    def test_trailing_data_duplicate_trailer_and_invalid_json_are_rejected(self):
        self.suffix = {'raw_positions': ['{"id":2}'], 'arrivals': ['{"end":true,"rows":1}']}
        self.corrupt = {'stop_visits': '{broken-json'}
        code, manifest = self.run_capture()
        self.assertEqual(code, 1)
        for table in ['raw_positions', 'arrivals', 'stop_visits']:
            entry = manifest['tables'][table]
            self.assertFalse(entry['transportComplete'])
            self.assertTrue((self.output / entry['file']).exists())
        self.assertTrue(manifest['tables']['legs']['transportComplete'])

    def test_http_failure_is_retained_and_other_tables_still_capture(self):
        self.http_failure.add('raw_positions')
        code, manifest = self.run_capture()
        self.assertEqual(code, 1)
        self.assertEqual(manifest['tables']['raw_positions']['errorType'], 'HTTPError')
        self.assertTrue(manifest['tables']['scorecard_days']['transportComplete'])


if __name__ == '__main__':
    unittest.main()
