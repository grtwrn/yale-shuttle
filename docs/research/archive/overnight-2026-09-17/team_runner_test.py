"""Independent adversarial runner tests. Never invoke Codex, GitHub or Fly."""
import argparse
import importlib.util
import io
import json
import pathlib
import subprocess
import tempfile
import time
import unittest
from unittest.mock import patch

HERE=pathlib.Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('reviewed_team_runner',HERE/'team_runner.py')
runner=importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)
HEAD='a'*40
BASE='b'*40
MERGE='c'*40

class PublicationBoundaries(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory()
  self.root=pathlib.Path(self.tmp.name)
  self.root_patch=patch.object(runner,'ROOT',self.root);self.root_patch.start()
  self.stop_patch=patch.object(runner,'STOP',False);self.stop_patch.start()
  self.team=runner.Team(argparse.Namespace(team='eta',repo=str(self.root/'repo'),until='2099-09-18T11:30:00+00:00',builder_seconds=1,reviewer_seconds=1))
  self.team.state['builder']={'summary':'Fix the rider forecast'}
  self.calls=[]
  self.after_checks=lambda:None
  self.remote_base=BASE
  self.checks=[{'id':1,'name':'gates','status':'completed','conclusion':'success'}]
  self.verdict={'verdict':'approve','head_sha':HEAD,'base_sha':BASE,'blocking_findings':[],'summary':'Reviewed exact candidate','tests':[{'command':'npm test','exit_code':0,'result':'passed'}]}
 def tearDown(self):
  self.stop_patch.stop();self.root_patch.stop();self.tmp.cleanup()
 def api(self,path,method='GET',data=None):
  self.calls.append((path,method,data))
  pr={'number':1,'html_url':'https://example.invalid/pr/1','state':'open','head':{'sha':HEAD},'base':{'sha':BASE}}
  if path=='commits/master':return {'sha':self.remote_base}
  if path.startswith('pulls?'):return []
  if path=='pulls' and method=='POST':return pr
  if path=='pulls/1':return pr
  if path.endswith('/check-runs?per_page=100'):return {'total_count':len(self.checks),'check_runs':self.checks}
  if path=='pulls/1/reviews?per_page=100':self.after_checks();return []
  if path=='pulls/1/merge':return {'merged':True,'sha':MERGE}
  raise AssertionError((path,method,data))
 def git(self,repo,*args):
  if args==('rev-parse','HEAD'):return HEAD
  if args==('branch','--show-current'):return 'overnight/eta-20260917-001'
  raise AssertionError(args)
 def command(self,argv,**kwargs):
  if list(argv[:3])==['gh','api','graphql']:
   return json.dumps({'data':{'repository':{'pullRequest':{'reviewThreads':{'pageInfo':{'hasNextPage':False},'nodes':[]}}}}})
  if list(argv[:2])==['git','push']:return ''
  raise AssertionError(argv)
 def publish(self):
  with patch.object(runner,'api',self.api),patch.object(runner,'git',self.git),patch.object(runner,'run',self.command),patch.object(runner,'changed',return_value=[]),patch.object(runner,'required_checks',return_value=['gates']),patch.object(self.team,'verify_deploy',return_value={'ok':True}):
   self.team.publish(BASE,HEAD,self.verdict,['services/shuttle-v2/web/src/ArrivalPlot.tsx'])
 def merges(self):return [c for c in self.calls if c[0].endswith('/merge')]
 def assert_publication_refused(self):
  refused=False
  try:self.publish()
  except (runner.StopNight,runner.Deferred):refused=True
  self.assertEqual(self.merges(),[],'No irreversible merge is allowed after the boundary changes')
  self.assertTrue(refused,'Unsafe publication must be reported as deferred/stopped')
 def test_stop_received_after_ci_prevents_merge(self):
  self.after_checks=lambda:setattr(runner,'STOP',True)
  self.assert_publication_refused()
 def test_deadline_crossed_after_ci_prevents_merge(self):
  self.after_checks=lambda:setattr(self.team,'until',time.time()-1)
  self.assert_publication_refused()
 def test_remote_base_change_after_ci_prevents_merge(self):
  self.after_checks=lambda:setattr(self,'remote_base','d'*40)
  self.assert_publication_refused()
 def test_failed_required_check_prevents_merge(self):
  self.checks[0]['conclusion']='failure'
  self.assert_publication_refused()
 def test_missing_exact_review_head_prevents_any_remote_mutation(self):
  self.verdict['head_sha']='d'*40
  self.assert_publication_refused()
  self.assertEqual(self.calls,[])
 def test_required_ci_cannot_be_satisfied_by_skipped(self):
  self.assertFalse(runner.checks_ready([{'name':'gates','id':2,'status':'completed','conclusion':'skipped'}],['gates']))
  self.assertFalse(runner.checks_ready([],['gates']))
 def test_latest_run_supersedes_older_failed_attempt(self):
  c=[{'name':'gates','id':1,'status':'completed','conclusion':'failure'},{'name':'gates','id':2,'status':'completed','conclusion':'success'}]
  self.assertTrue(runner.checks_ready(c,['gates']))
  self.assertFalse(runner.checks_failed(c))

class CheckoutBoundaries(unittest.TestCase):
 def test_scope_rejects_secrets_databases_parent_traversal_and_pipeline(self):
  for path in ['../services/shuttle-v2/x.ts','/services/shuttle-v2/x.ts','services/shuttle-v2/.env','services/shuttle-v2/store/source.json','services/shuttle-v2/source.db','docs/key.pem','.github/workflows/deploy.yml']:
   with self.subTest(path=path):self.assertFalse(runner.allowed(path))
 def test_fingerprint_detects_edits_when_status_letter_is_unchanged(self):
  with tempfile.TemporaryDirectory()as tmp:
   repo=pathlib.Path(tmp)
   def git(*args):return subprocess.run(['git','-c','core.hooksPath=/dev/null',*args],cwd=repo,check=True,capture_output=True,text=True).stdout
   git('init','-q');p=repo/'app.txt';p.write_text('initial\n');git('add','app.txt');git('-c','user.name=Runner Test','-c','user.email=runner@example.invalid','commit','-qm','fixture')
   p.write_text('builder\n');status=git('status','--porcelain');before=runner.fingerprint(repo)
   p.write_text('reviewer\n')
   self.assertEqual(status,git('status','--porcelain'))
   self.assertNotEqual(before,runner.fingerprint(repo))
 def test_fingerprint_detects_untracked_content_changes(self):
  with tempfile.TemporaryDirectory()as tmp:
   repo=pathlib.Path(tmp)
   def git(*args):return subprocess.run(['git','-c','core.hooksPath=/dev/null',*args],cwd=repo,check=True,capture_output=True,text=True).stdout
   git('init','-q');git('-c','user.name=Runner Test','-c','user.email=runner@example.invalid','commit','--allow-empty','-qm','fixture')
   p=repo/'new.ts';p.write_text('first');before=runner.fingerprint(repo);p.write_text('second')
   self.assertNotEqual(before,runner.fingerprint(repo))

class RecoveryBoundaries(unittest.TestCase):
 setUp=PublicationBoundaries.setUp
 tearDown=PublicationBoundaries.tearDown
 def pending(self,**overrides):
  record={'at':'2026-09-18T02:00:00Z','team':'ux','pr':42,'head':HEAD,'base':BASE,'has_app':True,'stage':'merge_rpc'}
  record.update(overrides);runner.save(self.root/'PENDING-PUBLICATION.json',record)
  return record
 def merged(self,**overrides):
  pr={'number':42,'merged':True,'state':'closed','merge_commit_sha':MERGE,'html_url':'https://example.invalid/pr/42','head':{'sha':HEAD}}
  pr.update(overrides);return pr
 def test_other_team_reconciles_missing_merge_rpc_response_before_publication(self):
  self.pending()
  with patch.object(runner,'api',return_value=self.merged()),patch.object(self.team,'verify_deploy',return_value={'ok':True,'build':MERGE[:12]})as verify:
   with self.team.acquire('publication.lock'):self.team.reconcile_publication()
  verify.assert_called_once_with(42,MERGE,True,stateful=False)
  self.assertFalse((self.root/'PENDING-PUBLICATION.json').exists())
  record=json.loads((self.root/'verified-publication-42.json').read_text())
  self.assertEqual(record['team'],'ux')
  self.assertEqual(record['merge'],MERGE)
  self.assertIsNone(self.team.state.get('pr'),'Recovering the other team must not overwrite own PR state')
 def test_ambiguous_rpc_preserves_pending_record_and_halts(self):
  self.pending()
  with patch.object(runner,'api',return_value={'number':42,'merged':False,'state':'open','head':{'sha':HEAD}}),patch.object(self.team,'verify_deploy')as verify:
   with self.assertRaises(runner.Deferred):self.team.reconcile_publication()
  self.assertTrue((self.root/'PENDING-PUBLICATION.json').exists())
  self.assertTrue((self.root/'PUBLICATION-HALTED.json').exists())
  verify.assert_not_called()
 def test_recovery_cannot_accept_a_different_merged_head(self):
  self.pending()
  with patch.object(runner,'api',return_value=self.merged(head={'sha':'d'*40})),patch.object(self.team,'verify_deploy')as verify:
   with self.assertRaises(runner.Deferred):self.team.reconcile_publication()
  verify.assert_not_called()
  self.assertFalse((self.root/'verified-publication-42.json').exists())
 def test_recovery_cannot_accept_a_different_acknowledged_merge(self):
  self.pending(stage='deploy',merge='d'*40)
  with patch.object(runner,'api',return_value=self.merged()),patch.object(self.team,'verify_deploy')as verify:
   with self.assertRaises(runner.Deferred):self.team.reconcile_publication()
  verify.assert_not_called()
  self.assertFalse((self.root/'verified-publication-42.json').exists())
 def test_terminal_failed_deploy_does_not_trap_own_team_before_builder(self):
  self.pending(stage='deploy',merge=MERGE)
  def failed(*args,**kwargs):
   runner.save(self.root/'PUBLICATION-HALTED.json',{'reason':'deployment failed','merge':MERGE})
   raise runner.Deferred('deployment failed')
  with patch.object(runner,'api',return_value=self.merged()),patch.object(self.team,'verify_deploy',side_effect=failed):
   with self.assertRaises(runner.Deferred):self.team.reconcile_publication()
  self.assertFalse((self.root/'PENDING-PUBLICATION.json').exists())
  self.team.state['pr']=42
  with patch.object(runner,'api',return_value=self.merged()),patch.object(self.team,'verify_deploy')as verify:self.team.reconcile()
  verify.assert_not_called()
  self.assertIsNone(self.team.state['pr'])
  self.assertEqual(self.team.state['phase'],'round_complete')
 def test_interrupted_new_branch_preparation_resumes_without_deleting_work(self):
  repo=self.team.repo;repo.mkdir()
  def git(*args):return subprocess.run(['git','-c','core.hooksPath=/dev/null',*args],cwd=repo,check=True,capture_output=True,text=True).stdout.strip()
  git('init','-q','-b','master');git('-c','user.name=Runner Test','-c','user.email=runner@example.invalid','commit','--allow-empty','-qm','fixture')
  git('remote','add','origin',str(repo))  # Local fixture only; no network or credentials.
  base=git('rev-parse','HEAD')
  self.team.status(round=0,phase='round_complete',base=base)
  runner.save(self.team.dir/'bootstrap-ready.json',{})
  status=self.team.status
  class ProcessInterrupted(BaseException):pass
  class BuilderReached(BaseException):pass
  def interrupted_status(**kw):
   if kw.get('phase')=='builder' and git('branch','--show-current').startswith('overnight/eta-'):
    raise ProcessInterrupted('process died after checkout, before builder status save')
   return status(**kw)
  with patch.object(self.team,'status',side_effect=interrupted_status),patch.object(self.team,'build',side_effect=AssertionError('first builder must not start')):
   with self.assertRaises(ProcessInterrupted):self.team.cycle()
  branch=git('branch','--show-current')
  resumed=runner.Team(self.team.a)
  with patch.object(resumed,'build',side_effect=BuilderReached('recovered expected branch')):
   with self.assertRaises(BuilderReached):resumed.cycle()
  self.assertEqual(git('branch','--show-current'),branch)
  self.assertEqual(git('rev-parse','HEAD'),base)

class MemoryBoundaries(unittest.TestCase):
 setUp=PublicationBoundaries.setUp
 tearDown=PublicationBoundaries.tearDown
 class Process:
  def __init__(self,refuse_term=False):
   self.pid=99999999;self.stdin=io.StringIO();self.returncode=None;self.refuse_term=refuse_term;self.waits=[]
  def poll(self):return self.returncode
  def wait(self,timeout=None):
   self.waits.append(timeout)
   if self.refuse_term and timeout is not None:raise subprocess.TimeoutExpired('fake model',timeout)
   self.returncode=-9 if self.refuse_term else -15
   return self.returncode
 def test_memory_threshold_uses_available_not_free_or_total(self):
  for available,expected in [(768*1024-1,True),(768*1024,False),(1024*1024,False)]:
   with self.subTest(available=available),patch.object(pathlib.Path,'read_text',return_value=f'MemTotal: 8000000 kB\nMemFree: 100 kB\nMemAvailable: {available} kB\n'):
    self.assertEqual(runner.low_memory(),expected)
  with patch.object(pathlib.Path,'read_text',return_value='MemTotal: 8000000 kB\n'):
   with self.assertRaises(runner.Deferred):runner.low_memory()
 def test_low_memory_prevents_spawn_and_recovered_memory_allows_resume(self):
  with patch.object(runner,'low_memory',return_value=True),patch.object(runner.subprocess,'Popen')as spawn:
   with self.assertRaisesRegex(runner.Deferred,'768 MiB'):self.team.model('builder','fixture',30,runner.BUILD_SCHEMA)
  spawn.assert_not_called()
  result={'outcome':'research','summary':'Preserved work resumed','next_task':'review','tests':[]}
  def completed(argv,**kwargs):
   pathlib.Path(argv[argv.index('-o')+1]).write_text(json.dumps(result))
   p=self.Process();p.returncode=0;return p
  with patch.object(runner,'low_memory',return_value=False),patch.object(runner.subprocess,'Popen',side_effect=completed):
   self.assertEqual(self.team.model('builder','fixture',30,runner.BUILD_SCHEMA),result)
  self.assertIsNone(runner.ACTIVE)
 def test_pressure_during_model_escalates_to_kill_and_preserves_work(self):
  p=self.Process(refuse_term=True)
  artifact=self.team.dir/'CHECKPOINT.md';artifact.write_text('keep this work')
  with patch.object(runner,'low_memory',side_effect=[False,True]),patch.object(runner.subprocess,'Popen',return_value=p),patch.object(runner.os,'killpg')as kill:
   with self.assertRaisesRegex(runner.Deferred,'low available memory'):self.team.model('builder','fixture',30,runner.BUILD_SCHEMA)
  self.assertEqual([c.args for c in kill.call_args_list],[(p.pid,runner.signal.SIGTERM),(p.pid,runner.signal.SIGKILL)])
  self.assertEqual(p.waits,[15,None])
  self.assertEqual(artifact.read_text(),'keep this work')
  self.assertIsNone(runner.ACTIVE)
  self.assertIsNone(self.team.state['model_pid'])
 def test_monitor_read_failure_cleans_up_before_forgetting_active_model(self):
  p=self.Process()
  with patch.object(runner,'low_memory',side_effect=[False,runner.Deferred('Cannot verify available memory')]),patch.object(runner.subprocess,'Popen',return_value=p),patch.object(runner.os,'killpg')as kill:
   with self.assertRaisesRegex(runner.Deferred,'Cannot verify available memory'):self.team.model('builder','fixture',30,runner.BUILD_SCHEMA)
  kill.assert_called_once_with(p.pid,runner.signal.SIGTERM)
  self.assertEqual(p.waits,[15])
  self.assertIsNotNone(p.returncode,'The controller must reap the model before retrying')
  self.assertIsNone(runner.ACTIVE)

if __name__=='__main__':unittest.main()
