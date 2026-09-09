import gzip, importlib.util, json, pathlib, sys, tempfile, unittest
HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from build_dataset import physical_arrivals
from score import first_forecast_ids, row_metrics, score_pairs, validate
from served_targets import ServedTargets
from compare_stands import forecast
from compare_rebuilt_stands import associate_displays

class PhysicalLabelTests(unittest.TestCase):
    def run_track(self, points):
        rows = [{"bus_name": "b", "bus_id": 1, "route_id": 1, "collected_at": t, "lat": 0., "lon": x / 111195} for t, x in points]
        return physical_arrivals(rows, {1: {"stops": [7, 8, 7], "patternId": "p"}}, {7: {"lat": 0., "lon": 0.}})[0]

    def test_inside_capture_start_is_not_arrival(self):
        self.assertEqual(self.run_track([(0, 40), (5000, 20), (10000, 10)]), [])

    def test_gap_cannot_invent_arrival_or_hide_track_start(self):
        self.assertEqual(self.run_track([(0, 150), (60000, 30)]), [])
        rows = self.run_track([(0, 150), (60000, 150), (65000, 80), (70000, 30)])
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["trackStartAt"], 60000)

    def test_repeated_occurrences_are_retained_and_parking_is_one_arrival(self):
        rows = self.run_track([(0, 150), (5000, 80), (10000, 30), (15000, 35), (20000, 25)])
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["stopIndices"], [0, 2])
        self.assertLessEqual(rows[0]["lowerBoundAt"], rows[0]["arrivedAt"])
        self.assertLessEqual(rows[0]["arrivedAt"], rows[0]["upperBoundAt"])

class PairedMetricTests(unittest.TestCase):
    def row(self, key, episode, value):
        return {"id": key, "episodeId": episode, "issuedAt": 0, "day": "2026-09-04", "routeId": 1,
                "routePatternId": "p", "targetAt": 100000, "actualSec": 100,
                "quantileLevels": [.05 + i * .1 for i in range(10)], "quantilesSec": [value] * 10}

    def test_point_distribution_crps_equals_absolute_error(self):
        r = self.row("a", "a", 150); validate(r)
        self.assertAlmostEqual(row_metrics(r)["quantileCrps"], 50)

    def test_long_wait_poll_count_does_not_dominate(self):
        pairs = [(self.row(str(i), "long", 200), self.row(str(i), "long", 100)) for i in range(100)]
        pairs.append((self.row("short", "short", 100), self.row("short", "short", 200)))
        result = score_pairs(pairs, bootstrap=100)
        self.assertEqual(result["baseline"]["mae"], 50)
        self.assertEqual(result["candidate"]["mae"], 50)
        self.assertEqual(result["delta"]["mae"], 0)

    def test_invalid_truth_clock_rejected(self):
        r = self.row("a", "a", 150); r["targetAt"] += 1000
        with self.assertRaises(ValueError): validate(r)

    def test_first_issue_is_selected_before_horizon_exclusion(self):
        early = self.row("early", "long", 150); late = self.row("late", "long", 150)
        early["actualSec"] = 1900; late["issuedAt"] = 100000
        self.assertEqual(first_forecast_ids([late, early]), {"early"})

    def test_negative_displayed_lower_requires_explicit_physical_interval_mode(self):
        r = self.row("display", "v", 100)
        r.update(target="physical_arrival", quantileLevels=[.1, .5, .9], quantilesSec=[-20, 100, 220])
        with self.assertRaises(ValueError): validate(r)
        validate(r, displayed_intervals=True)
        self.assertEqual(r["quantilesSec"][0], -20)
        r["target"] = "remaining_stand"
        with self.assertRaises(ValueError): validate(r, displayed_intervals=True)
        r.update(target="physical_arrival", quantilesSec=[-20, -1, 220])
        with self.assertRaises(ValueError): validate(r, displayed_intervals=True)

    def test_single_vehicle_day_has_no_clustered_uncertainty_interval(self):
        a = self.row("a", "visit", 150); b = self.row("a", "visit", 100)
        a["busKey"] = b["busKey"] = "bus"
        scored = score_pairs([(a, b)], bootstrap=20, bus_day=True)
        self.assertEqual(scored["busDayBlocks"], 1)
        self.assertIsNone(scored["delta95BusDay"]["mae"])

