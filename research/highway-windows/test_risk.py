import gzip
import json
from pathlib import Path
import tempfile
import unittest
import run_risk as r
from test_policy import FakeClause

class RiskPolicyTests(unittest.TestCase):
 def build(self,rows,policy):
  temporary=tempfile.TemporaryDirectory();self.addCleanup(temporary.cleanup)
  path=Path(temporary.name)/'raw.jsonl.gz'
  with gzip.open(path,'wt') as f:
   for row in rows:f.write(json.dumps(row)+'\n')
  clause=FakeClause();clause.prepare=lambda pairs:None
  kind=r.connectivity_factory(policy,clause,[])
  return kind(path,{'#1'})
 def row(self,t,metres=0,provider=1):
  return dict(bus_name='#1',bus_id=provider,route_id=9,collected_at=t,lat=metres/111195,lon=0)
 def test_same_clause_without_changing_bracketing(self):
  rows=[self.row(10000),self.row(15000,150),self.row(20000,150)]
  self.assertIsNotNone(self.build(rows,'original22').reason('#1',9,10000,20000))
  highway=self.build(rows,'highway25')
  self.assertIsNone(highway.reason('#1',9,10000,20000))
  self.assertEqual(highway.reason('#1',9,9000,20000),'raw-does-not-bracket-arm-and-departure')
  self.assertEqual(highway.reason('#1',9,10000,21000),'raw-does-not-bracket-arm-and-departure')
 def test_identical_overlap_dedup_and_conflicting_boundary_are_preserved(self):
  rows=[self.row(10000),self.row(10000),self.row(15000,150)]
  self.assertIsNone(self.build(rows,'highway25').reason('#1',9,10000,15000))
  rows[1]=self.row(10000,1)
  self.assertIsNotNone(self.build(rows,'highway25').reason('#1',9,10000,15000))
 def test_provider_change_never_rescued(self):
  rows=[self.row(10000),self.row(15000,150),self.row(20000,151,provider=2)]
  self.assertIsNotNone(self.build(rows,'highway50').reason('#1',9,10000,20000))
if __name__=='__main__':unittest.main()
