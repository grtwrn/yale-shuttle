import unittest
from followup import FollowupPredictor, adjusted
from hybrid import BASES, release_gate, forecast_modes,observed_exit_gate


class HybridTests(unittest.TestCase):
    def row(self):
        return {'at':1200000,'asof':1190000,'index':15,'target':48,
                'origins':{'9':{'departed':500000,'knownAt':520000}},
                'releaseEvents':[{'index':14,'departed':1100000,'knownAt':1150000,'stand':400}],
                'baseline':{'eta':80,'low':25,'high':180}}

    def bases(self):
        return {base:{'forecast':{'eta':300,'low':100,'high':500},'supported':True} for base in BASES}

    def test_k10_is_ten_not_one(self):
        self.assertEqual(FollowupPredictor.anchor(self.row(),'wait_minus10_departure_mean'),(4,False))
        self.assertEqual(FollowupPredictor.anchor(self.row(),'wait_minus5_departure_mean'),(9,False))

    def test_switch_waits_for_confirmation_not_backdated_departure(self):
        row = self.row();row['asof'] = 1140000
        self.assertIsNone(release_gate(row))
        row['asof'] = 1150000
        self.assertIsNotNone(release_gate(row))

    def test_previous_lap_event_does_not_trigger_switch(self):
        row = self.row();row['origins']['9']['departed'] = 1160000
        row['origins']['9']['knownAt'] = 1170000
        self.assertIsNone(release_gate(row))

    def test_missing_current_approach_does_not_reuse_departure(self):
        row = self.row();row['origins'] = {}
        self.assertIsNone(release_gate(row))

    def test_later_downstream_origin_does_not_undo_release(self):
        row = self.row();row['origins']['16']={'departed':1170000,'knownAt':1180000}
        self.assertIsNotNone(release_gate(row))

    def test_long_canal_is_only_used_in_sensitivity(self):
        row = self.row();row['releaseEvents'][0]['index'] = 13
        self.assertIsNone(release_gate(row))
        self.assertIsNotNone(release_gate(row,True))
        row['releaseEvents'][0]['stand'] = 299
        self.assertIsNone(release_gate(row,True))

    def test_observed_repositioning_does_not_unlatch_switch(self):
        row = self.row();row['index'] = 14;row['phase'] = 'hold'
        row['releaseEvents'].append({'index':13,'departed':1170000,'knownAt':1180000,'stand':10})
        self.assertEqual(release_gate(row,True)['index'],14)

    def test_switch_uses_production_point_and_bounds_without_padding(self):
        row = self.row();forecasts = forecast_modes(row,self.bases())
        calibrated = adjusted([dict(row,forecasts=forecasts)],
                              {base+'/after_344':40 for base in BASES})[0]
        for base in BASES:
            self.assertEqual(calibrated['forecasts'][base+'/after_344']['forecast'],row['baseline'])
            self.assertEqual(calibrated['forecasts'][base+'/no_switch']['forecast']['eta'],300)

    def test_missing_production_after_switch_is_not_invented(self):
        row = self.row();row['baseline'] = None
        forecasts = forecast_modes(row,self.bases())
        self.assertIsNone(forecasts[BASES[0]+'/after_344']['forecast'])

    def test_downstream_phase_switches_without_completed_visit_record(self):
        row=self.row();row['releaseEvents']=[]
        self.assertIsNone(release_gate(row))
        self.assertIsNotNone(observed_exit_gate(row))
        row['index']=14;row['phase']='hold'
        self.assertIsNone(observed_exit_gate(row))
        row['phase']='drive'
        self.assertIsNotNone(observed_exit_gate(row))

    def test_future_position_cannot_prove_wait_exit(self):
        row=self.row();row['releaseEvents']=[];row['observedAt']=row['asof']+1
        self.assertIsNone(observed_exit_gate(row))


if __name__=='__main__':
    unittest.main()
