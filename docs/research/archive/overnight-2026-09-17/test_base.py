import importlib.util,pathlib,tempfile,subprocess,unittest
P=pathlib.Path(__file__).with_name('team_runner.py');spec=importlib.util.spec_from_file_location('runner',P);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class Tests(unittest.TestCase):
 def test_review_bound_to_head_and_base_and_real_checks(self):
  v={'verdict':'approve','head_sha':'h','base_sha':'b','blocking_findings':[],'tests':[{'command':'npm test','exit_code':0,'result':'passed'}]}
  self.assertTrue(m.review_valid(v,'h','b'));self.assertFalse(m.review_valid(v,'changed','b'));self.assertFalse(m.review_valid(v,'h','newbase'))
  self.assertFalse(m.review_valid({**v,'tests':[]},'h','b'));self.assertFalse(m.review_valid({**v,'blocking_findings':['leakage']},'h','b'))
 def test_required_ci_must_exist_and_finish(self):
  self.assertFalse(m.checks_ready([],['gates']))
  c={'id':1,'name':'gates','status':'completed','conclusion':'success'}
  self.assertTrue(m.checks_ready([c],['gates']))
  self.assertFalse(m.checks_ready([c,{**c,'id':2,'status':'in_progress','conclusion':None}],['gates']))
  self.assertTrue(m.checks_failed([c,{**c,'id':2,'conclusion':'failure'}]))
  self.assertFalse(m.checks_ready([c,{**c,'id':2,'name':'replay','conclusion':'failure'}],['gates']))
 def test_no_secrets_or_supervisor_files_in_proposals(self):
  for p in ['services/shuttle-v2/web/src/ArriveBy.tsx','docs/new-evidence.md']:self.assertTrue(m.allowed(p))
  for p in ['.github/workflows/deploy.yml','services/shuttle-v2/.env.local','services/shuttle-v2/store/data.db','services/shuttle-v2/node_modules/x.js','services/shuttle-v2/../../key','/tmp/file','overnight-2026-09-17/team_runner.py']:self.assertFalse(m.allowed(p))
 def test_reviewer_content_changes_detected(self):
  with tempfile.TemporaryDirectory()as d:
   subprocess.run(['git','init','-q',d],check=True)
   p=pathlib.Path(d)/'file.txt';p.write_text('one')
   subprocess.run(['git','add','.'],cwd=d,check=True)
   subprocess.run(['git','-c','user.name=Test','-c','user.email=test@example.invalid','commit','-qm','init'],cwd=d,check=True)
   a=m.fingerprint(d);p.write_text('two');b=m.fingerprint(d);p.write_text('three');c=m.fingerprint(d)
   self.assertNotEqual(a,b);self.assertNotEqual(b,c)
if __name__=='__main__':unittest.main()
