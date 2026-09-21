import unittest
from followup import FollowupPredictor
from multistop import TARGETS, choice_pair


class MultistopTests(unittest.TestCase):
    def test_k_anchor_is_constant_when_pickup_crosses_ten_stop_boundary(self):
        rows=[{'target':TARGETS[i-15],'index':14} for i in [23,24,25]]
        self.assertEqual([FollowupPredictor.anchor(r,'wait_minus5_departure_mean')[0] for r in rows],[9,9,9])
        self.assertEqual([FollowupPredictor.anchor(r,'ten_before_pickup_mean')[0] for r in rows],[13,14,15])

    def test_different_physical_approaches_cannot_form_incremental_time(self):
        a={'episode':{'sourceId':1},'truth':100}
        b={'episode':{'sourceId':2},'truth':200}
        self.assertIsNone(choice_pair(a,b,'unused'))

    def test_backward_observed_arrival_order_is_not_a_forward_pair(self):
        a={'episode':{'sourceId':1},'truth':200}
        b={'episode':{'sourceId':1},'truth':100}
        self.assertIsNone(choice_pair(a,b,'unused'))


if __name__=='__main__':unittest.main()
