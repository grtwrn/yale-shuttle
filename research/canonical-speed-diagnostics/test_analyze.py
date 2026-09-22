import unittest

import analyze as a


class GeodesicFixtureTest(unittest.TestCase):
    def row(self,lat,lon,t=0,provider=1,route=9):
        return dict(lat=lat,lon=lon,collected_at=t,bus_id=provider,route_id=route)

    def test_known_equatorial_degree(self):
        self.assertAlmostEqual(a.geodesic(self.row(0,0),self.row(0,1)),111319.49079327357,places=6)

    def test_identity_symmetry_and_local_units(self):
        p=self.row(41.3,-72.9);q=self.row(41.301,-72.899)
        self.assertEqual(a.geodesic(p,p),0)
        self.assertAlmostEqual(a.geodesic(p,q),a.geodesic(q,p),places=6)
        self.assertTrue(130<a.geodesic(p,q)<150)

    def test_independent_local_geodesic_parity_grid(self):
        for lat in (41.2,41.3,41.5):
            p=self.row(lat,-72.9)
            for north,east in ((.0001,0),(0,.0001),(.001,.001),(-.001,.003),(.01,-.03)):
                q=self.row(lat+north,-72.9+east)
                self.assertLess(abs(a.d.metres(p,q)/a.geodesic(p,q)-1),.004)

    def test_milliseconds_to_seconds_and_provider_identity(self):
        p=self.row(41.3,-72.9,10000);q=self.row(41.301,-72.9,15000)
        seconds,distance,mask=a.d.edge(p,q)
        self.assertEqual(seconds,5)
        self.assertTrue(a.stable(p,q))
        self.assertFalse(a.stable(p,dict(q,bus_id=2)))
        self.assertAlmostEqual(distance/seconds,22.239,places=5)

    def test_matching_is_nearest_same_preselected_stratum_and_earlier_tie(self):
        rows=[{'collected_at':10000},{'collected_at':20000},{'collected_at':30000}]
        self.assertEqual(a.matching([0,2],[10000,30000],rows,20000),0)
        self.assertEqual(a.matching([0,2],[10000,30000],rows,25000),2)
        self.assertIsNone(a.matching([],[],rows,25000))

    def test_reversal_detects_return_not_forward_motion(self):
        p=self.row(41.3,-72.9);q=self.row(41.301,-72.9);r=self.row(41.302,-72.9)
        self.assertTrue(a.reverse(p,q,p));self.assertFalse(a.reverse(p,q,r))


if __name__=='__main__':unittest.main()
