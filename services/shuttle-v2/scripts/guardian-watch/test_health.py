import io
import json
import socket
import ssl
import subprocess
import unittest
import urllib.error
from unittest.mock import patch
import poll


class Response(io.BytesIO):
    status = 200


class ProductionHealthTests(unittest.TestCase):
    def setUp(self):
        self.alert_patch = patch.object(poll, 'raise_incident')
        self.alert = self.alert_patch.start()
        self.addCleanup(self.alert_patch.stop)
        self.clock_patch = patch.object(poll, 'now', return_value=1792673000)
        self.clock_patch.start()
        self.addCleanup(self.clock_patch.stop)
        self.dns = urllib.error.URLError(socket.gaierror(socket.EAI_NONAME, 'lookup unavailable'))
        self.payload = {'httpStatus': 200, 'health': {'ok': True, 'build': '80b252cb4b22'},
                        'transport': {'dnsFallbackAttempts': 1, 'dnsFallbackResponses': 1}}

    def test_ordinary_health_success_uses_no_child_and_clears_failure_count(self):
        state = {'healthFails': 2}
        with patch.object(poll.urllib.request, 'urlopen', return_value=Response(b'{"ok":true}')) as primary, \
                patch.object(poll.subprocess, 'run') as child:
            poll.check_health(state)
        primary.assert_called_once_with(poll.HEALTH, timeout=15)
        child.assert_not_called()
        self.assertEqual(state['healthFails'], 0)
        self.assertTrue(state['healthCheck']['ok'])
        self.assertFalse(state['healthCheck']['dnsFallbackAttempted'])
        self.alert.assert_not_called()

    def test_dns_recovery_checks_result_and_preserves_original_failure(self):
        state = {'healthFails': 2}
        result = subprocess.CompletedProcess([], 0, json.dumps(self.payload), '')
        with patch.object(poll.urllib.request, 'urlopen', side_effect=self.dns), \
                patch.object(poll.subprocess, 'run', return_value=result) as child:
            poll.check_health(state)
        args, kwargs = child.call_args
        self.assertTrue(args[0][1].endswith('/guardian-watch/health.mjs'))
        self.assertEqual(kwargs, {'capture_output': True, 'text': True, 'timeout': 15, 'check': False})
        self.assertEqual(state['healthFails'], 0)
        self.assertEqual(state['healthDNSFallbacks'], 1)
        self.assertTrue(state['healthDNSLastFallback']['ok'])
        self.assertIn('lookup unavailable', state['healthDNSLastFallback']['detail']['primaryFailure'])
        self.alert.assert_not_called()

    def test_only_dns_error_types_and_supported_lookup_codes_retry(self):
        for code in [socket.EAI_NONAME, socket.EAI_AGAIN, socket.EAI_FAIL]:
            with self.subTest(code=code):
                self.assertTrue(poll.health_dns_failure(socket.gaierror(code, 'lookup')))
                self.assertTrue(poll.health_dns_failure(urllib.error.URLError(socket.gaierror(code, 'lookup'))))
        for error in [urllib.error.URLError('DNS failed'), TimeoutError('lookup'),
                      socket.gaierror(socket.EAI_MEMORY, 'allocation failed')]:
            self.assertFalse(poll.health_dns_failure(error))

    def test_http_tls_timeout_and_invalid_json_do_not_start_dns_retry(self):
        errors = [TimeoutError('timed out'), ssl.SSLCertVerificationError('untrusted'),
                  urllib.error.URLError(ssl.SSLCertVerificationError('untrusted')),
                  urllib.error.HTTPError(poll.HEALTH, 503, 'unavailable', {}, None)]
        for error in errors:
            with self.subTest(error=type(error).__name__), \
                    patch.object(poll.urllib.request, 'urlopen', side_effect=error), \
                    patch.object(poll.subprocess, 'run') as child:
                state = {'healthFails': 2}
                poll.check_health(state)
                child.assert_not_called()
                self.assertEqual(state['healthFails'], 3)
        with patch.object(poll.urllib.request, 'urlopen', return_value=Response(b'{')), \
                patch.object(poll.subprocess, 'run') as child:
            state = {}
            poll.check_health(state)
            child.assert_not_called()
            self.assertEqual(state['healthFails'], 1)

    def test_fallback_http_error_or_false_health_still_alerts_at_three(self):
        for status, ok in [(503, True), (200, False)]:
            with self.subTest(status=status, ok=ok), \
                    patch.object(poll.urllib.request, 'urlopen', side_effect=self.dns), \
                    patch.object(poll, 'recover_health_dns', return_value={**self.payload,
                        'httpStatus': status, 'health': {'ok': ok}}):
                self.alert.reset_mock()
                state = {'healthFails': 2}
                poll.check_health(state)
                self.assertEqual(state['healthFails'], 3)
                self.alert.assert_called_once()
                self.assertEqual(self.alert.call_args.args[1], 'prod-health')
                self.assertIn('primaryFailure', self.alert.call_args.args[5]['last'])

    def test_broken_or_timed_out_child_preserves_failure_and_alert(self):
        for error in [subprocess.TimeoutExpired('node', 15), FileNotFoundError('node missing')]:
            with self.subTest(error=type(error).__name__), \
                    patch.object(poll.urllib.request, 'urlopen', side_effect=self.dns), \
                    patch.object(poll.subprocess, 'run', side_effect=error):
                self.alert.reset_mock()
                state = {'healthFails': 2}
                poll.check_health(state)
                self.assertEqual(state['healthFails'], 3)
                self.assertFalse(state['healthDNSLastFallback']['ok'])
                self.alert.assert_called_once()

    def test_invalid_child_results_cannot_claim_recovery(self):
        invalid = [None, [], {}, {**self.payload, 'httpStatus': True},
                   {**self.payload, 'httpStatus': '200'}, {**self.payload, 'health': {'ok': 'true'}},
                   {**self.payload, 'transport': None}]
        for payload in invalid:
            with self.subTest(payload=payload), patch.object(poll.subprocess, 'run',
                    return_value=subprocess.CompletedProcess([], 0, json.dumps(payload), '')):
                with self.assertRaises(ValueError):
                    poll.recover_health_dns()
        for code, text in [(1, json.dumps(self.payload)), (0, ' ' * 8193), (0, '{')]:
            with self.subTest(code=code, size=len(text)), patch.object(poll.subprocess, 'run',
                    return_value=subprocess.CompletedProcess([], code, text, '')):
                with self.assertRaises(ValueError):
                    poll.recover_health_dns()

    def test_three_failed_retries_alert_once_and_counter_is_bounded(self):
        state = {'healthDNSFallbacks': 999999}
        with patch.object(poll.urllib.request, 'urlopen', side_effect=self.dns), \
                patch.object(poll, 'recover_health_dns', side_effect=ValueError('failed')):
            for _ in range(4):
                poll.check_health(state)
        self.assertEqual(state['healthFails'], 4)
        self.assertEqual(state['healthDNSFallbacks'], 1000000)
        self.alert.assert_called_once()


if __name__ == '__main__':
    unittest.main()
