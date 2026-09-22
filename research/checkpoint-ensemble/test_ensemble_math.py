"""Independent synthetic arithmetic checks; execute on hosted runners only."""
import copy
import math
import unittest

from ensemble_math import joint_deviations, mean_absolute, wire_forecast


def vector(index, durations):
    journey, target, wait = f"journey-{index}", f"target-{index}", f"wait-{index}"
    return dict(journeyId=journey, targetId=target, waitId=wait,
                components={j: dict(journeyId=journey, targetId=target,
                                    waitId=wait, sourceId=f"source-{index}-{j}",
                                    durationSec=value)
                            for j, value in durations.items()})


class AbsoluteAverageTests(unittest.TestCase):
    def test_average_arrival_clocks_not_durations(self):
        self.assertEqual(mean_absolute({1: 100, 2: 40}, {1: 40, 2: 120},
                                       (1, 2)), 150)

    def test_one_source_and_translation(self):
        self.assertEqual(mean_absolute({5: 20}, {5: 91.125}, (5,)), 111.125)
        offsets = (1, 2)
        departures, means = {1: 100, 2: 40}, {1: 40, 2: 120}
        base = mean_absolute(departures, means, offsets)
        translated = mean_absolute({j: v + 1_790_000_000 for j, v in departures.items()},
                                   means, offsets)
        self.assertEqual(translated - 1_790_000_000, base)
        self.assertEqual(wire_forecast(base, base - 20, base + 20, 100),
                         wire_forecast(translated, translated - 20, translated + 20,
                                       1_790_000_100))

    def test_clip_after_average(self):
        # At clock100 the two raw countdowns are -20 and+40. The average is10,
        # whereas averaging individually clipped countdowns incorrectly gives20.
        point = mean_absolute({1: 0, 2: 0}, {1: 80, 2: 140}, (1, 2))
        self.assertEqual(point, 110)
        self.assertEqual(wire_forecast(point, point, point, 100),
                         dict(eta=10, low=10, high=10))

    def test_round_after_average(self):
        # Individual rounding gives 1 and2, then an incorrectly rounded mean2.
        point = mean_absolute({1: 100, 2: 100}, {1: 1.49, 2: 1.5}, (1, 2))
        self.assertAlmostEqual(point, 101.495)
        self.assertEqual(wire_forecast(point, point, point, 100)["eta"], 1)
        self.assertEqual(wire_forecast(101.5, 100.49, 102.5, 100),
                         dict(eta=2, low=0, high=3))

    def test_invalid_offsets_and_keys(self):
        for offsets in ((), (1, 1), (-1,), (True,), (1.0,), [1]):
            with self.subTest(offsets=offsets), self.assertRaises(ValueError):
                mean_absolute({1: 100}, {1: 20}, offsets)
        for values in ({}, {1: 10, 2: 20}, {"1": 10}, {True: 10}):
            with self.subTest(values=values), self.assertRaises(ValueError):
                mean_absolute(values, {1: 20}, (1,))
            with self.subTest(means=values), self.assertRaises(ValueError):
                mean_absolute({1: 100}, values, (1,))

    def test_nonfinite_or_boolean_values_rejected(self):
        for value in (math.nan, math.inf, -math.inf, True, "100", None):
            with self.subTest(value=value), self.assertRaises(ValueError):
                mean_absolute({1: value}, {1: 20}, (1,))


