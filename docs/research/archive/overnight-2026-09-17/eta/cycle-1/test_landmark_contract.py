"""Substantive research-contract tests; no production code modifications."""
import copy
import json
import math
from pathlib import Path
import unittest
import numpy as np
from extract_landmarks import Events
from fit_landmarks import design,quantiles

OUT=Path(__file__).resolve().parent


class ContractTests(unittest.TestCase):
    def test_constant_hazard_quantiles_match_analytic_survival(self):
        hazard=1/300
        z=math.log(math.expm1(15*hazard))
        np.testing.assert_allclose(quantiles(np.full(120,z)),[-math.log1p(-p)/hazard for p in (.1,.5,.9)],rtol=1e-12)

    def test_right_tail_is_not_a_departure_at_computation_horizon(self):
        q=quantiles(np.full(120,-20.0))
        self.assertGreater(q[0],1800)
        self.assertGreater(q[2],q[1])
        self.assertTrue(all(math.isfinite(v) for v in q))

    def test_extreme_hazard_remains_numerically_finite(self):
        for z in (-1000,1000):
            q=quantiles(np.full(120,z))
            self.assertTrue(0<=q[0]<=q[1]<=q[2])
            self.assertTrue(all(math.isfinite(v) for v in q))

    def test_future_outcome_not_used_by_forecast_design(self):
        rs=[json.loads(s) for s in (OUT/'landmarks.jsonl').read_text().splitlines()]
        r=next(r for r in rs if r['lapSupported'] and r['snapshots']['ahead']['usable'])
        a=design(r,np.array([7.5,907.5,1792.5]))
        edited=copy.deepcopy(r)
        edited.update(truthRemaining=99999,outcomeReady=9999999999999)
        b=design(edited,np.array([7.5,907.5,1792.5]))
        for x,y in zip(a,b):np.testing.assert_array_equal(x,y)
        # Non-clock peer columns must be frozen even thousands of seconds ahead.
        width=len(r['snapshots']['ahead']['features'])
        np.testing.assert_array_equal(a[1][0,:width],a[1][-1,:width])
        np.testing.assert_array_equal(a[1][0,3*width:4*width],a[1][-1,3*width:4*width])

    def test_unknown_lap_has_exact_peer_fallback(self):
        r=json.loads((OUT/'landmarks.jsonl').read_text().splitlines()[0])
        r['lapSupported']=False
        _,peer=design(r,np.array([7.5,1007.5]))
        self.assertFalse(np.any(peer))

    def test_latest_other_route_and_stale_evidence_fail_closed(self):
        # Minimal primitive records: unrelated future outcome fields may exist.
        at=1789400000000
        def visit(i,route,anchor):
            return dict(id=i,bus_name='#peer',route_id=route,stop_id=11,stop_index=0,
                anchored_at=anchor,pinned_at=None,departed_at=None,how=None,first_moved_at=None,confirm_sec=None,closest_m=10)
        peer=dict(bus='#peer',origin=at-200000)
        events=Events([visit(1,3,at-90000),visit(2,9,at-30000)], [11,121])
        self.assertEqual(events.snapshot(peer,11,at,'arrival15')['reason'],'latest_anchor_other_route')
        # A future reassignment must not remove an earlier valid Red snapshot.
        self.assertTrue(events.snapshot(peer,11,at-20000,'arrival15')['usable'])
        events=Events([visit(1,3,at-700000)], [11,121])
        self.assertEqual(events.snapshot(peer,11,at,'arrival15')['reason'],'stale_or_invalid_anchor')


if __name__=='__main__':unittest.main()
