import unittest
from evaluate import Predictor
from followup import FollowupPredictor, adjusted
import test_experiment


class FollowupTests(unittest.TestCase):
    def data(self, index):
        fixture = test_experiment.ExperimentTests()
        paths = [dict(e,sourceIndex=index,arrivalStart=e['start']-300000) for e in fixture.paths()]
        row = fixture.feature()
        row['checkpointOrigins'] = {str(index):row['origins']['9']}
        row['checkpointArrivals'] = {str(index):dict(row['origins']['9'],departed=row['origins']['9']['departed']-100000)}
        return paths,row

    def test_user_definition_counts_before_wait_stop(self):
        row = {'index':14,'nearestIndex':14,'target':48}
        self.assertEqual(FollowupPredictor.anchor(row,'wait_minus1_departure_mean'),(13,False))
        self.assertEqual(FollowupPredictor.anchor(row,'wait_minus2_arrival_mean'),(12,True))
        self.assertEqual(FollowupPredictor.anchor(row,'trailing_ten_mean'),(4,False))
        self.assertEqual(FollowupPredictor.anchor(row,'ten_before_pickup_mean'),(7,False))

    def test_k2_equals_original_model(self):
        paths,row = self.data(12)
        row['origins'] = row['checkpointOrigins']
        a = FollowupPredictor(paths).predict(row,'wait_minus2_departure_mean')
        b = Predictor(paths).predict(row,'five_before_mean')
        self.assertEqual(a['forecast'],b['forecast'])
        self.assertEqual(a['effective'],b['effective'])

    def test_arrival_boundary_includes_source_hold(self):
        paths,row = self.data(13)
        model = FollowupPredictor(paths)
        self.assertEqual(model.predict(row,'wait_minus1_departure_mean')['forecast']['eta'],0)
        self.assertAlmostEqual(model.predict(row,'wait_minus1_arrival_mean')['forecast']['eta'],200)

    def test_active_arrival_does_not_require_future_departure(self):
        paths,row = self.data(13)
        row['checkpointOrigins'] = {}
        model = FollowupPredictor(paths)
        self.assertFalse(model.predict(row,'wait_minus1_departure_mean')['supported'])
        self.assertTrue(model.predict(row,'wait_minus1_arrival_mean')['supported'])

    def test_ten_back_never_wraps_to_previous_lap(self):
        paths,row = self.data(13)
        row['nearestIndex'] = 8
        result = FollowupPredictor(paths).predict(row,'trailing_ten_mean')
        self.assertFalse(result['supported'])
        self.assertEqual(result['forecast'],row['baseline'])

    def test_future_arrival_observation_rejected(self):
        paths,row = self.data(13)
        row['checkpointArrivals']['13']['knownAt'] = row['asof']+1
        with self.assertRaises(AssertionError):
            FollowupPredictor(paths).predict(row,'wait_minus1_arrival_mean')

    def test_interval_contraction_preserves_point_and_ordering(self):
        row = {'forecasts':{'logged_production':{'supported':False,'forecast':{'eta':100,'low':0,'high':300}}}}
        result = adjusted([row],{'logged_production':-250},True)[0]['forecasts']['logged_production']['forecast']
        self.assertEqual(result,{'eta':100,'low':100,'high':100})
        self.assertEqual(row['forecasts']['logged_production']['forecast']['high'],300)


if __name__=='__main__':
    unittest.main()
