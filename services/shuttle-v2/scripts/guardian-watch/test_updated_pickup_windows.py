import copy
import gzip
import hashlib
import json
from pathlib import Path
import re
import tempfile
import unittest
from unittest.mock import patch

import evidence
import pickup
import poll

ORIGINAL = json.loads((Path(__file__).parent/'__fixtures__/updated-pickup-windows-20261023.json').read_text())


class UpdatedWindowTests(unittest.TestCase):
    def setUp(self):
        self.case = copy.deepcopy(ORIGINAL)

    def first(self):
        c = self.case
        return pickup.analyze(c['journey'], c['samples'], c['coverage'], c['records'])

    def audit(self, first=None):
        c = self.case
        return pickup.updated_window_audit(c['journey'], c['samples'], self.first() if first is None else first, c['records'])

    def sample(self, at):
        return next(s for s in self.case['samples'] if s['at'] == at)

    def only_quotes(self, times):
        # Constructed wide windows leave only the chosen original quotes as
        # miss candidates. Original fixture and response bytes stay unchanged.
        first_at = self.case['samples'][0]['at']
        for s in self.case['samples']:
            if s['phase'] == 'waiting' and s['at'] != first_at and s['at'] not in times:
                s['text'] = re.sub(r'Likely (?:~1|<1|\d+)(?:[–-]\d+)? min', 'Likely <1–99 min', s['text'])

    def test_original_later_miss_is_separate_from_the_unchanged_first_window(self):
        first = self.first()
        self.assertEqual({k:first[k] for k in ORIGINAL['expectedFirst']}, ORIGINAL['expectedFirst'])
        result = self.audit(first)
        self.assertEqual(result['state'], 'late-window')
        self.assertEqual([q['at'] for q in result['confirmationQuotes']], ORIGINAL['expectedConfirmationAt'])
        self.assertEqual(result['sourceVerifiedConfirmationQuotes'], 2)
        self.assertTrue(result['sourceVerifiedPickupObservation'])
        self.assertEqual(len(result['contextReferences']), 3)
        self.assertEqual(result['candidateScanQuotes'], 101)  # First quote is the separate metric.
        self.assertAlmostEqual(result['confirmationQuotes'][0]['lateBeyondWindowSec'], 340.137, places=3)
        # The earlier300.144s miss cannot bridge the26:42feed race.
        self.assertNotEqual(result['confirmationQuotes'][0]['at'], '2026-10-24T00:26:31.999Z')
        self.assertEqual(self.case, ORIGINAL)

    def test_missing_confirmation_body_requests_capture_instead_of_confirming(self):
        identity = self.sample(ORIGINAL['expectedConfirmationAt'][0])['feedResponse']['id']
        self.case['records'] = [r for r in self.case['records'] if r['id'] != identity]
        result = self.audit()
        self.assertEqual(result['state'], 'needs-source-evidence')
        self.assertIn(identity, [ref['id'] for ref in result['contextReferences']])
        self.assertNotIn('sourceVerifiedConfirmationQuotes', result)

    def test_source_body_descriptor_fleet_model_and_pickup_mismatches_stay_unknown(self):
        for kind in ['body', 'descriptor', 'fleet', 'model', 'pickup']:
            with self.subTest(kind=kind):
                self.case = copy.deepcopy(ORIGINAL)
                sample = self.sample(ORIGINAL['expectedConfirmationAt'][0])
                record = next(r for r in self.case['records'] if r['id'] == sample['feedResponse']['id'])
                first = self.first()
                if kind == 'body': record['body'] = 'AA=='
                if kind == 'descriptor': sample['feedResponse']['status'] = 201
                if kind == 'fleet': next(b for b in sample['buses'] if b['bus_id'] == 68147)['lat'] += .01
                if kind == 'model':
                    sample['server_eta']['at'] += 1
                    sample['server_eta']['servedAt'] += 1
                if kind == 'pickup': first['pickupObservation']['bus']['lat'] += .00001
                result = self.audit(first)
                self.assertEqual(result['state'], 'unknown')
                self.assertEqual(result['reason'], 'original-updated-window-source-mismatch')

    def test_cache_race_or_recovery_between_two_candidates_cannot_confirm(self):
        times = ORIGINAL['expectedConfirmationAt']
        for kind in ['cache', 'race', 'recovery', 'vehicle']:
            with self.subTest(kind=kind):
                self.case = copy.deepcopy(ORIGINAL);self.only_quotes(times)
                first, second = map(self.sample, times)
                if kind == 'race': second['mapPauseAudit']['feedStableDuringRead'] = False
                if kind == 'vehicle': second['text'] = second['text'].replace('#307 · Recent speed', '#44 · Recent speed')
                if kind == 'recovery': second['text'] = re.sub(r'Likely <1–\d+ min', 'Likely <1–99 min', second['text'])
                if kind == 'cache':
                    for key in ['buses', 'server_eta', 'feedResponse']:
                        second[key] = copy.deepcopy(first[key])
                    second['feedAgeMs'] = round(pickup.timestamp(second['at'])*1000)-second['feedResponse']['receivedAt']
                self.assertEqual(self.audit()['state'], 'no-confirmed-miss')

    def test_a_gap_over_thirty_seconds_in_any_source_clock_cannot_confirm(self):
        times = ORIGINAL['expectedConfirmationAt']
        for clock in ['received', 'model', 'gps']:
            with self.subTest(clock=clock):
                self.case = copy.deepcopy(ORIGINAL);self.only_quotes(times)
                a, b = map(self.sample, times)
                if clock == 'received':
                    shift = 30001-(b['feedResponse']['receivedAt']-a['feedResponse']['receivedAt'])
                    a['feedResponse']['receivedAt'] -= shift;a['feedAgeMs'] += shift
                if clock == 'model':
                    shift = 30001-(b['server_eta']['at']-a['server_eta']['at'])
                    a['server_eta']['at'] -= shift;a['server_eta']['servedAt'] -= shift
                if clock == 'gps':
                    old = next(x for x in a['buses'] if x['bus_id'] == 68147)
                    new = next(x for x in b['buses'] if x['bus_id'] == 68147)
                    old['observed_at'] -= 30001-(new['observed_at']-old['observed_at'])
                self.assertEqual(self.audit()['state'], 'no-confirmed-miss')

    def test_an_intervening_phase_change_resets_an_unconfirmed_pair(self):
        times = ['2026-10-24T00:26:31.999Z', '2026-10-24T00:26:52.006Z']
        self.only_quotes(times)
        between = next(s for s in self.case['samples'] if times[0] < s['at'] < times[1])
        between['phase'] = 'riding'
        self.assertEqual(self.audit()['state'], 'no-confirmed-miss')

    def test_first_metric_exclusions_and_prior_unbound_opportunities_remain_unknown(self):
        for kind in ['excluded', 'handover', 'earlier']:
            with self.subTest(kind=kind):
                self.case = copy.deepcopy(ORIGINAL)
                if kind == 'excluded': self.case['journey']['excludeAccuracy'] = True
                if kind == 'handover': self.case['journey']['instrumentHandoverAt'] = 'x'
                if kind == 'earlier':
                    s = self.case['samples'][20]
                    bus = next(b for b in s['buses'] if b['bus_id'] == 68147)
                    bus.update({k:self.case['journey']['trip']['origin'][k] for k in ['lat', 'lon']})
                self.assertEqual(self.first()['state'], 'unknown')
                self.assertEqual(self.audit()['reason'], 'pickup-observation-unqualified')

    def test_constructed_early_updated_windows_keep_the_same_source_qualification(self):
        self.only_quotes(ORIGINAL['expectedConfirmationAt'])
        for at in ORIGINAL['expectedConfirmationAt']:
            s = self.sample(at)
            s['text'] = re.sub(r'Arrival: About 2 min · Likely <1–\d+ min', 'Arrival: About 30 min · Likely 25–35 min', s['text'])
        self.assertEqual(self.first()['state'], 'within-diagnostic-tolerance')
        result = self.audit()
        self.assertEqual(result['state'], 'early-window')
        self.assertTrue(all(q['earlyBeforeWindowSec'] > pickup.MISS_SECONDS for q in result['confirmationQuotes']))


class UpdatedWindowBridgeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name);self.watch = self.root/'watch';self.watch.mkdir()
        for name in ['pending', 'processed']: (self.root/name).mkdir()
        self.case = copy.deepcopy(ORIGINAL)
        self.event = next(e for e in self.case['events'] if e['kind'] == 'journey-finished')
        for name, value in [('WATCH', str(self.watch)), ('WATCH_RED', str(self.watch)+'-red'),
                            ('PENDING', str(self.root/'pending')), ('PROCESSED', str(self.root/'processed')),
                            ('EVIDENCE', str(self.root/'evidence'))]:
            p = patch.object(poll, name, value);p.start();self.addCleanup(p.stop)
        self.state = {'open': {}, 'pickupAuditPending': {self.case['journey']['id']:self.event}, 'pickupAudits': {}}
        poll.CAPTURE_ERRORS.clear()
        self.save_sources()

    def save_sources(self):
        c = self.case
        for name, rows in [('journeys', [c['journey']]), ('samples', c['samples']), ('events', c['events'])]:
            (self.watch/(name+'.jsonl')).write_text(''.join(json.dumps(row)+'\n' for row in rows))
        (self.watch/'feed-responses').mkdir(exist_ok=True)
        (self.watch/'feed-responses'/(c['journey']['id']+'.jsonl')).write_text(''.join(json.dumps(r)+'\n' for r in c['records']))

    def check(self):
        poll.check_completed_pickups(self.state, self.state, str(self.watch))
        self.assertEqual(poll.CAPTURE_ERRORS, [])
        return self.state['pickupAudits'][self.case['journey']['id']]

    def test_real_completed_ride_captures_originals_and_emits_one_later_window_incident(self):
        before = {str(p.relative_to(self.watch)):p.read_bytes() for p in self.watch.rglob('*') if p.is_file()}
        result = self.check()
        self.assertEqual(result['state'], 'within-diagnostic-tolerance')
        self.assertEqual(result['updatedWindowAudit']['state'], 'late-window')
        self.assertEqual(result['reportedMetric'], 'updated-windows-v1')
        files = list((self.root/'pending').glob('*.json'));self.assertEqual(len(files), 1)
        incident = json.loads(files[0].read_text())
        self.assertEqual(incident['detail']['pickupWindowMetric'], 'updated-windows-v1')
        self.assertIn('two later displayed windows', incident['summary'])
        initial = result['initialBundle'];enriched = result['bundle']
        self.assertNotEqual(initial['directory'], enriched['directory'])
        self.assertEqual(evidence.verify_bundle(initial['directory'])['manifestSha256'], initial['manifestSha256'])
        for receipt in [enriched, incident['evidenceBundles'][0]]:
            verified = evidence.verify_bundle(receipt['directory']);self.assertTrue(verified['sampleCoverage']['complete'])
            manifest = json.loads((Path(receipt['directory'])/'manifest.json').read_text())
            self.assertEqual(manifest['feedResponseCoverage']['pickupWindowContextReferences'], 3)
            self.assertEqual(manifest['feedResponseCoverage']['retainedBodies'], 7)
            self.assertTrue(manifest['feedResponseCoverage']['contextComplete'])
            with gzip.open(Path(receipt['directory'])/'feed-responses.jsonl.gz', 'rt') as f:
                ids = {json.loads(line)['id'] for line in f}
            self.assertTrue({r['id'] for r in result['updatedWindowAudit']['contextReferences']} <= ids)
        self.assertEqual({str(p.relative_to(self.watch)):p.read_bytes() for p in self.watch.rglob('*') if p.is_file()}, before)
        self.assertEqual(poll.pickup_audit_status(self.state)['updatedStates']['late-window'], 1)
        # Plain capture still reads the original immutable base bundle.
        plain = evidence.capture_bundle(poll.EVIDENCE, 'pickup-audit-'+hashlib.sha256(self.case['journey']['id'].encode()).hexdigest()[:24], self.event,
                                        {'watcherDir':str(self.watch), 'runId':self.case['journey']['id'], 'screenshots':[]}, [str(self.watch)])
        self.assertEqual(plain['manifestSha256'], initial['manifestSha256'])

    def test_selected_context_is_bounded_and_order_does_not_rewrite_a_bundle(self):
        result = self.check()
        refs = result['updatedWindowAudit']['contextReferences']
        parent = Path(result['bundle']['directory']).parent.name
        def capture(selected):
            return evidence.capture_bundle(poll.EVIDENCE, parent, self.event,
                {'watcherDir':str(self.watch), 'runId':self.case['journey']['id'], 'screenshots':[],
                 'pickupWindowReferences':selected}, [str(self.watch)])
        self.assertEqual(capture(list(reversed(refs)))['manifestSha256'], result['bundle']['manifestSha256'])
        for kind in ['too-many', 'wrong-run', 'wrong-file', 'unavailable']:
            with self.subTest(kind=kind):
                changed = copy.deepcopy(refs)
                if kind == 'too-many': changed.append(changed[0])
                if kind == 'wrong-run': changed[0]['runId'] = 'different'
                if kind == 'wrong-file': changed[0]['file'] = '../outside'
                if kind == 'unavailable': changed[0]['state'] = 'unavailable'
                with self.assertRaisesRegex(ValueError, 'Invalid pickup window source selection'):
                    capture(changed)
        self.assertEqual(evidence.verify_bundle(result['bundle']['directory'])['manifestSha256'], result['bundle']['manifestSha256'])

    def test_lost_ack_and_processed_incident_cannot_repeat_or_append_a_completed_run(self):
        self.check();file = next((self.root/'pending').glob('*.json'));original = file.read_bytes()
        for processed in [False, True]:
            if processed: file.rename(self.root/'processed'/file.name);file = self.root/'processed'/file.name
            self.state['pickupAudits'] = {};self.state['pickupAuditPending'] = {self.case['journey']['id']:self.event}
            self.check();self.assertEqual(file.read_bytes(), original)
            self.assertEqual(len(list(self.root.glob('*/'+'*-rider-pickup-window-miss-*.json'))), 1)

    def test_missing_quote_body_is_explicit_unknown_and_does_not_alert(self):
        identity = next(s for s in self.case['samples'] if s['at'] == ORIGINAL['expectedConfirmationAt'][0])['feedResponse']['id']
        self.case['records'] = [r for r in self.case['records'] if r['id'] != identity];self.save_sources()
        result = self.check();self.assertEqual(result['updatedWindowAudit']['state'], 'unknown')
        self.assertEqual(result['updatedWindowAudit']['reason'], 'original-updated-window-context-unavailable')
        self.assertEqual(list((self.root/'pending').glob('*.json')), [])
        self.assertEqual(poll.pickup_audit_status(self.state)['updatedStates']['unknown'], 1)

    def test_first_window_miss_has_priority_and_still_creates_only_one_incident(self):
        s = self.case['samples'][0]
        s['text'] = s['text'].replace('Likely <1–29 min', 'Likely <1–1 min');self.save_sources()
        result = self.check()
        self.assertEqual(result['state'], 'late-window')
        self.assertEqual(result['updatedWindowAudit']['state'], 'late-window')
        self.assertEqual(result['reportedMetric'], 'first-window')
        files = list((self.root/'pending').glob('*.json'));self.assertEqual(len(files), 1)
        self.assertEqual(json.loads(files[0].read_text())['detail']['pickupWindowMetric'], 'first-window')

    def test_context_budget_omission_never_claims_source_confirmation(self):
        with patch.object(evidence, 'MAX_FEED_CONTEXT_BYTES', 1):
            result = self.check()
        self.assertEqual(result['updatedWindowAudit']['state'], 'unknown')
        self.assertNotIn('sourceVerifiedConfirmationQuotes', result['updatedWindowAudit'])
        self.assertEqual(list((self.root/'pending').glob('*.json')), [])
