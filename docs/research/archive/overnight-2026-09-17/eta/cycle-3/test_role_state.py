import datetime as dt
import math
import unittest
import numpy as np
from role_state import History,features,unit,phase_error,TZ
from run_role import base

START=int(dt.datetime(2026,9,8,8,tzinfo=TZ).timestamp()*1000)
def dep(i,stop,seconds,bus='#test'):
    return dict(id=i,bus=bus,stop=stop,physical=START+seconds*1000,known=START+(seconds+120)*1000)
def query(seconds=10200):
    return dict(id=99,bus='#test',stop=11,pinAt=START+seconds*1000,lapSupported=True)
def history():
    return [dep(1,11,0),dep(2,121,1800),dep(3,11,3600),dep(4,121,5400),dep(5,11,7200),dep(6,121,9000)]
THRESH={11:300,121:300}

class RoleContract(unittest.TestCase):
    def test_prior_only_and_shrinkage(self):
        s=History(history(),[]).snapshot(query(),THRESH)
        self.assertTrue(s['supported']);self.assertEqual(s['ids'],[1,3,5])
        self.assertGreater(s['recursive']['confidence'],s['two']['confidence'])
        self.assertLess(s['recursive']['confidence'],1)
        more=history()+[dep(99,11,10800)]
        self.assertEqual(s,History(more,[]).snapshot(query(),THRESH))

    def test_delayed_confirmation(self):
        ds=history();ds[4]['known']=query()['pinAt']+1
        s=History(ds,[]).snapshot(query(),THRESH)
        self.assertNotIn(5,s['ids']);self.assertFalse(s['supported'])

    def test_day_gap_and_opposite_resets(self):
        self.assertEqual(History(history(),[]).snapshot(query(24*3600+10200),THRESH)['reason'],'no_confirmed_history')
        ds=history();ds=[d for d in ds if d['id']!=4]
        s=History(ds,[]).snapshot(query(),THRESH)
        self.assertEqual(s['ids'],[5]);self.assertEqual(s['resets'][-1]['reason'],'missing_opposite_at_update')
        ds=history()+[dep(7,11,14400),dep(8,121,16200)]
        s=History(ds,[]).snapshot(query(17000),THRESH)
        self.assertEqual(s['ids'],[7]);self.assertEqual(s['resets'][-1]['reason'],'gap_outside_30_90min')

    def test_role_change_and_route_change_reset(self):
        ds=history();ds[4]=dep(5,11,7800)
        s=History(ds,[]).snapshot(query(),THRESH)
        self.assertEqual(s['ids'],[5]);self.assertEqual(s['resets'][-1]['reason'],'phase_innovation')
        anchors=[dict(id=50,bus='#test',route=8,physical=START+8000000,known=START+8015000),
                 dict(id=51,bus='#test',route=3,physical=START+10000000,known=START+10015000)]
        s=History(history(),anchors).snapshot(query(),THRESH)
        self.assertEqual(s['reason'],'no_confirmed_history')

    def test_unsupported_exact_zero_and_wrap(self):
        r=query();r['lapSupported']=False;s=History(history(),[]).snapshot(r,THRESH)
        self.assertEqual(s['reason'],'unsupported_lap')
        r.update(role=s,elapsed=60)
        self.assertTrue(np.array_equal(features(r,np.array([1,2]),'recursive'),np.zeros((2,3))))
        self.assertAlmostEqual(phase_error(unit(3599000),unit(1000)),2)

    def test_tail_quantiles_are_not_capped(self):
        q=base.quantiles(np.full(120,-20.))
        self.assertGreater(q[0],1800)
        self.assertTrue(0<q[0]<q[1]<q[2] and all(math.isfinite(v) for v in q))

if __name__=='__main__':unittest.main()
