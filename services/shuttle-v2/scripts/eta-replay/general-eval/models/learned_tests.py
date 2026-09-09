"""Small semantic checks for causal features and conditional distributions."""
import copy
import math
import unittest

import numpy as np

from learned_features import LEVELS, day_start, features_at_arrival, make_moments, remaining_quantiles
from learned_distribution import atom_remaining_quantiles
from learned_normalized import scales_at_arrival


def episode(day, hour, name, **overrides):
    start = day_start(day) + hour * 3600_000
    return {'id': name, 'routeId': 99, 'routePatternId': 'arbitrary-pattern', 'stopId': 123,
            'stopIndex': 7, 'busKey': 'bus-A', 'day': day, 'split': 'train',
            'anchoredAt': start, 'pinnedAt': start, 'arrivedAt': start,
            'departedAt': start + 120_000, 'outcome': 'stopped', 'knownAt': start + 240_000,
            'nextPhysicalArrivalAt': start + 160_000, 'nextPhysicalArrivalId': name + '-next',
            'targetCensoring': 'observed', 'patternResolved': True, **overrides}


class CausalFeatureTests(unittest.TestCase):
    def test_current_and_future_labels_cannot_change_current_features(self):
        rows = [episode('2026-09-03', hour, str(hour)) for hour in [7, 8, 9, 10, 11]]
        rows += [episode('2026-09-04', hour, 'v' + str(hour)) for hour in [7, 8, 9]]
        original = features_at_arrival(rows, ['2026-09-03'])
        changed = copy.deepcopy(rows)
        for row in changed:
            if row['id'] in ['v8', 'v9']:
                row['departedAt'] += 10_000_000
                row['nextPhysicalArrivalAt'] += 20_000_000
                row['outcome'] = 'unresolved'
        altered = features_at_arrival(changed, ['2026-09-03'])
        np.testing.assert_array_equal(original['v8'], altered['v8'])

    def test_unconfirmed_previous_departure_is_not_a_phase_reference(self):
        rows = [episode('2026-09-03', hour, str(hour)) for hour in [7, 8, 9, 10, 11]]
        rows += [episode('2026-09-04', 7, 'earlier', knownAt=day_start('2026-09-04') + 9 * 3600_000),
                 episode('2026-09-04', 8, 'current')]
        features = features_at_arrival(rows, ['2026-09-03'])
        self.assertTrue(math.isnan(features['current'][12]))  # time away
        self.assertTrue(math.isnan(features['current'][13]))  # phase slack
        self.assertEqual(features['current'][14], 0)

    def test_censored_and_pass_visits_are_coverage_not_current_stand_targets(self):
        rows = [episode('2026-09-03', 7, 'valid'),
                episode('2026-09-03', 8, 'censored', outcome='unresolved', departedAt=None),
                episode('2026-09-03', 9, 'pass', outcome='passed'),
                episode('2026-09-03', 10, 'unpinned', pinnedAt=None)]
        features = features_at_arrival(rows, ['2026-09-03'])
        moments = make_moments(rows, features, ['2026-09-03'], for_training=True)
        self.assertEqual({m['episodeId'] for m in moments['metadata']}, {'valid'})
        self.assertAlmostEqual(float(moments['weights'].sum()), 1)
        self.assertEqual(moments['excluded'], {'unresolved': 1, 'passed': 1, 'unpinned': 1})

    def test_fixed_slot_counts_down_and_overdue_distribution_stays_nonzero(self):
        knots = np.full(19, 600.)
        self.assertEqual(remaining_quantiles(knots, 0)[9], 600)
        self.assertEqual(remaining_quantiles(knots, 100)[9], 500)
        self.assertGreater(remaining_quantiles(knots, 600)[9], 0)

    def test_quantiles_stay_ordered_in_the_overdue_tail(self):
        result = remaining_quantiles(np.linspace(30, 300, len(LEVELS)), 1_000_000)
        self.assertTrue(np.isfinite(result).all())
        self.assertTrue((np.diff(result) > 0).all())

    def test_normalized_scale_cannot_read_validation_outcomes(self):
        rows = [episode('2026-09-03', hour, str(hour)) for hour in [7, 8, 9]]
        rows += [episode('2026-09-04', 7, 'validation')]
        expected = scales_at_arrival(rows, ['2026-09-03'])
        rows[-1]['departedAt'] += 100_000_000
        self.assertEqual(expected, scales_at_arrival(rows, ['2026-09-03']))

    def test_normalized_weight_preserves_seconds_pinball_objective(self):
        residual = np.array([-80., 5., 20., 1000.])
        scale = np.array([10., 30., 60., 400.])
        q = .9
        loss = lambda r: np.maximum(q * r, (q - 1) * r)
        np.testing.assert_allclose(loss(residual), scale * loss(residual / scale))

    def test_atom_law_conditions_pass_mass_at_zero_and_keeps_tail(self):
        q = [0.] * 12 + [120.] * 7
        self.assertEqual(atom_remaining_quantiles(q, 0)[9], 120)
        self.assertAlmostEqual(atom_remaining_quantiles(q, 1e-9)[9], 120)
        np.testing.assert_array_equal(atom_remaining_quantiles(q, 120), atom_remaining_quantiles(q, 1e9))


if __name__ == '__main__':
    unittest.main()
