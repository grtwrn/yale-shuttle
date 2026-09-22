import datetime as dt
import gzip
import hashlib
import http.client
import importlib.util
import io
import json
import signal
import time
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import urllib.error

spec = importlib.util.spec_from_file_location('capture', Path(__file__).with_name('capture.py'))
c = importlib.util.module_from_spec(spec)
spec.loader.exec_module(c)


class Response(io.BytesIO):
    def __init__(self, body, status=200, headers=None):
        super().__init__(body)
        self.status = status
        self.headers = headers or {'Date': 'Tue, 22 Sep 2026 06:00:00 GMT', 'Content-Type': 'application/json'}

    def getcode(self):
        return self.status


class Tests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / 'capture'
        self.until = dt.datetime.now(c.UTC) + dt.timedelta(days=1)
        self.cap = c.Capture(self.root, self.until, 2**25, 0)

    def request(self, body, status=200, headers=None, kind='fleet'):
        with patch.object(self.cap.opener, 'open', return_value=Response(body, status, headers)) as op:
            result = self.cap.request(c.BASE + '/api/buses', kind)
            req = op.call_args.args[0]
            self.assertEqual(req.get_header('Accept-encoding'), 'identity')
            self.assertFalse(req.has_header('x-admin-token'))
            self.assertEqual(op.call_args.kwargs['timeout'], 10)
            return result

    def test_exact_bytes_hashes_and_append_only_chain_with_dedup(self):
        body = b'{ "buses" : [], "routes": {"1":[2,3]} }\n'
        first, got, _ = self.request(body)
        second, _, _ = self.request(body)
        self.assertEqual(got, body)
        blob = (self.root / first['blob']).read_bytes()
        self.assertEqual(gzip.decompress(blob), body)
        self.assertEqual(hashlib.sha256(body).hexdigest(), first['bodySha256'])
        self.assertEqual(hashlib.sha256(blob).hexdigest(), first['blobSha256'])
        self.assertEqual(first['blob'], second['blob'])
        self.assertEqual(len(list((self.root / 'blobs').iterdir())), 1)
        lines = (self.root / 'records.jsonl').read_bytes().splitlines(keepends=True)
        self.assertEqual(second['previousRecordSha256'], c.digest(lines[0]))
        self.assertEqual(self.cap.previous, c.digest(lines[1]))
        self.assertTrue(first['transportComplete'])
        self.assertFalse(self.cap.manifest['outcomesEvaluated'])

    def test_invalid_json_is_transport_evidence_not_empty_fleet(self):
        entry, _, parsed = self.request(b'{broken')
        self.assertTrue(entry['transportComplete'])
        self.assertFalse(entry['jsonObject'])
        self.assertNotIn('busCount', entry)
        self.assertIsNone(parsed)
        for body in [b'[]', b'{"buses": [], "bad": NaN}']:
            self.assertFalse(self.request(body)[0]['jsonObject'])

    def test_missing_and_stale_eta_are_retained_without_replacement(self):
        off = self.request(b'{"buses": []}')[0]
        self.assertFalse(off['hasServerEta'])
        stale = self.request(b'{"buses":[{"bus_id":1,"observed_at":1000}],"server_eta":{"at":1000,"servedAt":100000}}')[0]
        self.assertEqual(stale['forecastAt'], 1000)
        self.assertEqual(stale['servedAt'], 100000)
        self.assertNotIn('etaAvailable', stale)

    def test_http_error_body_is_preserved_but_not_successful(self):
        error = urllib.error.HTTPError(c.BASE + '/api/buses', 503, 'down', {'Content-Type': 'text/plain'}, io.BytesIO(b'busy'))
        with patch.object(self.cap.opener, 'open', side_effect=error):
            entry, body, _ = self.cap.request(c.BASE + '/api/buses', 'fleet')
        self.assertEqual(body, b'busy')
        self.assertEqual(entry['status'], 503)
        self.assertFalse(entry['transportComplete'])

    def test_network_failure_and_partial_read_remain_incomplete(self):
        with patch.object(self.cap.opener, 'open', side_effect=TimeoutError):
            entry, body, _ = self.cap.request(c.BASE + '/api/buses', 'fleet')
        self.assertFalse(entry['transportComplete'])
        self.assertEqual(entry['errorType'], 'TimeoutError')
        self.assertEqual(body, b'')
        response = Response(b'')
        with patch.object(response, 'read1', side_effect=[b'first', TimeoutError()]), patch.object(self.cap.opener, 'open', return_value=response):
            entry, body, _ = self.cap.request(c.BASE + '/api/buses', 'fleet')
        self.assertEqual(body, b'first')
        self.assertFalse(entry['readComplete'])

    def test_body_limit_is_explicit_and_stored_prefix_is_not_complete(self):
        with patch.object(c, 'BODY_LIMIT', 5):
            entry, body, _ = self.request(b'123456789')
        self.assertEqual(body, b'12345')
        self.assertEqual(entry['errorType'], 'BodyLimitExceeded')
        self.assertFalse(entry['transportComplete'])

    def test_content_length_and_incomplete_read_partial_are_not_successful(self):
        entry, body, _ = self.request(b'{"buses":[]}', headers={'Content-Length': '100'})
        self.assertFalse(entry['transportComplete'])
        self.assertEqual(entry['errorType'], 'ContentLengthMismatch')
        response = Response(b'')
        with patch.object(response, 'read1', side_effect=[b'first', http.client.IncompleteRead(b'partial', 40)]), \
             patch.object(self.cap.opener, 'open', return_value=response):
            entry, body, _ = self.cap.request(c.BASE + '/api/buses', 'fleet')
        self.assertEqual(body, b'firstpartial')
        self.assertFalse(entry['transportComplete'])
        self.assertEqual(entry['errorType'], 'IncompleteRead')

    def test_slow_chunks_and_stop_request_preserve_partial_evidence(self):
        state = {'mono': 0.0}
        response = Response(b'')
        def slow_read(size):
            state['mono'] += 4
            return b'part'
        with patch.object(c.time, 'monotonic', side_effect=lambda: state['mono']), \
             patch.object(response, 'read1', side_effect=slow_read), patch.object(self.cap.opener, 'open', return_value=response):
            entry, body, _ = self.cap.request(c.BASE + '/api/buses', 'fleet')
        self.assertEqual(body, b'partpartpart')
        self.assertEqual(entry['errorType'], 'RequestDeadlineExceeded')
        self.assertFalse(entry['transportComplete'])
        response = Response(b'')
        def stopping(size):
            self.cap.stop_requested = True
            return b'part'
        with patch.object(response, 'read1', side_effect=stopping), patch.object(self.cap.opener, 'open', return_value=response):
            entry, body, _ = self.cap.request(c.BASE + '/api/buses', 'fleet')
        self.assertEqual(body, b'part')
        self.assertEqual(entry['errorType'], 'RequestCancelled')

    def test_total_alarm_interrupts_blocking_io_and_restores_handler(self):
        previous = signal.getsignal(signal.SIGALRM)
        with self.assertRaises(c.RequestDeadlineExceeded):
            with c.request_budget(0.02):
                time.sleep(0.5)
        self.assertEqual(signal.getsignal(signal.SIGALRM), previous)
        self.assertEqual(signal.getitimer(signal.ITIMER_REAL), (0.0, 0.0))

    def test_encoding_is_preserved_not_silently_decoded(self):
        wire = gzip.compress(b'{"buses":[]}', mtime=0)
        entry, body, parsed = self.request(wire, headers={'Content-Encoding': 'gzip'})
        self.assertEqual(body, wire)
        self.assertFalse(entry['jsonObject'])
        self.assertIsNone(parsed)

    def test_assets_only_same_origin_js_no_redirect_following(self):
        p = c.Assets()
        p.feed('<script src="/assets/main.js"></script><link rel="modulepreload" href="/assets/chunk.js">'
               '<script src="https://external.invalid/a.js"></script><script src="/api/reports"></script>'
               '<script src="//yale-shuttle.fly.dev.evil/assets/x.js"></script><script src="javascript:x"></script>'
               '<script src="/assets/main.js"></script>')
        self.assertEqual(p.urls, [c.BASE + '/assets/main.js', c.BASE + '/assets/chunk.js'])
        self.assertIsNone(c.NoRedirects().redirect_request(None, None, 302, None, None, 'https://external.invalid'))

    def test_release_assets_captured_initially_and_on_build_change(self):
        build, seen = ['a'], []
        def open_req(req, timeout):
            seen.append(req.full_url)
            if req.full_url.endswith('/healthz'):
                return Response(json.dumps({'build': build[0]}).encode())
            if req.full_url == c.BASE + '/':
                return Response(b'<script type="module" src="/assets/main.js"></script>')
            return Response(b'export const version=1')
        with patch.object(self.cap.opener, 'open', side_effect=open_req):
            self.cap.release()
            self.cap.release()
            build[0] = 'b'
            self.cap.release()
        self.assertEqual(seen.count(c.BASE + '/healthz'), 3)
        self.assertEqual(seen.count(c.BASE + '/'), 2)
        self.assertEqual(seen.count(c.BASE + '/assets/main.js'), 2)

    def test_storage_and_free_space_limits_stop_before_request(self):
        self.cap.max_bytes = c.RESERVE - 1
        with patch.object(self.cap.opener, 'open') as op, self.assertRaisesRegex(c.StopCapture, 'capture-byte-limit'):
            self.cap.request(c.BASE + '/api/buses', 'fleet')
        op.assert_not_called()
        self.cap.max_bytes = 2**25
        with patch.object(c.shutil, 'disk_usage', return_value=SimpleNamespace(free=0)), self.assertRaisesRegex(c.StopCapture, 'filesystem-free-limit'):
            self.cap.request(c.BASE + '/api/buses', 'fleet')

    def test_failed_module_capture_retries_same_build_on_next_health_check(self):
        failed = [True]
        seen = []
        def open_req(req, timeout):
            seen.append(req.full_url)
            if req.full_url.endswith('/healthz'):
                return Response(b'{"build":"a"}')
            if req.full_url == c.BASE + '/':
                return Response(b'<script src="/assets/main.js"></script>')
            return Response(b'body', 503 if failed[0] else 200)
        with patch.object(self.cap.opener, 'open', side_effect=open_req):
            self.cap.release()
            self.assertTrue(self.cap.release_retry)
            failed[0] = False
            self.cap.release()
            self.assertFalse(self.cap.release_retry)
            self.cap.release()
        self.assertEqual(seen.count(c.BASE + '/assets/main.js'), 2)

    def test_main_loop_cadence_deadline_and_explicit_skipped_slots(self):
        real_datetime = dt.datetime
        start = real_datetime.now(c.UTC)
        state = {'mono': 0.0}
        class Clock(real_datetime):
            @classmethod
            def now(cls, tz=None):
                value = start + dt.timedelta(seconds=state['mono'])
                return value.astimezone(tz) if tz else value.replace(tzinfo=None)
        def advance(seconds):
            state['mono'] += seconds
        requests = []
        def open_req(req, timeout):
            requests.append((req.full_url, state['mono']))
            advance(1)
            if req.full_url.endswith('/healthz'):
                return Response(b'{"build":"a"}')
            if req.full_url == c.BASE + '/':
                return Response(b'<script src="/assets/main.js"></script>')
            return Response(b'{"buses":[]}' if req.full_url.endswith('/api/buses') else b'export{}')
        self.cap.until = start + dt.timedelta(seconds=90)
        with patch.object(c.dt, 'datetime', Clock), patch.object(c.time, 'monotonic', side_effect=lambda: state['mono']), \
             patch.object(c.time, 'sleep', side_effect=advance), patch.object(self.cap.opener, 'open', side_effect=open_req), \
             patch('sys.stdout', io.StringIO()):
            self.cap.run()
        self.assertEqual([t for url, t in requests if url.endswith('/api/buses')], [3, 15, 30, 45, 61, 75])
        self.assertEqual([t for url, t in requests if url.endswith('/healthz')], [0, 60])
        self.assertEqual(self.cap.manifest['stopReason'], 'deadline')
        self.assertEqual(self.cap.manifest['skippedTicks'], 0)
        # A delayed request is captured at its real receipt time, not backfilled.
        slow = c.Capture(Path(self.temp.name) / 'slow', start + dt.timedelta(seconds=42), 2**25, 0)
        state['mono'] = 0
        def slow_open(req, timeout):
            response = open_req(req, timeout)
            if req.full_url.endswith('/api/buses'):
                advance(34)
            return response
        with patch.object(c.dt, 'datetime', Clock), patch.object(c.time, 'monotonic', side_effect=lambda: state['mono']), \
             patch.object(c.time, 'sleep', side_effect=advance), patch.object(slow.opener, 'open', side_effect=slow_open), \
             patch('sys.stdout', io.StringIO()):
            slow.run()
        records = [json.loads(line) for line in (slow.output / 'records.jsonl').read_text().splitlines()]
        self.assertEqual(sum(r['kind'] == 'fleet' for r in records), 1)
        self.assertEqual(slow.manifest['skippedTicks'], 2)
        self.assertEqual([r['skippedTicks'] for r in records if r['kind'] == 'schedule-gap'], [2])

    def test_response_that_exceeds_remaining_storage_leaves_explicit_metadata(self):
        self.cap.max_bytes = c.RESERVE + 100
        with self.assertRaises(c.StopCapture):
            self.request(b'{"buses":[]}')
        self.assertEqual(self.cap.manifest['unpersistedResponse']['bodyBytes'], 12)
        self.assertFalse((self.root / 'records.jsonl').exists())

    def test_deadline_signal_and_existing_output_refusal(self):
        self.cap.until = dt.datetime.now(c.UTC) - dt.timedelta(seconds=1)
        with patch.object(self.cap.opener, 'open') as op, io.StringIO() as printed, patch('sys.stdout', printed):
            self.cap.run()
        op.assert_not_called()
        self.assertEqual(json.loads((self.root / 'manifest.json').read_text())['stopReason'], 'deadline')
        with self.assertRaises(FileExistsError):
            c.Capture(self.root, self.until, 2**25, 0)
        self.cap.until = self.until
        self.cap.stop_requested = True
        with self.assertRaisesRegex(c.StopCapture, 'signal'):
            self.cap.allowed()

    def test_cadence_skips_overdue_slots_without_catchup_and_utc_is_explicit(self):
        self.assertEqual(c.next_tick(0, 2, 15), (15, 0))
        self.assertEqual(c.next_tick(0, 16, 15), (30, 1))
        self.assertEqual(c.next_tick(0, 61, 15), (75, 4))
        self.assertEqual(c.utc_end('2026-09-30T04:00:00Z').utcoffset(), dt.timedelta(0))
        for value in ['2026-09-30T04:00:00', '2026-09-30T04:00:00-04:00']:
            with self.assertRaises(ValueError):
                c.utc_end(value)


if __name__ == '__main__':
    unittest.main()
