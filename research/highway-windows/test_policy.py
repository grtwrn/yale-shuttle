import unittest
from unittest.mock import patch
import math
import policy as p


class ClauseTests(unittest.TestCase):
    def pair(self,speed=30,sec=5,route=9,provider=1):
        a=dict(bus_name='#1',bus_id=provider,route_id=route,collected_at=10000,lat=0,lon=0)
        b=dict(a,collected_at=10000+sec*1000,lat=speed*sec/111195)
        return a,b

    def test_speed_boundaries_are_inclusive_and_preserve_original(self):
        context=dict(maxRoadM=0,maxDeclaredRouteM=0)
        for speed,expected in ((22,False),(22.01,True),(35,True),(35.01,False)):
            a,b=self.pair(speed)
            with patch.object(p.diag,'edge',return_value=(5,speed*5,4)):
                self.assertEqual(p.clause_decision(a,b,'highway25',context),expected)
                self.assertFalse(p.clause_decision(a,b,'original22',context))

    def test_primary_sensitivity_and_declared_route_boundaries(self):
        a,b=self.pair()
        self.assertTrue(p.clause_decision(a,b,'highway25',dict(maxRoadM=25,maxDeclaredRouteM=75)))
        self.assertFalse(p.clause_decision(a,b,'highway25',dict(maxRoadM=25.001,maxDeclaredRouteM=75)))
        self.assertTrue(p.clause_decision(a,b,'highway50',dict(maxRoadM=50,maxDeclaredRouteM=75)))
        self.assertFalse(p.clause_decision(a,b,'highway50',dict(maxRoadM=50.001,maxDeclaredRouteM=75)))
        self.assertFalse(p.clause_decision(a,b,'highway50',dict(maxRoadM=0,maxDeclaredRouteM=75.001)))

    def test_other_routes_provider_route_and_duplicate_time_not_rescued(self):
        context=dict(maxRoadM=0,maxDeclaredRouteM=0)
        for route in (1,2,3,8,13,18):
            self.assertFalse(p.clause_decision(*self.pair(route=route),'highway25',context))
        a,b=self.pair()
        for change in (dict(bus_id=2),dict(bus_id=None),dict(route_id=10),dict(collected_at=a['collected_at'])):
            self.assertFalse(p.clause_decision(a,dict(b,**change),'highway25',context))
        self.assertFalse(p.clause_decision(*self.pair(provider=None),'highway25',context))

    def test_gap_and_extreme_collection_burst_remain_rejected(self):
        context=dict(maxRoadM=0,maxDeclaredRouteM=0)
        self.assertFalse(p.clause_decision(*self.pair(sec=61),'highway50',context))
        self.assertFalse(p.clause_decision(*self.pair(speed=172.36,sec=.407),'highway50',context))
        self.assertFalse(p.clause_decision(*self.pair(speed=231.67,sec=.407),'highway50',context))

    def test_projection_independent_scalar_distance(self):
        projection=p.Projection([[(41.3,-72.94),(41.301,-72.939)]])
        a,b=p.xy(41.3,-72.94),p.xy(41.301,-72.939)
        point=p.xy(41.301,-72.94);delta=(b[0]-a[0],b[1]-a[1])
        t=max(0,min(1,sum((point[i]-a[i])*delta[i] for i in (0,1))/sum(x*x for x in delta)))
        expected=math.hypot(*(point[i]-a[i]-t*delta[i] for i in (0,1)))
        self.assertAlmostEqual(projection.distances([point])[0],expected,places=8)
        self.assertEqual(p.Projection([]).distances([point]),[math.inf])

    def test_quarter_points_cannot_be_replaced_with_endpoint_only_check(self):
        # A straight GPS chord cuts across a U-shaped road; endpoint proximity
        # alone would pass. The five fixed samples detect the middle mismatch.
        route=p.Projection([[(41.3,-72.94),(41.301,-72.94),(41.301,-72.939),(41.3,-72.939)]])
        a,b=p.xy(41.3,-72.94),p.xy(41.3,-72.939)
        pts=[tuple(a[i]+(b[i]-a[i])*f for i in (0,1)) for f in (0,.25,.5,.75,1)]
        distances=route.distances(pts)
        self.assertAlmostEqual(distances[0],0);self.assertAlmostEqual(distances[-1],0)
        self.assertGreater(max(distances),25)


class FakeClause:
    def __init__(self):self.cache={}
    def permitted(self,a,b,policy):
        allowed=policy!='original22' and p.eligible_pair(a,b)
        if allowed:self.cache[p.edge_key(a,b)]={'maxRoadM':0,'maxDeclaredRouteM':0}
        return allowed


class QualityTests(unittest.TestCase):
    def row(self,t,metres=0,route=9,provider=1):
        return dict(bus_name='#1',bus_id=provider,route_id=route,collected_at=t,lat=metres/111195,lon=0)

    def test_original22_exact_and_highway_only_removes_speed(self):
        rows=[self.row(10000),self.row(15000,150)]
        base=p.rr.TrainingQuality(rows);old=p.Quality(rows,'original22',FakeClause());new=p.Quality(rows,'highway25',FakeClause())
        self.assertEqual(base.ok('#1',9,10000,15000),old.ok('#1',9,10000,15000))
        self.assertFalse(old.ok('#1',9,10000,15000));self.assertTrue(new.ok('#1',9,10000,15000))
        self.assertEqual(len(new.promoted),1)

    def test_other_condition_in_same_interval_still_rejects(self):
        rows=[self.row(10000),self.row(15000,150),self.row(80000,160)]
        quality=p.Quality(rows,'highway25',FakeClause())
        self.assertFalse(quality.ok('#1',9,10000,80000))
        self.assertEqual(quality.counts['allowedEdgePresentButOtherConditionRejects'],1)

    def test_boundary_and_timestamp_semantics_unchanged(self):
        rows=[self.row(20001),self.row(25001,150)]
        quality=p.Quality(rows,'highway25',FakeClause())
        self.assertFalse(quality.ok('#1',9,10000,25001))
        rows=[self.row(10000),self.row(12000),self.row(12000),self.row(17000,150)]
        self.assertFalse(p.Quality(rows,'highway25',FakeClause()).ok('#1',9,10000,17000))

    def test_training_cutoff_must_physically_exclude_later_raw(self):
        with self.assertRaises(AssertionError):p.Quality([self.row(10000)],'highway25',FakeClause(),10000)

    def test_future_deletion_preserves_completed_interval(self):
        rows=[self.row(10000),self.row(15000,150),self.row(20000,9000,provider=2)]
        full=p.Quality(rows,'highway25',FakeClause());prefix=p.Quality(rows[:2],'highway25',FakeClause())
        self.assertEqual(full.ok('#1',9,10000,15000),prefix.ok('#1',9,10000,15000))
        self.assertTrue(prefix.ok('#1',9,10000,15000))


if __name__=='__main__':unittest.main()
