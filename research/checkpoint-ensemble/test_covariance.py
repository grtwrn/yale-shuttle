"""Synthetic matched-case checks; run only on the hosted fixture job."""
import copy
import json
import math
import unittest

from covariance import covariance_report


def row(visit, errors, *, at=0, point_error=None, journey=None):
    truth = 1_790_000_000
    if point_error is None:
        point_error = sum(errors.values()) / len(errors)
    return dict(quality="highway25", route=3, wait=10, k=5, mode="frozen",
                regime="pre", mask=sorted(errors), at=truth * 1000 + at,
                date="2026-09-17", visit=visit, journey=journey or f"j-{visit}",
                truthAbs=truth, pointAbs=truth + point_error,
                components={j: truth + error for j, error in errors.items()})


def group(rows):
    return covariance_report(rows)["groups"][0]


def pair(result, a=1, b=2):
    return next(p for p in result["pairs"] if p["a"] == a and p["b"] == b)


class CovarianceTests(unittest.TestCase):
    def test_shared_delay_agreement_is_not_accuracy(self):
        result = group([row("a", {1: -100, 2: -100}), row("b", {1: 100, 2: 100})])
        self.assertEqual(pair(result)["covarianceSec2"], 10000)
        self.assertEqual(pair(result)["correlation"], 1)
        self.assertEqual(result["meanWithinSnapshotSdSec"], 0)
        self.assertEqual(result["meanWithinSnapshotRangeSec"], 0)
        self.assertEqual(result["ensembleMaeSec"], 100)
        self.assertEqual(result["dispersionBins"][0]["ensembleMaeSec"], 100)

    def test_canceling_errors_have_negative_correlation(self):
        result = group([row("a", {1: -100, 2: 100}), row("b", {1: 100, 2: -100})])
        self.assertEqual(pair(result)["covarianceSec2"], -10000)
        self.assertEqual(pair(result)["correlation"], -1)
        self.assertEqual(result["ensembleMaeSec"], 0)
        self.assertEqual(result["meanWithinSnapshotSdSec"], 100)
        self.assertEqual(result["meanWithinSnapshotRangeSec"], 200)

    def test_repeated_polls_do_not_inflate_visit_weight(self):
        rows = [row("a", {1: 0, 2: 0}, at=i) for i in range(100)]
        rows.append(row("b", {1: 100, 2: 100}, at=100))
        result = group(rows)
        self.assertEqual(result["counts"]["snapshots"], 101)
        self.assertEqual(result["counts"]["visits"], 2)
        self.assertAlmostEqual(result["ensembleBiasSec"], 50)
        self.assertAlmostEqual(pair(result)["covarianceSec2"], 2500)
        self.assertEqual(result["dispersionBins"][0]["fullDenominatorVisitWeight"], 2)

    def test_one_visit_with_many_rows_is_not_independent_support(self):
        result = group([row("a", {1: value, 2: value}, at=i)
                        for i, value in enumerate((-10, 10, 20))])
        self.assertEqual(result["completeCases"]["visits"], 1)
        self.assertIsNone(pair(result)["covarianceSec2"])
        self.assertIsNone(pair(result)["correlation"])
        self.assertEqual(pair(result)["undefinedReason"], "fewer_than_two_physical_visits")

    def test_constant_component_correlation_is_undefined(self):
        result = group([row("a", {1: 10, 2: -10}), row("b", {1: 10, 2: 10})])
        self.assertEqual(result["components"][0]["varianceSec2"], 0)
        self.assertIsNone(pair(result)["covarianceSec2"])
        self.assertIsNone(pair(result)["correlation"])
        self.assertEqual(pair(result)["undefinedReason"], "zero_component_variance")

    def test_exact_fixed_dispersion_boundaries(self):
        rows = [row(str(i), {1: -sd, 2: sd})
                for i, sd in enumerate((0, 29, 30, 59, 60, 119, 120, 299, 300, 400))]
        result = group(rows)
        self.assertEqual([b["counts"]["snapshots"] for b in result["dispersionBins"]],
                         [2, 2, 2, 2, 2, 0])

    def test_unknowns_remain_in_denominator_and_never_become_zero_error(self):
        a = row("a", {1: 100, 2: 100})
        b = row("b", {1: 0, 2: 0})
        b["truthAbs"] = None
        c = row("c", {1: 0, 2: 0})
        c["components"][1] = math.nan
        result = group([a, b, c])
        self.assertEqual(result["counts"]["visits"], 3)
        self.assertEqual(result["completeCases"]["visits"], 1)
        self.assertEqual(result["unknownCases"]["visits"], 2)
        self.assertEqual(result["dispersionBins"][-1]["counts"]["snapshots"], 2)
        self.assertIsNone(result["dispersionBins"][-1]["ensembleMaeSec"])
        self.assertEqual(result["ensembleMaeSec"], 100)
        json.dumps(result, allow_nan=False)

    def test_partial_visit_unknown_uses_explicit_complete_case_weights(self):
        a = row("a", {1: 100, 2: 100})
        unknown = copy.deepcopy(a)
        unknown["at"] += 1
        unknown["pointAbs"] = None
        b = row("b", {1: 0, 2: 0})
        result = group([a, unknown, b])
        self.assertEqual(result["ensembleMaeSec"], 50)
        self.assertEqual(result["dispersionBins"][0]["fullDenominatorVisitWeight"], 1.5)
        self.assertEqual(result["dispersionBins"][0]["completeCaseVisitWeight"], 2)
        self.assertEqual(result["dispersionBins"][-1]["fullDenominatorVisitWeight"], .5)

    def test_singletons_and_different_masks_or_phases_stay_separate(self):
        a = row("a", {1: 1})
        b = row("b", {1: 1, 2: 2})
        c = row("c", {1: 1, 2: 2})
        c["regime"] = "post"
        report = covariance_report([a, b, c])
        self.assertEqual(len(report["groups"]), 3)
        self.assertEqual(report["singletonGroups"], 1)
        self.assertEqual(report["multiOffsetGroups"], 2)
        self.assertEqual(next(g for g in report["groups"] if g["singleton"])
                         ["meanWithinSnapshotRangeSec"], 0)

    def test_visit_and_journey_counts_are_distinct(self):
        a = row("a", {1: 10, 2: 20}, journey="same-trip")
        b = row("b", {1: 30, 2: 40}, journey="same-trip")
        b["date"] = "2026-09-18"
        result = group([a, b])
        self.assertEqual(result["counts"]["visits"], 2)
        self.assertEqual(result["counts"]["journeys"], 1)
        self.assertEqual(result["counts"]["dateCount"], 2)

    def test_offset_order_and_epoch_translation_are_invariant(self):
        rows = [row("a", {1: -10, 2: 20}), row("b", {1: 10, 2: -20})]
        expected = covariance_report(rows)
        shifted = copy.deepcopy(rows)
        for r in shifted:
            r["mask"].reverse()
            r["pointAbs"] += 1000
            r["truthAbs"] += 1000
            r["components"] = {j: value + 1000 for j, value in r["components"].items()}
        self.assertEqual(covariance_report(shifted), expected)

    def test_malformed_metadata_and_component_masks_fail_closed(self):
        mutations = [
            lambda r: r.update(mask=[]),
            lambda r: r.update(mask=[1, 1]),
            lambda r: r.update(mask=[True, 2]),
            lambda r: r.update(components={1: 100}),
            lambda r: r.update(components={"1": 100, "2": 200}),
            lambda r: r.update(at=None),
            lambda r: r.update(date="2026-09-99"),
            lambda r: r.update(visit=True),
            lambda r: r.update(truthAbs="unknown"),
        ]
        for mutation in mutations:
            r = row("a", {1: 1, 2: 2})
            mutation(r)
            with self.subTest(row=r), self.assertRaises(ValueError):
                covariance_report([r])

    def test_empty_and_entirely_unknown_reports_are_serializable(self):
        self.assertEqual(covariance_report([])["groups"], [])
        r = row("a", {1: 1, 2: 2})
        r["pointAbs"] = None
        result = group([r])
        self.assertIsNone(result["ensembleMaeSec"])
        self.assertIsNone(result["components"][0]["meanErrorSec"])
        json.dumps(result, allow_nan=False)


if __name__ == "__main__":
    unittest.main()
