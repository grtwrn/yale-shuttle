import unittest
import localize as l

class ProjectionTests(unittest.TestCase):
 def test_inside_segment_and_clamped_endpoint(self):
  self.assertEqual(l.segment((5,3),(0,0),(10,0))[0],3)
  self.assertEqual(l.segment((13,4),(0,0),(10,0))[0],5)
 def test_repeated_directions_are_preserved(self):
  a=dict(lat=41.3,lon=-72.94);b=dict(lat=41.3,lon=-72.939)
  start,end=l.xy(a['lat'],a['lon']),l.xy(b['lat'],b['lon'])
  result=l.locate(a,b,[(2,start,end),(9,end,start)])
  self.assertEqual({x['index'] for x in result['candidates']},{2,9})
  self.assertEqual({x['directionCos'] for x in result['candidates']},{-1,1})
 def test_missing_geometry_stays_unavailable(self):
  self.assertIsNone(l.locate(dict(lat=41.3,lon=-72.9),dict(lat=41.3,lon=-72.89),[])['bestDistanceM'])
if __name__=='__main__':unittest.main()
