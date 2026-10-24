import base64
import copy
import gzip
import hashlib
import json
from pathlib import Path
import tempfile
import unittest

import pickup

FIXTURES = Path(__file__).parent/'__fixtures__'
ORIGINAL = json.loads((FIXTURES/'at-stop-feed-transition-20261023.json').read_text())
NON_AT_STOP = json.loads((FIXTURES/'non-at-stop-feed-transition-20261023.json').read_text())


class AtStopTransitionTests(unittest.TestCase):
    def setUp(self):
        self.case = copy.deepcopy(ORIGINAL)

    def audit(self):
        c = self.case
        return pickup.analyze(c['journey'], c['samples'], c['coverage'], c['records'])

    def selected(self):
        at = self.case['journey']['boardingObservation']['sample']['sampledAt']
        return next(s for s in self.case['samples'] if s['at'] == at)

    def assert_unknown(self):
        self.assertEqual(self.audit()['state'], 'unknown')

    def use_selected_source(self, check):
        selected = self.selected()
        ref = copy.deepcopy(selected['feedResponse'])
        record = next(r for r in self.case['records'] if r['id'] == ref['id'])
        feed = json.loads(pickup.verify_feed_response(record))
        bus = next(b for b in feed['buses'] if b['bus_name'] == self.case['journey']['busName'])
        check.update(feedResponse=ref, feedReceivedAt=self.case['journey']['boardingObservation']['sample']['feedReceivedAt'],
                     bus=bus, distanceM=pickup.distance(bus, self.case['journey']['trip']['origin']))

    def test_original_at_stop_transition_uses_earliest_verified_check(self):
        c = self.case
        self.assertEqual(len(c['samples']), 167)
        self.assertEqual(pickup.analyze(c['journey'], c['samples'], c['coverage'])['reason'], 'no-qualifying-pickup-observation')
        result = self.audit()
        self.assertEqual(result['state'], 'within-diagnostic-tolerance')
        observation = result['pickupObservation']
        self.assertEqual(observation['source'], 'verified-at-stop-transition')
        self.assertEqual(observation['at'], '2026-10-24T03:02:03.472Z')
        self.assertEqual(observation['feedResponse']['id'], c['journey']['boardingObservation']['checks'][0]['feedResponse']['id'])
        self.assertAlmostEqual(observation['distanceM'], 39.1285448655)
        self.assertEqual(observation['bus']['bus_id'], 68149)
        self.assertAlmostEqual(result['observedWaitSec'], 1150.2, places=3)
        self.assertNotEqual(observation['at'], observation['bus']['at_stop_since'])
        self.assertEqual(c, ORIGINAL)

    def test_original_non_at_stop_transition_stays_unknown(self):
        self.case = copy.deepcopy(NON_AT_STOP)
        self.assertEqual(len(self.case['samples']), 165)
        self.assert_unknown()

    def test_forged_at_stop_flags_do_not_override_original_moving_bus(self):
        self.case = copy.deepcopy(NON_AT_STOP)
        selected = self.selected()
        selected['text'] = selected['text'].replace('BOARD333 Cedar', 'BOARD🚌333 Cedar')
        first = self.case['journey']['boardingObservation']['checks'][0]
        first.update(atStop=True, text=selected['text'])
        self.assert_unknown()

    def test_missing_corrupt_duplicate_and_changed_source_records_stay_unknown(self):
        for kind in ['selected-missing', 'new-missing', 'corrupt', 'duplicate', 'metadata', 'crc']:
            with self.subTest(kind=kind):
                self.case = copy.deepcopy(ORIGINAL)
                if kind == 'selected-missing': self.case['records'] = [r for r in self.case['records'] if r['id'] != self.selected()['feedResponse']['id']]
                if kind == 'new-missing': self.case['records'] = [r for r in self.case['records'] if r['id'] == self.selected()['feedResponse']['id']]
                if kind == 'corrupt': self.case['records'][0]['body'] = 'AA=='
                if kind == 'duplicate': self.case['records'].append(copy.deepcopy(self.case['records'][0]))
                if kind == 'metadata': self.case['records'][0]['receivedAt'] += 1
                if kind == 'crc':
                    r = self.case['records'][0];raw = bytearray(base64.b64decode(r['body']));raw[-8] ^= 1
                    r['body'] = base64.b64encode(raw).decode();r['gzipSHA256'] = hashlib.sha256(raw).hexdigest()
                self.assert_unknown()

    def test_unstable_changed_or_partial_selected_context_stays_unknown(self):
        for kind in ['screen', 'fleet', 'wire', 'missing-wire', 'receipt', 'version', 'point', 'coverage', 'sample']:
            with self.subTest(kind=kind):
                self.case = copy.deepcopy(ORIGINAL);s = self.selected();o = self.case['journey']['boardingObservation']
                if kind == 'screen': o['sample']['feedStableDuringTextRead'] = False
                if kind == 'fleet': next(b for b in s['buses'] if b['bus_name'] == '#44')['heading'] += 1
                if kind == 'wire': s['server_eta']['at'] -= 1
                if kind == 'missing-wire': s.pop('server_eta')
                if kind == 'receipt': o['sample']['feedReceivedAt'] = '2026-10-24T03:00:00Z'
                if kind == 'version': o['v'] = True
                if kind == 'point': o['stopCoords']['lat'] += .001
                if kind == 'coverage': self.case['coverage']['complete'] = False
                if kind == 'sample': self.case['samples'].pop()
                self.assert_unknown()

    def test_conflicts_missing_guard_and_stale_stored_ride_stay_unknown(self):
        for kind in ['at-stop', 'past', 'opposite', 'other', 'missing-other', 'stale-stored', 'wrong-stored', 'walk']:
            with self.subTest(kind=kind):
                self.case = copy.deepcopy(ORIGINAL);j = self.case['journey'];first = j['boardingObservation']['checks'][0]
                if kind == 'at-stop': first['atStop'] = False
                if kind == 'past': first['past'] = True
                if kind == 'opposite': first['opposite'] = True
                if kind == 'other': first['otherOccurrence'] = {'reason': 'another-pass'}
                if kind == 'missing-other': first.pop('otherOccurrence')
                if kind in ['stale-stored', 'wrong-stored']:
                    key = 'shuttle-boarded-ride';stored = json.loads(j['boardedStorage'][key])
                    if kind == 'stale-stored': stored['startedAt'] -= 120000
                    else: stored['busName'] = '#other'
                    j['boardedStorage'][key] = json.dumps(stored)
                if kind == 'walk': first['walkUntil'] = '2026-10-24T03:03:00Z'
                self.assert_unknown()

    def test_check_bus_identity_distance_failure_and_future_clocks_stay_unknown(self):
        for kind in ['bus', 'route', 'name', 'distance', 'allowed', 'future', 'outcome']:
            with self.subTest(kind=kind):
                self.case = copy.deepcopy(ORIGINAL);o = self.case['journey']['boardingObservation'];check = o['checks'][1]
                if kind == 'bus': check['bus']['bus_id'] += 1
                if kind == 'route': check['bus']['route_id'] += 1
                if kind == 'name': check['bus']['bus_name'] = '#other'
                if kind == 'distance': check['distanceM'] = 1
                if kind == 'allowed': check['allowed'] = False
                if kind == 'future': check['checkedAt'] = '2026-10-24T03:03:00Z'
                if kind == 'outcome': o['outcomeAt'] = '2026-10-24T03:03:00Z'
                self.assert_unknown()

    def test_eligibility_cannot_borrow_a_body_before_its_receipt(self):
        self.case['journey']['boardingObservation']['checks'][0]['checkedAt'] = '2026-10-24T03:02:03.450Z'
        self.assert_unknown()

    def test_null_finding_outside_its_within45m_runtime_branch_stays_unknown(self):
        first = self.case['journey']['boardingObservation']['checks'][0]
        self.use_selected_source(first)
        self.assertIsNone(first['otherOccurrence'])
        self.assertGreater(first['distanceM'], 45)
        self.assert_unknown()

    def test_actual_older_source_cannot_regress_after_newer_eligibility(self):
        check = self.case['journey']['boardingObservation']['checks'][1]
        self.use_selected_source(check)
        self.assert_unknown()

    def test_only_post_boarding_qualifying_checks_cannot_supply_arrival(self):
        o = self.case['journey']['boardingObservation'];self.use_selected_source(o['checks'][0]);o['checks'][0]['otherOccurrence'] = False
        for check in o['checks'][1:]: check['checkedAt'] = o['outcomeAt']
        self.assert_unknown()

    def test_earlier_unbound_periodic_opportunity_keeps_precedence(self):
        s = self.case['samples'][20];point = self.case['journey']['trip']['origin'];bus = next(b for b in s['buses'] if b['bus_name'] == '#44')
        bus.update(lat=point['lat'], lon=point['lon'])
        self.assertEqual(self.audit(), {'state': 'unknown', 'reason': 'earlier-or-unbound-pickup-opportunity'})

    def test_constructed_manual_card_check_needs_visible_same_curbed_card(self):
        o = self.case['journey']['boardingObservation'];card = copy.deepcopy(o['checks'][1]);card.update(kind='card-boards', feedStableDuringTextRead=True, text=self.selected()['text']);o['checks'].insert(2, card)
        self.assertEqual(self.audit()['pickupObservation']['source'], 'verified-at-stop-transition')
        card['feedStableDuringTextRead'] = False
        self.assert_unknown()

    def test_bundle_checksum_and_both_original_contexts_are_required(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp);files = []
            for name, rows in [('journeys', [self.case['journey']]), ('samples', self.case['samples']), ('feed-responses', self.case['records'])]:
                data = gzip.compress(''.join(json.dumps(r)+'\n' for r in rows).encode(), mtime=0);p = root/(name+'.jsonl.gz');p.write_bytes(data)
                files.append({'file': p.name, 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()})
            raw = json.dumps({'capturedAt': 1, 'files': files, 'sampleCoverage': self.case['coverage']}).encode();(root/'manifest.json').write_bytes(raw);receipt = {'directory': str(root), 'manifestSha256': hashlib.sha256(raw).hexdigest()}
            self.assertEqual(pickup.audit_bundle(receipt)['pickupObservation']['source'], 'verified-at-stop-transition')
            p = root/'feed-responses.jsonl.gz';p.write_bytes(p.read_bytes()+b'changed')
            with self.assertRaisesRegex(ValueError, 'checksum'): pickup.audit_bundle(receipt)


if __name__ == '__main__':
    unittest.main()
