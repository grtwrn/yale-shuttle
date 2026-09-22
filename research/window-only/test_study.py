import unittest

from study import projection, transform


class WindowOnlyTests(unittest.TestCase):
    def test_upper_below_deployed_point_stops_at_point(self):
        self.assertEqual(transform(dict(eta=600, low=300, high=900),
                                   dict(eta=200, low=100, high=400), True),
                         dict(eta=600, low=100, high=600))

    def test_later_candidate_low_cannot_delay_guidance(self):
        self.assertEqual(transform(dict(eta=600, low=300, high=900),
                                   dict(eta=550, low=500, high=700), True),
                         dict(eta=600, low=300, high=700))

    def test_empirical_upper_can_widen_window(self):
        d = dict(eta=100, low=0, high=200)
        self.assertEqual(transform(d, dict(eta=300, low=250, high=500), True),
                         dict(eta=100, low=0, high=500))

    def test_unsupported_is_exact_fallback_and_does_not_mutate(self):
        d = dict(eta=300, low=150, high=500)
        got = transform(d, dict(d), False)
        self.assertEqual(got, d)
        self.assertIsNot(got, d)
        with self.assertRaises(AssertionError):
            transform(d, dict(eta=100, low=0, high=200), False)

    def test_order_and_point_invariants_across_extreme_overlap(self):
        for d in (dict(eta=0, low=0, high=0), dict(eta=1, low=0, high=600),
                  dict(eta=300, low=300, high=300), dict(eta=900, low=0, high=1800)):
            for c in (dict(eta=0, low=0, high=0), dict(eta=600, low=500, high=700),
                      dict(eta=1800, low=1200, high=3000)):
                f = transform(d, c, True)
                self.assertEqual(f['eta'], d['eta'])
                self.assertLessEqual(f['low'], d['low'])
                self.assertLessEqual(f['low'], f['eta'])
                self.assertLessEqual(f['eta'], f['high'])
                self.assertGreaterEqual(f['low'], 0)

    def test_identity_detects_occurrence_label_and_baseline_changes(self):
        row = dict(at=1, bus='bus', route=9, target=26, targetIndex=12,
                   label=dict(id=99, arrival=100, departure=110), truth=.099,
                   baseline=dict(eta=10, low=1, high=20), deployed=dict(eta=9, low=1, high=19),
                   deployedChanged=True, deployedEvidence=None)
        self.assertEqual(projection(row), projection(dict(row)))
        for field, value in (('targetIndex', 19), ('truth', .1), ('deployedChanged', False),
                             ('label', dict(row['label'], departure=111)),
                             ('deployed', dict(row['deployed'], low=2))):
            self.assertNotEqual(projection(row), projection(dict(row, **{field: value})))


if __name__ == '__main__':
    unittest.main()
