import copy
import unittest

from audit import classify, clock_comparison


ARM = 'rolling_K5'


def row(at, changed, reason='checkpoint', origin=100):
    forecast = dict(eta=300, low=100, high=500)
    evidence = dict(changed=changed, reason=reason)
    if changed:
        evidence.update(source=0, wait=5, origin=origin)
    return dict(at=at, asof=at, observedAt=at-1000, ready=True, index=5,
        phase='hold', began=200, origins={'0': dict(departed=origin, knownAt=origin+10)},
        releasedOrigins={}, candidateEvidence={ARM: evidence}, candidates={ARM: forecast}, deployed=dict(forecast))


class Causes(unittest.TestCase):
    def test_retained_confirmation_is_distinct_from_phase_only_release(self):
        a, b = row(1000, True), row(2000, False, 'released/live')
        b['phase'] = 'drive'
        self.assertEqual(classify(a, b, ARM, 9, [])[0], 'other explicit reason')
        b['origins']['5'] = dict(departed=150, knownAt=1800)
        self.assertEqual(classify(a, b, ARM, 9, [])[0], 'confirmed wait departure')

    def test_future_confirmation_never_explains_current_release(self):
        a, b = row(1000, True), row(2000, False, 'released/live')
        v = dict(id=1, stop_index=5, departed_at=150, arrived_at=120,
                 outcome='stopped', how='far', known_at=2001)
        self.assertEqual(classify(a, b, ARM, 9, [v])[0], 'other explicit reason')

    def test_missing_phase_is_not_called_a_gps_gap(self):
        a, b = row(1000, True), row(2000, False, 'not warm/fresh')
        b.update(ready=False, index=-1, phase='unknown')
        self.assertIn('fresh GPS but no usable reducer phase', classify(a, b, ARM, 9, [])[1])
        b.update(asof=20000)
        self.assertIn('older than existing15s', classify(a, b, ARM, 9, [])[1])

    def test_source_age_expiry_is_not_tracking_loss(self):
        a, b = row(2699000, True), row(2701000, False, 'source departure unavailable')
        b['origins'] = {}
        self.assertEqual(classify(a, b, ARM, 9, [])[1], 'source removed by existing45-minute feature horizon')

    def test_new_source_is_causal_not_a_future_guess(self):
        a, b = row(1000, False, 'source departure unavailable'), row(2000, True, origin=1500)
        a['origins'] = {}
        self.assertEqual(classify(a, b, ARM, 9, [])[0], 'source-origin switch')

    def test_group_expiry_and_daily_fit_are_explicit(self):
        a, b = row(1000, True), row(2000, False, 'group countdown expired')
        self.assertEqual(classify(a, b, ARM, 9, [])[0], 'group countdown expiry')
        b = row(2000, True)
        self.assertEqual(classify(a, b, ARM, 9, [])[1], 'daily refit with unchanged source/wait/origin')

    def test_absolute_clocks_remove_natural_elapsed_countdown(self):
        a = row(1000, True)
        b = copy.deepcopy(a)
        b.update(at=16000)
        for f in (b['candidates'][ARM], b['deployed']):
            for k in f:
                f[k] -= 15
        result = clock_comparison(a, b, ARM)
        self.assertTrue(all(v['absoluteJumpSec'] == v['introducedJumpSec'] == 0 for v in result.values()))
        b['candidates'][ARM]['high'] += 120
        self.assertEqual(clock_comparison(a, b, ARM)['high']['introducedJumpSec'], 120)


if __name__ == '__main__':
    unittest.main()
