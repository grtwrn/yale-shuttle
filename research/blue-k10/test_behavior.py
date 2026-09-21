"""Decision-level tests: same-loop targets, long wraparound and whole-group safety."""
import unittest
from evaluate import Models, Outcomes, CUTOFF, ROUTES
class Behavior(unittest.TestCase):
    def setUp(self):
        self.model=Models.__new__(Models)
        self.now=CUTOFF+86_400_000
        self.base=dict(eta=400,low=200,high=700)
        self.row=dict(route=16,target=154,at=self.now,asof=self.now,bus='#test',ready=True,
            index=9,nearest=9,phase='drive',stopsAhead=4,baseline=self.base,
            origins={'1':dict(departed=self.now-600_000,knownAt=self.now-590_000)})
        self.model.fit=lambda rid,k,w,ti,departure:dict(eta=1000+ti*50,low=900+ti*50,high=1200+ti*50)
    def test_wrapped_destination_after_wait_is_eligible_but_next_stop_before_wait_is_live(self):
        got=self.model.predict(self.row,'K10')
        self.assertTrue(got['changed']);self.assertEqual(got['wait'],0);self.assertEqual(got['source'],1)
        before=dict(self.row,target=98,stopsAhead=1)
        self.assertEqual(self.model.predict(before,'K10')['reason'],'pickup before wait')
    def test_logged_anchor_survives_nearest_stop_shuffle_but_rejects_the_wrong_lap(self):
        holding=dict(self.row,index=0,nearest=1,phase='hold',stopsAhead=2)
        self.assertTrue(self.model.predict(holding,'K10')['changed'])
        wrong_lap=dict(holding,stopsAhead=1)
        self.assertEqual(self.model.predict(wrong_lap,'K10')['reason'],'occurrence disagreement')
    def test_expiry_at_another_pickup_and_missing_far_support_switch_the_whole_group(self):
        fit=self.model.fit
        self.model.fit=lambda rid,k,w,ti,departure:dict(eta=659,low=620,high=800) if ti==1 else fit(rid,k,w,ti,departure)
        self.assertEqual(self.model.predict(self.row,'K10')['forecast'],self.base)
        self.assertEqual(self.model.predict(self.row,'K10')['reason'],'group countdown expired')
        self.model.fit=lambda rid,k,w,ti,departure:None if ti==10 else fit(rid,k,w,ti,departure)
        self.assertEqual(self.model.predict(self.row,'K10')['reason'],'group lacks historical support')
    def test_confirmed_wait_release_copies_the_full_live_forecast(self):
        row=dict(self.row,origins={**self.row['origins'],'0':dict(departed=self.now-100_000,knownAt=self.now-90_000)})
        got=self.model.predict(row,'K10');self.assertEqual(got['forecast'],self.base);self.assertFalse(got['changed'])
        self.assertEqual(got['reason'],'released/live')
    def test_night_cedar_arrival_uses_the_previous_union_wait(self):
        row=dict(self.row,route=13,target=10,index=16,nearest=16,phase='hold',stopsAhead=4,
            origins={'6':dict(departed=self.now-600_000,knownAt=self.now-590_000)})
        got=self.model.predict(row,'K10');self.assertTrue(got['changed']);self.assertEqual(got['wait'],16);self.assertEqual(got['source'],6)
    def test_future_origin_is_rejected_and_a_later_lap_is_not_the_next_arrival(self):
        row=dict(self.row,origins={'1':dict(departed=self.now-1000,knownAt=self.now+1)})
        with self.assertRaises(AssertionError):self.model.predict(row,'K10')
        labels=Outcomes([],None)
        self.assertEqual(labels.label(dict(self.row,stopsAhead=15)),(None,'later-lap forecast'))
if __name__=='__main__':unittest.main()
