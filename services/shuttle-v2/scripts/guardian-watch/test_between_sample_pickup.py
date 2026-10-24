import copy
import gzip
import hashlib
import json
from pathlib import Path
import tempfile
import unittest

import pickup

ORIGINAL = json.loads((Path(__file__).parent/'__fixtures__/between-samples-pickup-20261023.json').read_text())


class BetweenSamplePickupTests(unittest.TestCase):
    def setUp(self):
        self.case = copy.deepcopy(ORIGINAL)

    def audit(self):
        c = self.case
        return pickup.analyze(c['journey'], c['samples'], c['coverage'], c['boardingRecords'])

    def assert_unknown(self):
        self.assertEqual(self.audit()['state'], 'unknown')

    def test_original_between_sample_observation_is_not_fabricated_from_the_samples(self):
        c = self.case
        self.assertEqual(pickup.analyze(c['journey'], c['samples'], c['coverage'])['reason'], 'no-qualifying-pickup-observation')
        result = self.audit()
        self.assertEqual(result['state'], 'within-diagnostic-tolerance')
        observation = result['pickupObservation']
        self.assertEqual(observation['source'], 'verified-boarding-check')
        self.assertEqual(observation['at'], '2026-10-24T00:03:41.885Z')
        self.assertEqual(observation['feedResponse']['id'], '6aab0ac36a9b6ef5ec2c027577a6bc88c22bd5dea16b2396da577c867f0885a1')
        self.assertAlmostEqual(observation['distanceM'], 33.7898888355)
        self.assertEqual(observation['bus']['bus_id'], 68147)
        self.assertAlmostEqual(result['observedWaitSec'], 1410.38, places=3)
        self.assertEqual(c, ORIGINAL)

    def test_constructed_missed_windows_in_both_directions_still_raise_candidates(self):
        first = self.case['samples'][0]
        for interval, expected in [('1–2', 'late-window'), ('35–45', 'early-window')]:
            first['text'] = ORIGINAL['samples'][0]['text'].replace('Likely 4–44 min', 'Likely '+interval+' min')
            self.assertEqual(self.audit()['state'], expected)

    def test_missing_corrupt_or_duplicate_original_bodies_cannot_qualify(self):
        for kind in ['missing', 'corrupt', 'duplicate', 'metadata']:
            with self.subTest(kind=kind):
                self.case = copy.deepcopy(ORIGINAL)
                if kind == 'missing': self.case['boardingRecords'].pop()
                if kind == 'corrupt': self.case['boardingRecords'][0]['body'] = 'AA=='
                if kind == 'duplicate': self.case['boardingRecords'].append(self.case['boardingRecords'][0])
                if kind == 'metadata': self.case['boardingRecords'][0]['receivedAt'] += 1
                self.assert_unknown()

    def test_unverified_or_changed_selection_does_not_borrow_a_later_position(self):
        for kind in ['unstable', 'screen', 'stop', 'route', 'rider', 'stored', 'failed', 'past', 'version']:
            with self.subTest(kind=kind):
                self.case = copy.deepcopy(ORIGINAL)
                j = self.case['journey'];o = j['boardingObservation']
                if kind == 'version': o['v'] = True
                if kind == 'unstable': o['sample']['feedStableDuringTextRead'] = False
                if kind == 'screen': o['checks'][0]['text'] += '\nchanged'
                if kind == 'stop': o['stopId'] += 1
                if kind == 'route': o['routeIds'] = [13]
                if kind == 'rider': o['riderCoords']['lat'] += .01
                if kind == 'stored': j['boardedStorage']['shuttle-boarded-ride'] = '{}'
                if kind == 'failed': o['checks'][1]['allowed'] = False
                if kind == 'past': o['checks'][0]['past'] = True
                self.assert_unknown()

    def test_changed_bus_gps_or_receipt_never_becomes_an_observation(self):
        for kind in ['provider', 'position', 'distance', 'receipt', 'route', 'name']:
            with self.subTest(kind=kind):
                self.case = copy.deepcopy(ORIGINAL);c = self.case['journey']['boardingObservation']['checks'][1]
                if kind == 'provider': c['bus']['bus_id'] += 1
                if kind == 'position': c['bus']['lat'] += .01
                if kind == 'distance': c['distanceM'] = 1
                if kind == 'receipt': c['feedResponse']['receivedAt'] -= 60000
                if kind == 'route': c['bus']['route_id'] = 13
                if kind == 'name': c['bus']['bus_name'] = '#44'
                self.assert_unknown()

    def test_bad_check_clocks_outcome_and_partial_samples_stay_unknown(self):
        for kind in ['old', 'future', 'outcome', 'order', 'coverage', 'missing-sample', 'excluded', 'handover']:
            with self.subTest(kind=kind):
                self.case = copy.deepcopy(ORIGINAL);j = self.case['journey'];o = j['boardingObservation']
                if kind == 'old': o['attemptedAt'] = '2026-10-24T00:00:00Z'
                if kind == 'future': o['checks'][1]['checkedAt'] = '2026-10-24T00:04:00Z'
                if kind == 'outcome': o['outcomeAt'] = '2026-10-24T00:04:00Z'
                if kind == 'order': o['checks'][2]['checkedAt'] = o['checks'][0]['checkedAt']
                if kind == 'coverage': self.case['coverage']['complete'] = False
                if kind == 'missing-sample': self.case['samples'].pop()
                if kind == 'excluded': j['excludeAccuracy'] = True
                if kind == 'handover': j['instrumentHandoverAt'] = '2026-10-24T00:00:00Z'
                self.assert_unknown()

    def test_earlier_unbound_sample_keeps_precedence_over_verified_boarding(self):
        s = self.case['samples'][20]
        bus = next(b for b in s['buses'] if b['bus_id'] == 68147)
        point = self.case['journey']['trip']['origin'];bus.update({k: point[k] for k in ['lat', 'lon']})
        self.assertEqual(self.audit(), {'state': 'unknown', 'reason': 'earlier-or-unbound-pickup-opportunity'})

    def test_bundle_path_verifies_original_response_rows_before_qualifying(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            content = {'journeys': [self.case['journey']], 'samples': self.case['samples'], 'feed-responses': self.case['boardingRecords']}
            files = []
            for name, rows in content.items():
                data = gzip.compress(''.join(json.dumps(r)+'\n' for r in rows).encode(), mtime=0)
                p = root/(name+'.jsonl.gz');p.write_bytes(data)
                files.append({'file': p.name, 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()})
            manifest = {'capturedAt': 1, 'files': files, 'sampleCoverage': {'complete': True}}
            raw = json.dumps(manifest).encode();(root/'manifest.json').write_bytes(raw)
            receipt = {'directory': str(root), 'manifestSha256': hashlib.sha256(raw).hexdigest()}
            self.assertEqual(pickup.audit_bundle(receipt)['pickupObservation']['source'], 'verified-boarding-check')
            original = root/'feed-responses.jsonl.gz';original.write_bytes(original.read_bytes()+b'changed')
            with self.assertRaisesRegex(ValueError, 'checksum'):
                pickup.audit_bundle(receipt)
