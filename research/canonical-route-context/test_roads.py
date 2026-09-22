import unittest
import numpy as np
import roads
import localize as l

class RoadProjectionTests(unittest.TestCase):
 def test_vectorized_matches_independent_scalar_projection(self):
  features=[dict(attributes={'ROUTE_ID':'fixture'},geometry={'paths':[[[-72.94,41.3],[-72.939,41.301],[-72.938,41.301]]]})]
  road=roads.Roads(features)
  points=[l.xy(41.3005,-72.9395),l.xy(41.3006,-72.9398),l.xy(41.302,-72.937)]
  distances,_=road.query(points)
  for p,d in zip(points,distances):
   expected=min(l.segment(p,a,b)[0] for a,b in zip(road.starts,road.ends))
   self.assertAlmostEqual(d,expected,places=8)
 def test_five_chord_samples_include_both_endpoints(self):
  a=np.asarray((0,0));b=np.asarray((100,0))
  points=[(a+(b-a)*fraction).tolist() for fraction in (0,.25,.5,.75,1)]
  self.assertEqual(points,[[0,0],[25,0],[50,0],[75,0],[100,0]])
if __name__=='__main__':unittest.main()