class ServedTargetTests(unittest.TestCase):
    def test_nearpasses_and_later_laps_do_not_become_next_served_arrivals(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp); day = "2026-09-04"; (root / day).mkdir()
            episodes = [{"id": str(i), "routeId": 1, "busKey": "b", "stopId": i, "stopIndex": i,
                         "routePatternId": "p", "patternResolved": True, "anchoredAt": i * 100000,
                         "pinnedAt": i * 100000 + 10000, "arrivedAt": i * 100000 + 10000,
                         "departedAt": i * 100000 + 20000} for i in range(8)]
            physical = [{"id": f"a{i}", "routeId": 1, "busKey": "b", "stopId": i,
                         "arrivedAt": i * 100000 + 5000, "trackStartAt": 0} for i in range(8)]
            physical += [{"id": "nearpass", "routeId": 1, "busKey": "b", "stopId": 7,
                          "arrivedAt": 50000, "trackStartAt": 0}]
            for name, rows in [("episodes", episodes), ("physical-arrivals", physical)]:
                with gzip.open(root / day / f"{name}.jsonl.gz", "wt") as f:
                    f.write("\n".join(json.dumps(r) for r in rows))
            labels = ServedTargets(root, day)
            row = {"routeId": 1, "busKey": "b", "issuedAt": 15000}
            label, reason = labels.classify({**row, "targetArrivalId": "a5"})
            self.assertIsNone(reason); self.assertEqual(label["servedOccurrencesAhead"], 5)
            self.assertEqual(labels.classify({**row, "targetArrivalId": "a6"})[1], "beyondNextFiveServedOccurrences")
            self.assertEqual(labels.classify({**row, "targetArrivalId": "nearpass"})[1], "notCorroboratedServedTarget")
            self.assertEqual(labels.classify({**row, "targetArrivalId": "a0"})[1], "servedOccurrenceAlreadyArrived")

class DisplayClockTests(unittest.TestCase):
    def test_remaining_truth_uses_departure_not_browser_elapsed(self):
        episode = {"day": "2026-09-04", "routeId": 1, "routePatternId": "p", "stopId": 7,
                   "busKey": "b", "pinnedAt": 100000, "departedAt": 200000}
        row = {"id": "i", "episodeId": "v", "issuedAt": 180000, "elapsedSec": 110,
               "shown": {"sec": 30, "typicalSec": 140}}
        self.assertEqual(forecast(row, episode, "remaining")["actualSec"], 20)
        self.assertEqual(forecast(row, episode, "pinnedTotal")["actualSec"], 100)
        observed = forecast(row, episode, "observedClockTotal")
        self.assertEqual(observed["actualSec"], 20)
        self.assertEqual(observed["quantilesSec"][1], 30)

    def test_wrong_inferred_occurrence_remains_a_prediction_error(self):
        label = {"id": "truth", "routeId": 1, "busKey": "b", "stopId": 7, "stopIndex": 2,
                 "canonicalStopIds": [7, 8, 7], "pinnedAt": 0, "departedAt": 100000,
                 "labelStatus": "complete", "outcome": "stopped"}
        row = {"id": "q", "routeId": 1, "busKey": "b", "stopId": 7, "stopIndex": 0, "issuedAt": 50000}
        joined, counts, _, mismatches = associate_displays({"q": row}, {"truth": label})
        self.assertEqual(joined["q"]["episodeId"], "truth")
        self.assertFalse(joined["q"]["occurrenceAgreement"])
        self.assertEqual(counts["occurrenceMismatch"], 1)
        self.assertEqual(len(mismatches), 1)
        joined, counts, _, _ = associate_displays({"q": row}, {"truth": label, "other": {**label, "id": "other"}})
        self.assertEqual(joined, {})
        self.assertEqual(counts["ambiguousPhysicalVisit"], 1)

if __name__ == "__main__": unittest.main()
