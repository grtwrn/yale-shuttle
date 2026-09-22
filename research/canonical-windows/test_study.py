import unittest
from unittest.mock import patch

import study
ev = study.ev
rr = study.rr


class CanonicalTest(unittest.TestCase):
    def setUp(self):
        self.routes, self.waits = ev.ROUTES, ev.WAITS
        ev.ROUTES = {1: {'id': 1, 'name': 'Fold', 'stops': [11, 22, 33, 22, 44]}}
        ev.WAITS = {1: [2]}

    def tearDown(self):
        ev.ROUTES, ev.WAITS = self.routes, self.waits

    def row(self, target=3):
        return dict(ready=True, route=1, bus='300', target=22, targetIndex=target,
            anchorIndex=2, occurrenceReason='causal anchors agree on repeated target',
            index=2, nearest=2, phase='hold', stopsAhead=(target-2)%5,
            at=200000, asof=200000, origins={'1': {'departed':100000,'knownAt':100001}},
            baseline={'eta':999,'low':500,'high':1500})

    def model(self):
        model = object.__new__(study.Models)
        model.fit = lambda rid,k,w,ti,dep: {'eta':1000+ti,'low':500+ti,'high':1500+ti}
        return model

    def test_repeated_target_occurrences_keep_distinct_forecasts(self):
        a = self.model().predict(self.row(3), 'K1')
        b = self.model().predict(self.row(1), 'K1')
        self.assertTrue(a['changed'] and b['changed'])
        self.assertEqual(a['forecast']['eta'], 903)
        self.assertEqual(b['forecast']['eta'], 901)

    def test_missing_other_occurrence_falls_back_whole_group(self):
        model = self.model(); original = model.fit
        model.fit = lambda rid,k,w,ti,dep: None if ti == 1 else original(rid,k,w,ti,dep)
        result = model.predict(self.row(), 'K1')
        self.assertFalse(result['changed'])
        self.assertEqual(result['unsupportedTargetIndex'], 1)
        self.assertEqual(result['forecast'], self.row()['baseline'])

    def test_expired_other_occurrence_falls_back_whole_group(self):
        model = self.model(); original = model.fit
        model.fit = lambda rid,k,w,ti,dep: {'eta':150,'low':100,'high':200} if ti == 1 else original(rid,k,w,ti,dep)
        result = model.predict(self.row(), 'K1')
        self.assertFalse(result['changed'])
        self.assertEqual(result['reason'], 'group countdown expired')

    def test_release_latch_cannot_reactivate_old_origin(self):
        row = self.row(); row['releasedOrigins'] = {'1/2':100000}
        self.assertEqual(self.model().predict(row, 'K1')['reason'], 'released/live')

    def test_ambiguous_target_never_uses_first_index(self):
        row = self.row(); row['targetIndex'] = None; row['occurrenceReason'] = 'ambiguous'
        self.assertFalse(self.model().predict(row, 'K1')['changed'])

    def visit(self, index, at):
        return dict(id=at, bus_name='300', route_id=1, stop_id=22, stop_index=index,
            arrived_at=at, departed_at=at+10000, known_at=at+15000, anchored_at=at,
            outcome='stopped', how='observed', closest_m=10)

    def test_label_refuses_to_skip_earlier_physical_pickup(self):
        quality = type('Quality', (), {'ok':lambda *args:True})()
        outcomes = study.Outcomes([self.visit(3,300000), self.visit(1,500000)], quality)
        self.assertEqual(outcomes.label(self.row(1))[1], 'intervening physical pickup has different occurrence')
        label, reason = outcomes.label(self.row(3))
        self.assertIsNone(reason)
        self.assertEqual(label['id'],300000)

    def test_future_label_does_not_resolve_ambiguous_feature(self):
        quality = type('Quality', (), {'ok':lambda *args:True})()
        outcomes = study.Outcomes([self.visit(3,300000)], quality)
        row = self.row(); row['targetIndex'] = None
        self.assertEqual(outcomes.label(row)[1], 'causal target occurrence unresolved')

    def test_truth_requires_gps_through_departure(self):
        calls = []
        class Quality:
            def ok(self, bus,rid,start,end):
                calls.append(end)
                return False
        outcomes = study.Outcomes([self.visit(3,300000)], Quality())
        self.assertIsNone(outcomes.label(self.row())[0])
        self.assertEqual(calls,[310000])

    def test_availability_and_calendar_embargo(self):
        cut = rr.cutoff_for('2026-09-18')
        self.assertEqual(ev.date(cut),'2026-09-17')
        self.assertFalse(rr.available(dict(arrived_at=cut-10000,departed_at=cut-5000,known_at=cut),cut))
        self.assertTrue(rr.available(dict(arrived_at=cut-10000,departed_at=cut-5000,known_at=cut-1),cut))


if __name__ == '__main__':
    unittest.main()