class JointDeviationTests(unittest.TestCase):
    def setUp(self):
        self.errors = (-40, -30, -20, -10, 10, 20, 30, 40)
        self.shared = [vector(i, {1: 200 + e, 2: 300 + e})
                       for i, e in enumerate(self.errors)]
        self.weights = [1] * len(self.errors)

    def test_common_future_wait_does_not_shrink(self):
        joint = joint_deviations(self.shared, (1, 2), self.weights)
        single = joint_deviations(self.shared, (1, 2), self.weights, (2,))
        self.assertEqual(joint["meanDuration"], 250)
        self.assertEqual((joint["q10"], joint["q90"]), (-40, 40))
        self.assertEqual((joint["q10"], joint["q90"]),
                         (single["q10"], single["q90"]))
        self.assertEqual(joint["effective"], 8)
        self.assertEqual(joint["count"], 8)

    def test_canceling_component_errors_can_shrink(self):
        paired = [vector(i, {1: 200 - e, 2: 300 + e})
                  for i, e in enumerate(self.errors)]
        joint = joint_deviations(paired, (1, 2), self.weights)
        single = joint_deviations(paired, (1, 2), self.weights, (2,))
        self.assertEqual((joint["q10"], joint["q90"]), (0, 0))
        self.assertEqual((single["q10"], single["q90"]), (-40, 40))

    def test_empirical_weights_effective_count_and_scaling(self):
        rows = [vector(i, {5: value}) for i, value in enumerate((100, 200, 300))]
        result = joint_deviations(rows, (5,), [1, 8, 1])
        self.assertAlmostEqual(result["meanDuration"], 200)
        self.assertAlmostEqual(result["effective"], 100 / 66)
        self.assertEqual((result["q10"], result["q90"]), (-100, 0))
        for scale in (1e-200, 1e200):
            scaled = joint_deviations(rows, (5,), [scale, 8 * scale, scale])
            self.assertEqual(scaled, result)

    def test_single_offset_and_order_invariance(self):
        rows = [vector(i, {5: 100 + e}) for i, e in enumerate(self.errors)]
        result = joint_deviations(rows, (5,), self.weights)
        self.assertEqual(result["meanDuration"], 100)
        self.assertEqual((result["q10"], result["q90"]), (-40, 40))
        self.assertEqual(joint_deviations(list(reversed(rows)), (5,), self.weights), result)
        self.assertEqual(joint_deviations(self.shared, (1, 2), self.weights),
                         joint_deviations(self.shared, (2, 1), self.weights))

    def test_identity_mismatches_and_duplicate_vectors_rejected(self):
        for field in ("journeyId", "targetId", "waitId"):
            rows = copy.deepcopy(self.shared)
            rows[0]["components"][1][field] = "some-other-physical-traversal"
            with self.subTest(field=field), self.assertRaises(ValueError):
                joint_deviations(rows, (1, 2), self.weights)
        with self.assertRaises(ValueError):
            joint_deviations(self.shared + [self.shared[0]], (1, 2), self.weights + [1])
        rows = copy.deepcopy(self.shared)
        rows[0]["components"][1]["sourceId"] = rows[0]["components"][2]["sourceId"]
        with self.assertRaises(ValueError):
            joint_deviations(rows, (1, 2), self.weights)

    def test_projection_cannot_hide_invalid_other_components(self):
        rows = copy.deepcopy(self.shared)
        rows[0]["components"][1]["targetId"] = "wrong"
        with self.assertRaises(ValueError):
            joint_deviations(rows, (1, 2), self.weights, (2,))
        for projection in ((), (0,), (1, 1)):
            with self.subTest(projection=projection), self.assertRaises(ValueError):
                joint_deviations(self.shared, (1, 2), self.weights, projection)

    def test_missing_extra_offsets_bad_duration_and_bad_weights(self):
        for components in ({1: self.shared[0]["components"][1]},
                           dict(self.shared[0]["components"], **{"3": {}})):
            rows = copy.deepcopy(self.shared)
            rows[0]["components"] = components
            with self.subTest(components=components), self.assertRaises(ValueError):
                joint_deviations(rows, (1, 2), self.weights)
        for value in (0, -1, math.nan, math.inf, True, "20"):
            rows = copy.deepcopy(self.shared)
            rows[0]["components"][1]["durationSec"] = value
            with self.subTest(duration=value), self.assertRaises(ValueError):
                joint_deviations(rows, (1, 2), self.weights)
            weights = list(self.weights)
            weights[0] = value
            with self.subTest(weight=value), self.assertRaises(ValueError):
                joint_deviations(self.shared, (1, 2), weights)
        with self.assertRaises(ValueError):
            joint_deviations([], (1, 2), [])
        with self.assertRaises(ValueError):
            joint_deviations(self.shared, (1, 2), [1])


class WireTests(unittest.TestCase):
    def test_enclose_point_protect_early_bound_and_clip(self):
        self.assertEqual(wire_forecast(200, 210, 220, 100),
                         dict(eta=100, low=100, high=120))
        self.assertEqual(wire_forecast(230, 210, 220, 100, deployed_low=80),
                         dict(eta=130, low=80, high=130))
        self.assertEqual(wire_forecast(230, 210, 220, 100, deployed_low=150),
                         dict(eta=130, low=110, high=130))
        self.assertEqual(wire_forecast(90, 80, 120, 100),
                         dict(eta=0, low=0, high=20))

    def test_invalid_intervals_or_clocks_rejected(self):
        with self.assertRaises(ValueError):
            wire_forecast(100, 120, 110, 90)
        with self.assertRaises(ValueError):
            wire_forecast(100, 90, 110, 80, deployed_low=-1)
        for position in range(4):
            args = [100, 90, 110, 80]
            args[position] = math.nan
            with self.subTest(position=position), self.assertRaises(ValueError):
                wire_forecast(*args)


if __name__ == "__main__":
    unittest.main()
