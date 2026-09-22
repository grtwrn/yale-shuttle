import copy
from pathlib import Path
import sys
import unittest
import transform as t
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'useful-windows'))
import rider_risk as risk


class Fixtures(unittest.TestCase):
    def test_exact_point_lower_and_high(self):
        base=dict(eta=300,low=120,high=900)
        self.assertEqual(t.protect(base,dict(eta=400,low=250,high=500)),dict(eta=300,low=120,high=500))
        self.assertEqual(t.protect(base,dict(eta=90,low=60,high=100)),dict(eta=300,low=60,high=300))
        self.assertEqual(t.protect(base,base),base)

    def test_invalid_inputs(self):
        for candidate in (dict(eta=float('nan'),low=0,high=10),dict(eta=3,low=4,high=10),dict(eta=3,low=-1,high=10)):
            with self.assertRaises(AssertionError):t.protect(dict(eta=5,low=0,high=20),candidate)

    def test_outcomes_future_and_other_routes(self):
        source=dict(route=9,deployed=dict(eta=300,low=100,high=900),candidates={'frozen_K1':dict(eta=400,low=200,high=600)},
            candidateEvidence={'frozen_K1':dict(changed=True,source=4,origin=100)},candidateReasons={'frozen_K1':'checkpoint'})
        saved=copy.deepcopy(source);a=t.row(source)
        self.assertEqual(source,saved)
        self.assertEqual(a,t.row(dict(source,label={'arrival':10},truth=99,originalCohort=False,outcomeReason='future')))
        other=t.row(dict(source,route=1));self.assertEqual(other['candidates']['frozen_K1'],source['deployed'])
        self.assertFalse(other['candidateEvidence']['frozen_K1']['changed'])
        self.assertNotIn('origin',other['candidateEvidence']['frozen_K1'])
        self.assertEqual(other['rawCandidateEvidence'],source['candidateEvidence'])

    def test_aging_rendering_all_boundaries(self):
        for eta in (0,15,59,60,61,119,120,300):
            for low in (0,eta/2,eta):
                base=dict(eta=eta,low=low,high=eta+300)
                for candidate in (dict(eta=15,low=0,high=30),dict(eta=600,low=300,high=900),base):
                    fixed=t.protect(base,candidate)
                    for elapsed in range(0,902):
                        self.assertLessEqual(risk.rendered_pickup(fixed,elapsed)['sec'],risk.rendered_pickup(base,elapsed)['sec'])

    def test_actions_and_no_future_prefix(self):
        base=dict(eta=180,low=120,high=600);candidate=dict(eta=350,low=240,high=400)
        fixed=t.protect(base,candidate)
        rows=[dict(at=at,asof=at,origins={},deployed=base,candidates={'protected':fixed}) for at in (0,15000,30000)]
        for walk in risk.WALKS:
            for response in risk.RESPONSES:
                for size in (1,2,3):
                    a=risk.trigger(rows[:size],'deployed','eta',walk,response,240000)
                    b=risk.trigger(rows[:size],'protected','eta',walk,response,240000)
                    for result in (a,b):
                        for field in ('triggerForecast','deadlineForecast'):
                            if field in result:result[field]={'eta':result[field]['eta']}
                    self.assertEqual(a,b)
        # The transform consumes one row, not future snapshots.
        self.assertEqual(fixed,t.protect(base,candidate))


if __name__=='__main__':unittest.main()
