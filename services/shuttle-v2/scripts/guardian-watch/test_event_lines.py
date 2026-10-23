import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import poll


class RiderEventLineTests(unittest.TestCase):
    def scan(self, events, prior=None):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'events.jsonl'
            path.write_text(''.join(json.dumps(e) + '\n' for e in events))
            state = {'since': 0, 'journeyAlertsSince': 0, 'open': {}}
            watcher = {'offset': 0, 'runs': dict(prior or {})}
            with patch.object(poll, 'raise_incident') as incident, patch.object(poll, 'screenshots', return_value=[]):
                poll.scan_events(state, watcher, directory)
            return incident.call_args_list, watcher

    def event(self, kind, detail, **extra):
        return {'at': '2026-10-18T12:00:00Z', 'runId': 'transfer1', 'kind': kind, 'detail': detail, **extra}

    def test_second_leg_candidate_uses_current_line_instead_of_first_leg(self):
        calls, watcher = self.scan([
            self.event('journey-started', {'line': 'Blue Day'}, line='Blue Day'),
            self.event('transfer-handoff', {'next': {'routeLabel': 'Orange Day'}}, line='Orange Day'),
            self.event('candidate-transfer-screen', {'text': 'Second pickup'}, line='Orange Day'),
        ])
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0].args[2], 'Orange Day')
        self.assertIn('Orange Day', calls[0].args[4])
        self.assertEqual(watcher['runs']['transfer1'], 'Blue Day')

    def test_second_leg_failed_journey_uses_current_line(self):
        calls, _ = self.scan([self.event('journey-finished', 'transfer-screen-timeout-needs-review', line='Orange Day')], {'transfer1': 'Blue Day'})
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0].args[2], 'Orange Day')

    def test_resumed_second_leg_candidate_has_a_line_without_an_earlier_start_event(self):
        calls, _ = self.scan([self.event('candidate-exit-instruction', {'text': 'Second ride'}, line='Orange Day')])
        self.assertEqual(calls[0].args[2], 'Orange Day')

    def test_legacy_events_keep_the_original_journey_mapping(self):
        calls, _ = self.scan([
            self.event('journey-started', {'line': 'Blue Day'}),
            self.event('candidate-transfer-screen', {'text': 'Legacy record'}),
            self.event('journey-finished', 'ride-timeout-needs-review'),
        ])
        self.assertEqual([c.args[2] for c in calls], ['Blue Day', 'Blue Day'])

    def test_invalid_explicit_line_uses_legacy_mapping(self):
        for value in [None, '', 42, {}, []]:
            with self.subTest(value=value):
                calls, _ = self.scan([self.event('candidate-transfer-screen', {}, line=value)], {'transfer1': 'Blue Day'})
                self.assertEqual(calls[0].args[2], 'Blue Day')

    def test_request_only_exclusion_is_neither_a_completed_pickup_nor_a_timeout_incident(self):
        calls, watcher = self.scan([
            self.event('journey-finished', 'on-demand-request-required-excluded', line='Purple'),
            self.event('journey-finished', 'waiting-timeout-needs-review', line='Purple', runId='real-timeout'),
        ])
        self.assertEqual(len(calls), 1)
        self.assertIn('waiting-timeout-needs-review', calls[0].args[4])
        self.assertNotIn('transfer1', watcher.get('pickupAuditPending', {}))


if __name__ == '__main__':
    unittest.main()
