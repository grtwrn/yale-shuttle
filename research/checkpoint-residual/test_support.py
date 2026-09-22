import unittest
from support import ceiling,date,midnight,weekend,cell,targets

class CeilingTests(unittest.TestCase):
    def journeys(self,n,dates):return {str(i):dict(sourceDate=dates[i%len(dates)]) for i in range(n)}
    def test_raw_count_is_only_a_necessary_ceiling(self):
        r=ceiling(self.journeys(12,['2026-09-10','2026-09-11','2026-09-12']))
        self.assertTrue(r['status'].startswith('not ruled'));self.assertIsNone(r['effectiveSupport']);self.assertIsNone(r['admittedResidualCount'])
    def test_missing_date_and_missing_journey_conditions(self):
        self.assertEqual(len(ceiling(self.journeys(11,['a','b']))['reasons']),2)
        self.assertEqual(len(ceiling(self.journeys(12,['a','b']))['reasons']),1)
        self.assertEqual(len(ceiling(self.journeys(11,['a','b','c']))['reasons']),1)
    def test_empty_cell_stays_explicit(self):
        r=ceiling({});self.assertEqual(r['possibleJourneys'],0);self.assertEqual(r['possibleSourceDates'],[])
    def test_midnight_source_day_is_not_forecast_day(self):
        forecast=midnight('2026-09-19')+1000;source=forecast-120000
        self.assertEqual(date(source),'2026-09-18');self.assertFalse(weekend(source));self.assertTrue(weekend(forecast))
    def test_masks_groups_and_source_daytype_are_exact(self):
        m=dict(wait=5,targetGroup=[6,7],k=5,offsets=[3,4,5],regime='pre-wait');s=dict(departed=midnight('2026-09-18'))
        base=cell(1,m,6,s)
        self.assertNotEqual(base,cell(1,dict(m,offsets=[2,3,4,5]),6,s))
        self.assertNotEqual(base,cell(1,dict(m,targetGroup=[6,7,8]),6,s))
        self.assertNotEqual(base,cell(1,m,7,s))
    def test_whole_target_group_includes_next_wait(self):
        routes={1:dict(stops=list(range(10)))}
        self.assertEqual(targets(routes,{'1':[2,5]},1,2),(3,4,5))
        self.assertEqual(targets(routes,{'1':[2]},1,2),(3,4,5,6,7,8,9,0,1))

if __name__=='__main__':unittest.main()
