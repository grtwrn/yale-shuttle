import unittest

import diagnose as d


class QualityDiagnosisTest(unittest.TestCase):
    def row(self,t=10000,**kw):
        return dict(dict(bus_name='300',bus_id=1,route_id=1,lat=41.3,lon=-72.9,collected_at=t),**kw)

    def describe(self,rows,start=10000,end=20000):
        return d.DiagnosticQuality(rows).describe('300',1,start,end)

    def test_continuous_pass_and_same_cohort(self):
        self.assertEqual(self.describe([self.row(),self.row(20000)])['reasons'],[])

    def test_boundary_tolerance_is_exact(self):
        self.assertTrue(self.describe([self.row(20000),self.row(30000)],10000,40000)['ok'])
        q=self.describe([self.row(20001),self.row(30000)],10000,40001)
        self.assertEqual(q['reasons'],['missing_end_boundary_fix','missing_start_boundary_fix'])

    def test_gap_is_distinct_from_speed(self):
        q=self.describe([self.row(),self.row(71000)],10000,71000)
        self.assertEqual(q['reasons'],['gap_over_60s'])

    def test_duplicate_identical_and_conflicting(self):
        q=self.describe([self.row(),self.row(15000),self.row(15000),self.row(20000)])
        self.assertEqual(q['reasons'],['duplicate_timestamp'])
        self.assertEqual(q['edgeCounts']['duplicate_identical_fix'],1)
        q=self.describe([self.row(),self.row(15000),self.row(15000,lon=-72.8),self.row(20000)])
        self.assertEqual(q['edgeCounts']['duplicate_conflicting_fix'],1)
        self.assertIn('speed_over_22mps',q['reasons'])

    def test_simultaneous_provider_contention_is_observation(self):
        q=self.describe([self.row(),self.row(15000),self.row(15000,bus_id=2),self.row(20000,bus_id=2)])
        self.assertEqual(q['edgeCounts']['provider_contention_same_timestamp'],1)
        self.assertEqual(q['reasons'],['duplicate_timestamp','provider_change'])

    def test_route_provider_speed_combination(self):
        q=self.describe([self.row(),self.row(20000,route_id=2,bus_id=2,lat=41.4)])
        self.assertEqual(q['reasons'],['boundary_route_mismatch','provider_change','route_change','speed_over_22mps'])

    def test_empty_and_invalid_window(self):
        self.assertEqual(self.describe([])['reasons'],['no_bus_fixes'])
        self.assertEqual(self.describe([self.row()],10000,10000)['reasons'],['nonpositive_window'])

    def test_duplicate_at_excluded_left_boundary_preserves_existing_rule(self):
        rows=[self.row(),self.row(10000),self.row(20000)]
        self.assertTrue(self.describe(rows)['ok'])


class SupportDiagnosisTest(unittest.TestCase):
    def setUp(self):
        self.routes,self.waits,self.cutoff=d.ev.ROUTES,d.ev.WAITS,d.ev.CUTOFF
        d.ev.ROUTES={1:{'id':1,'name':'Fixture','stops':[11,22,33,44]}}
        d.ev.WAITS={1:[1]}; d.ev.CUTOFF=1000000

    def tearDown(self):
        d.ev.ROUTES,d.ev.WAITS,d.ev.CUTOFF=self.routes,self.waits,self.cutoff

    def visit(self,index,arrival):
        return dict(id=arrival,bus_name='300',route_id=1,stop_id=d.ev.ROUTES[1]['stops'][index],
            stop_index=index,arrived_at=arrival,departed_at=arrival+1000,known_at=arrival+2000,
            anchored_at=arrival,outcome='stopped',how='observed',closest_m=10)

    def test_path_enumerator_exactly_matches_existing_admission(self):
        visits=[self.visit(0,10000),self.visit(1,20000),self.visit(2,30000),self.visit(3,40000)]
        rows=[QualityDiagnosisTest().row(t) for t in range(10000,50001,10000)]
        quality=d.DiagnosticQuality(rows)
        model=d.study.Models(visits,quality)
        cells=d.path_audit(visits,quality,d.ev.CUTOFF,model.paths)
        self.assertEqual(cells[1,1,1,2]['status']['accepted'],1)
        broken=[dict(r,bus_id=2 if r['collected_at']>=20000 else 1) for r in rows]
        quality=d.DiagnosticQuality(broken); model=d.study.Models(visits,quality)
        cells=d.path_audit(visits,quality,d.ev.CUTOFF,model.paths)
        self.assertEqual(cells[1,1,1,2]['qualityReasons']['provider_change'],1)

    def test_fit_count_and_material_date_gates(self):
        model=d.study.Models([],d.DiagnosticQuality([]))
        dep=d.ev.DateTs('2026-09-17T10:00:00-04:00')
        cell=(1,1,1,2)
        paths=[]
        for day in (14,15,16):
            for i in range(5):
                start=d.ev.DateTs(f'2026-09-{day}T10:00:00-04:00')+i*1000
                paths.append(dict(start=start,duration=100,weekend=False,day=f'2026-09-{day}',sourceId=day*10+i))
        model.paths[cell]=paths
        q=d.fit_support(model,*cell,dep)
        self.assertTrue(q['accepted']); self.assertEqual(q['rawSources'],15)
        model.cache={};model.paths[cell]=paths[:10]
        q=d.fit_support(model,*cell,dep)
        self.assertEqual(q['reasons'],['effective_paths_below_12','material_dates_below_3'])
        weekend=d.ev.DateTs('2026-09-19T10:00:00-04:00')
        q=d.fit_support(model,*cell,weekend)
        self.assertEqual(q['weekdayMatchingPaths'],0)


if __name__=='__main__': unittest.main()
