import copy
import datetime as dt
import unittest
from evaluate import Predictor, TRAIN_END, TZ, ARMS, quantile

class ExperimentTests(unittest.TestCase):
    def paths(self):
        paths=[]
        for day in range(8,12):
            start=int(dt.datetime(2026,9,day,12,tzinfo=TZ).timestamp()*1000)
            for n in range(10):
                duration=600 if n<5 else 1200
                paths.append({'day':f'2026-09-{day:02d}','bus':'#1','sourceIndex':9,'target':48,'start':start,'end':start+duration*1000,'duration':duration,'stages':{'13':{'arrive':start+60000,'depart':start+300000,'driveEnd':start+360000},'14':{'arrive':start+360000,'depart':start+duration*1000-60000,'driveEnd':start+duration*1000}}})
        return paths

    def feature(self):
        start=int(dt.datetime(2026,9,17,12,tzinfo=TZ).timestamp()*1000)
        return {'at':start+900000,'asof':start+900000,'began':start+360000,'age':540,'index':14,'phase':'hold','target':48,'origins':{'9':{'departed':start,'knownAt':start+30000}},'canal':None,'baseline':{'eta':400,'low':30,'high':800}}

    def test_mean_subtracts_elapsed_before_clipping(self):
        result=Predictor(self.paths()).predict(self.feature(),'fixed_mean')
        self.assertTrue(result['supported'])
        # Mean total900 minus elapsed900 is0; averaging clipped residuals
        # would incorrectly predict150seconds.
        self.assertAlmostEqual(result['forecast']['eta'],0)
        self.assertAlmostEqual(result['forecast']['high'],300)

    def test_survival_keeps_only_unfinished_complete_paths(self):
        result=Predictor(self.paths()).predict(self.feature(),'fixed_survival')
        self.assertTrue(result['supported'])
        self.assertAlmostEqual(result['forecast']['eta'],300)

    def test_future_completed_paths_do_not_enter_history(self):
        paths=self.paths();feature=self.feature();base=Predictor(paths)
        polluted=paths+[dict(paths[0],day='2026-09-17',end=TRAIN_END+100000,duration=99999)]
        for arm in ARMS:self.assertEqual(base.predict(feature,arm),Predictor(polluted).predict(feature,arm))

    def test_unknown_earlier_departure_uses_exact_baseline(self):
        feature=self.feature();feature['origins']={}
        r=Predictor(self.paths()).predict(feature,'fixed_mean')
        self.assertFalse(r['supported']);self.assertEqual(r['forecast'],feature['baseline'])

    def test_sparse_long_hold_does_not_invent_support(self):
        paths=self.paths()[:10]
        r=Predictor(paths).predict(self.feature(),'fixed_progress')
        self.assertFalse(r['supported']);self.assertEqual(r['forecast'],self.feature()['baseline'])

    def test_phase_evidence_discards_already_departed_histories(self):
        r=Predictor(self.paths()).predict(self.feature(),'current_suffix')
        self.assertTrue(r['supported']);self.assertEqual(r['n'],20)
        self.assertAlmostEqual(r['forecast']['eta'],300)

    def test_future_event_rejected(self):
        feature=self.feature();feature['origins']['9']['knownAt']=feature['at']+1
        with self.assertRaises(AssertionError):Predictor(self.paths()).predict(feature,'fixed_mean')

if __name__=='__main__':unittest.main()
