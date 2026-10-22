import copy
from datetime import datetime, timezone
import json
from pathlib import Path
import re
import tempfile
import unittest
from unittest.mock import patch

import pickup
import poll

FIXTURE = json.loads((Path(__file__).parent/'__fixtures__/pickup-windows-20261020.json').read_text())['cases']
PURPLE = next(c for c in FIXTURE if c['runId'] == '1792538515678')


class PickupWindowTests(unittest.TestCase):
    def setUp(self):
        self.c = copy.deepcopy(PURPLE)

    def audit(self):
        return pickup.analyze(self.c['journey'], self.c['samples'], self.c['coverage'])

    def test_original_recorded_late_pickup_and_three_distinct_controls(self):
        actual = [pickup.analyze(c['journey'], c['samples'], c['coverage']) for c in FIXTURE]
        self.assertEqual([r['state'] for r in actual], ['unknown', 'late-window', 'within-diagnostic-tolerance', 'unknown'])
        self.assertEqual(actual[0]['reason'], 'initial-vehicle-differs-or-unbound')
        self.assertEqual(actual[3]['reason'], 'initial-window-unavailable')
        self.assertAlmostEqual(actual[1]['lateBeyondWindowSec'], 900.265, places=3)
        self.assertEqual(actual[1]['firstQuote']['hiSec'], 720)
        self.assertAlmostEqual(actual[1]['pickupObservation']['distanceM'], 59.3801385857)
        self.assertEqual(actual[1]['pickupObservation']['bus']['bus_id'], 67959)
        self.assertEqual(self.c, PURPLE)

    def test_two_original_single_value_window_runs_from_the_broader_population(self):
        cases = json.loads((Path(__file__).parent/'__fixtures__/single-value-pickups-20261020.json').read_text())['cases']
        self.assertEqual(len(cases), 2)
        for case in cases:
            result = pickup.analyze(case['journey'], case['samples'], case['coverage'])
            self.assertEqual(result['state'], 'within-diagnostic-tolerance')
            self.assertEqual(result['firstQuote']['hiSec'], 60)

    def test_single_value_windows_preserve_their_upper_endpoint_without_raising(self):
        for text, lo, hi in [('Arrival: About <1 min · Likely ~1 min', 0, 60), ('Arrival: About <1 min · Likely <1 min', 0, 60), ('Arrival: About 5 min · Likely 5 min', 300, 300)]:
            with self.subTest(text=text):
                self.c = copy.deepcopy(PURPLE)
                self.c['samples'][0]['text'] = self.c['samples'][0]['text'].replace('Arrival: About 7 min · Likely 4–12 min', text)
                result = self.audit()
                self.assertEqual(result['state'], 'late-window')
                self.assertEqual((result['firstQuote']['loSec'], result['firstQuote']['hiSec']), (lo, hi))

    def test_tolerance_matches_the_existing_canary_and_boundary_is_strict(self):
        code = (Path(__file__).parent.parent/'canary-metrics.mjs').read_text()
        self.assertEqual(pickup.MISS_SECONDS, int(re.search(r'firstSightMissSec:\s*(\d+)', code)[1]))
        first = self.c['samples'][0]
        first['text'] = first['text'].replace('4–12 min', '4–22 min')
        final = [s for s in self.c['samples'] if s['phase'] == 'waiting'][-1]
        at = pickup.timestamp(first['at'])+1320+300
        final['at'] = datetime.fromtimestamp(at, timezone.utc).isoformat()
        self.assertEqual(self.audit()['state'], 'within-diagnostic-tolerance')
        final['at'] = datetime.fromtimestamp(at+.001, timezone.utc).isoformat()
        self.assertEqual(self.audit()['state'], 'late-window')

    def test_resumed_excluded_transfer_and_harness_error_are_unknown(self):
        for key, value in [('excludeAccuracy', True), ('instrumentHandoverAt', 'x'), ('harnessErrors', 1), ('transfer', {'stage': 1})]:
            with self.subTest(key=key):
                self.c = copy.deepcopy(PURPLE)
                self.c['journey'][key] = value
                self.assertEqual(self.audit()['state'], 'unknown')

    def test_constructed_early_window_keeps_the_original_pickup_qualification(self):
        # Constructed interval on the recorded qualification fixture; this is
        # not the interval that its rider originally saw.
        first = self.c['samples'][0]
        first['text'] = first['text'].replace('Arrival: About 7 min · Likely 4–12 min', 'Arrival: About 45 min · Likely 40–50 min')
        result = self.audit()
        self.assertEqual(result['state'], 'early-window')
        self.assertEqual(result['firstQuote']['loSec'], 2400)
        self.assertAlmostEqual(result['earlyBeforeWindowSec'], 779.735, places=3)
        self.assertLess(result['lateBeyondWindowSec'], 0)
        self.assertEqual(result['pickupObservation']['bus']['bus_id'], 67959)
        self.assertEqual(PURPLE['samples'][0]['text'].count('4–12 min'), 1)

    def test_early_tolerance_has_the_same_strict_boundary_and_preserves_old_fields(self):
        first = self.c['samples'][0]
        first['text'] = first['text'].replace('Arrival: About 7 min · Likely 4–12 min', 'Arrival: About 35 min · Likely 32–38 min')
        final = [s for s in self.c['samples'] if s['phase'] == 'waiting'][-1]
        at = pickup.timestamp(first['at'])+1920-300
        final['at'] = datetime.fromtimestamp(at, timezone.utc).isoformat()
        result = self.audit()
        self.assertEqual(result['state'], 'within-diagnostic-tolerance')
        self.assertNotIn('earlyBeforeWindowSec', result)
        final['at'] = datetime.fromtimestamp(at-.001, timezone.utc).isoformat()
        result = self.audit()
        self.assertEqual(result['state'], 'early-window')
        self.assertAlmostEqual(result['earlyBeforeWindowSec'], 300.001, places=3)

    def test_an_early_quote_cannot_override_unknown_gps_evidence(self):
        self.c['samples'][0]['text'] = self.c['samples'][0]['text'].replace('Arrival: About 7 min · Likely 4–12 min', 'Arrival: About 45 min · Likely 40–50 min')
        self.c['samples'][20]['buses'][0]['observed_at'] -= 60000
        result = self.audit()
        self.assertEqual(result, {'state': 'unknown', 'reason': 'stale-or-invalid-gps-clock'})

    def test_missing_duplicate_or_partial_samples_never_pass(self):
        for change in ['missing', 'duplicate', 'partial']:
            self.c = copy.deepcopy(PURPLE)
            if change == 'missing': self.c['samples'].pop()
            if change == 'duplicate': self.c['samples'][1] = copy.deepcopy(self.c['samples'][0])
            if change == 'partial': self.c['coverage']['complete'] = False
            self.assertEqual(self.audit()['state'], 'unknown')

    def test_initial_screen_and_fleet_races_remain_unknown(self):
        self.c['samples'][0]['mapPauseAudit']['feedStableDuringRead'] = False
        self.assertEqual(self.audit()['reason'], 'initial-screen-feed-race')

    def test_changed_bus_name_or_provider_identity_is_not_one_late_vehicle(self):
        self.c['samples'][20]['text'] = self.c['samples'][20]['text'].replace('#124', '#330')
        self.assertEqual(self.audit()['reason'], 'watched-vehicle-changed')
        self.c = copy.deepcopy(PURPLE)
        self.c['samples'][20]['buses'][0]['bus_id'] += 1
        self.assertEqual(self.audit()['reason'], 'provider-identity-changed')

    def test_stale_receipts_gps_clocks_and_observation_gaps_remain_unknown(self):
        for kind in ['receipt', 'gps', 'gap']:
            self.c = copy.deepcopy(PURPLE)
            s = self.c['samples'][20]
            if kind == 'receipt': s['feedAgeMs'] = 30001
            if kind == 'gps': s['buses'][0]['observed_at'] -= 60000
            if kind == 'gap':
                self.c['samples'] = self.c['samples'][:20]+self.c['samples'][24:]
                self.c['journey']['samples'] = len(self.c['samples'])
            self.assertEqual(self.audit()['state'], 'unknown')

    def test_initial_or_later_pickup_changes_cannot_borrow_another_stops_quote(self):
        for index in [0, 20]:
            self.c = copy.deepcopy(PURPLE)
            self.c['samples'][index]['text'] = self.c['samples'][index]['text'].replace('BOARDWest Haven Train Station', 'BOARDBuilding 400')
            self.assertEqual(self.audit()['reason'], 'pickup-label-changed-or-unbound')

    def test_a_prior_close_pass_cannot_be_claimed_as_a_missed_later_pickup(self):
        point = self.c['journey']['trip']['origin']
        self.c['samples'][20]['buses'][0].update({'lat': point['lat'], 'lon': point['lon']})
        self.assertEqual(self.audit()['reason'], 'earlier-or-unbound-pickup-opportunity')

    def test_ambiguous_and_invalid_identity_coordinates_and_quote_are_unknown(self):
        for kind in ['duplicate-bus', 'coords', 'route', 'origin', 'text', 'coverage']:
            self.c = copy.deepcopy(PURPLE)
            if kind == 'duplicate-bus': self.c['samples'][0]['buses'] *= 2
            if kind == 'coords': self.c['samples'][0]['buses'][0]['lat'] = float('nan')
            if kind == 'route': self.c['journey']['line'] = []
            if kind == 'origin': self.c['journey']['trip'] = []
            if kind == 'text': self.c['samples'][0]['text'] *= 10000
            if kind == 'coverage': self.c['coverage'] = None
            self.assertEqual(self.audit()['state'], 'unknown')


class PickupBridgeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.watch = self.root/'rider'
        self.watch.mkdir()
        for n in ['pending', 'processed']: (self.root/n).mkdir()
        for name, value in [('WATCH', str(self.watch)), ('WATCH_RED', str(self.watch)+'-red'),
                            ('PENDING', str(self.root/'pending')), ('PROCESSED', str(self.root/'processed')),
                            ('EVIDENCE', str(self.root/'evidence'))]:
            p = patch.object(poll, name, value);p.start();self.addCleanup(p.stop)
        self.event = {'at': PURPLE['journey']['finishedAt'], 'runId': PURPLE['runId'],
                      'kind': 'journey-finished', 'line': 'Purple', 'detail': 'completed'}
        for name, rows in [('samples', PURPLE['samples']), ('journeys', [PURPLE['journey']]), ('events', [self.event])]:
            (self.watch/(name+'.jsonl')).write_text(''.join(json.dumps(r)+'\n' for r in rows))
        self.state = {'open': {}, 'offset': 0, 'runs': {}, 'since': 0, 'journeyAlertsSince': 0, 'pickupAuditsSince': 0}
        poll.CAPTURE_ERRORS.clear()

    def run_check(self):
        poll.scan_events(self.state, self.state, str(self.watch))
        poll.check_completed_pickups(self.state, self.state, str(self.watch))

    def test_real_recorded_completed_journey_raises_one_sealed_review_candidate(self):
        before = {p.name: p.read_bytes() for p in self.watch.iterdir()}
        self.run_check()
        files = list((self.root/'pending').glob('*.json'))
        self.assertEqual(len(files), 1)
        inc = json.loads(files[0].read_text())
        self.assertEqual(inc['kind'], 'rider-pickup-window-miss')
        self.assertEqual(inc['detail']['pickupAudit']['state'], 'late-window')
        self.assertTrue(poll.verify_bundle(inc['evidenceBundles'][0]['directory'])['sampleCoverage']['complete'])
        self.assertEqual({p.name: p.read_bytes() for p in self.watch.iterdir()}, before)
        self.state = json.loads(json.dumps(self.state))
        self.run_check()
        self.assertEqual(len(list((self.root/'pending').glob('*.json'))), 1)
        self.assertEqual(len(json.loads(files[0].read_text())['occurrences']), 1)
        self.assertEqual(poll.CAPTURE_ERRORS, [])

    def test_lost_acknowledgement_and_processed_incident_do_not_repeat_a_run(self):
        self.run_check()
        original = next((self.root/'pending').glob('*.json'))
        before = original.read_bytes()
        self.state['pickupAudits'] = {}
        self.state['pickupAuditPending'] = {PURPLE['runId']: self.event}
        self.run_check()
        self.assertEqual(original.read_bytes(), before)
        target = self.root/'processed'/original.name
        original.rename(target)
        self.state['pickupAudits'] = {}
        self.state['pickupAuditPending'] = {PURPLE['runId']: self.event}
        self.run_check()
        self.assertEqual(target.read_bytes(), before)
        self.assertEqual(list((self.root/'pending').glob('*.json')), [])

    def test_constructed_early_pickup_is_sealed_and_deduplicated_after_lost_ack(self):
        samples = copy.deepcopy(PURPLE['samples'])
        samples[0]['text'] = samples[0]['text'].replace('Arrival: About 7 min · Likely 4–12 min', 'Arrival: About 45 min · Likely 40–50 min')
        (self.watch/'samples.jsonl').write_text(''.join(json.dumps(r)+'\n' for r in samples))
        self.run_check()
        file = next((self.root/'pending').glob('*.json'))
        original = file.read_bytes()
        incident = json.loads(original)
        self.assertEqual(incident['kind'], 'rider-pickup-window-miss')
        self.assertEqual(incident['detail']['pickupAudit']['state'], 'early-window')
        self.assertGreater(incident['detail']['pickupAudit']['earlyBeforeWindowSec'], 300)
        self.assertIn('before the first displayed window', incident['summary'])
        self.assertTrue(poll.verify_bundle(incident['evidenceBundles'][0]['directory'])['sampleCoverage']['complete'])
        self.state['pickupAudits'] = {}
        self.state['pickupAuditPending'] = {PURPLE['runId']: self.event}
        self.run_check()
        self.assertEqual(file.read_bytes(), original)
        self.assertEqual(len(list((self.root/'pending').glob('*.json'))), 1)
        self.assertEqual(poll.CAPTURE_ERRORS, [])

    def test_capture_failure_keeps_pending_work_and_retry_recovers(self):
        poll.scan_events(self.state, self.state, str(self.watch))
        with patch.object(poll, 'capture_bundle', side_effect=OSError('busy')):
            poll.check_completed_pickups(self.state, self.state, str(self.watch))
        self.assertIn(PURPLE['runId'], self.state['pickupAuditPending'])
        self.assertEqual(poll.CAPTURE_ERRORS[0]['stage'], 'pickup-window-audit')
        poll.CAPTURE_ERRORS.clear()
        self.run_check()
        self.assertEqual(self.state['pickupAuditPending'], {})
        self.assertEqual(len(list((self.root/'pending').glob('*.json'))), 1)

    def test_enable_time_does_not_turn_old_completed_events_into_new_alerts(self):
        self.state['pickupAuditsSince'] = poll.parse(self.event['at'])+1
        self.run_check()
        self.assertEqual(self.state['pickupAuditPending'], {})
        self.assertEqual(list((self.root/'pending').glob('*.json')), [])

    def test_unknown_identity_does_not_create_an_accuracy_or_health_incident(self):
        with patch.object(poll, 'audit_bundle', return_value={'state': 'unknown', 'reason': 'identity'}):
            self.run_check()
        self.assertEqual(list((self.root/'pending').glob('*.json')), [])
        self.assertEqual(self.state['pickupAudits'][PURPLE['runId']]['state'], 'unknown')
        self.assertEqual(poll.CAPTURE_ERRORS, [])


if __name__ == '__main__':
    unittest.main()
