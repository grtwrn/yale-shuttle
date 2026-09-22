import ast
import contextlib
import gzip
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import contract as c
import inputs as inp
import controller as ctl
from generate import replay_source,build_source,cutoffs
from publish import validate_catalog
from sealing import verify_implementation
from resource_guard import run

class Fixtures(unittest.TestCase):
    def setUp(self):
        c.require(os.environ.get('GITHUB_ACTIONS')=='true','fixtures hosted only')
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name)
        self.day='2026-09-22';self.start=c.day_start(self.day);self.at=self.start+28*3600000
    def tearDown(self):self.temp.cleanup()
    def row(self,**kw):return dict(bus_id=1,bus_name='#1',route_id=19,lat=41.3,lon=-72.9,heading=None,last_stop_id=None,collected_at=self.start+1,**kw)
    def archive(self,rows=None):
        rows=[self.row()] if rows is None else rows
        root=self.root/'archive'/self.day;folder=root/'snapshots/one';folder.mkdir(parents=True)
        raw=b''.join(c.canonical(r)+b'\n' for r in rows);compressed=gzip.compress(raw,mtime=0)
        (folder/'raw_positions.jsonl.gz').write_bytes(compressed)
        t=dict(file='snapshots/one/raw_positions.jsonl.gz',rows=len(rows),complete=True,source='server',capturedAt=c.utc(self.start+27*3600000),
            build='synthetic',columns=c.COLS,bytes=len(compressed),rawBytes=len(raw),sha256=c.sha(compressed))
        m=dict(version=2,day=self.day,**{'from':self.start,'to':self.start+86400000},tables={'raw_positions':t},
            positions=dict(server=len(rows),merged=len(rows),capture=0),ok=False)
        c.write_json(root/'manifest.json',m);c.write_json(folder/'manifest.json',m)
        archiver=self.root/'archive-day.mjs';archiver.write_text('// synthetic trusted archiver fixture')
        return root,m,archiver
    @contextlib.contextmanager
    def packaged(self,rows=None):
        root,m,archiver=self.archive(rows)
        with patch.object(inp,'ARCHIVER_SHA',c.file_sha(archiver)),patch.object(inp,'now_ms',return_value=self.at):
            dest=self.root/'package';record=inp.package(root.parent,self.day,dest,self.at,archiver)
            yield dest,record,m

    def test_all_fixed_dates_embargo_context_and_forbidden_overrides(self):
        for day in range(24,31):
            x=c.schedule(f'2026-09-{day}');self.assertEqual(x['trainBefore'],c.day_start(f'2026-09-{day-1}'))
            self.assertEqual(x['rawDays'][-1],f'2026-09-{day-2}');self.assertEqual(x['contextOnly'],day==30)
            self.assertEqual(x['validUntil']-x['validFrom'],1800000 if day==30 else 86400000)
        for day in ('2026-09-23','2026-10-01','2027-09-24'):
            with self.assertRaises(c.InputError):c.schedule(day)
    def test_due_policy_has_real_year_dates_and_persistent_clock(self):
        self.assertIsNone(ctl.due_day(c.day_start('2026-09-23')+4*3600000))
        self.assertEqual(ctl.due_day(c.day_start('2026-09-23')+5*3600000),'2026-09-24')
        self.assertEqual(ctl.due_day(c.day_start('2026-09-29')+10*3600000),'2026-09-30')
        self.assertIsNone(ctl.due_day(c.day_start('2026-09-30')+5*3600000))
    def test_metadata_is_raw_specific_and_never_decompresses(self):
        root,m,_=self.archive()
        with patch('gzip.open',side_effect=AssertionError('no local body decode')):
            x=c.selected_archive(root.parent,self.day,self.at)
            self.assertEqual(x['table']['rows'],1);self.assertFalse(x['manifest']['ok'])
    def test_exact_normalized_rows_and_valid_empty_export(self):
        with self.packaged() as (p,r,m):self.assertEqual(list(inp.iter_rows(p,r['packageSha256'],self.at)),[self.row()])
        self.temp.cleanup();self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name)
        with self.packaged([]) as (p,r,m):self.assertEqual(list(inp.iter_rows(p,r['packageSha256'],self.at)),[])
    def test_package_selection_does_not_follow_later_root_manifest(self):
        with self.packaged() as (p,r,m):
            c.write_json(self.root/'archive'/self.day/'manifest.json',{'changed':True})
            self.assertEqual(list(inp.iter_rows(p,r['packageSha256'],self.at)),[self.row()])
            with self.assertRaises(c.InputError):inp.package(self.root/'archive',self.day,p,self.at)
    def test_transport_retention_future_and_provenance_refuse(self):
        root,m,_=self.archive()
        for key,value in [('complete',False),('capturedAt',c.utc(self.start+36*3600000)),('capturedAt',c.utc(self.at+1)),('source','capture'),('integrityError','bad')]:
            changed=json.loads(json.dumps(m));changed['tables']['raw_positions'][key]=value
            c.write_json(root/'manifest.json',changed)
            with self.assertRaises(c.InputError):c.selected_archive(root.parent,self.day,self.at)
        c.write_json(root/'manifest.json',m)
        with self.assertRaises(c.InputError):c.selected_archive(root.parent,self.day,self.start+1)
    def test_capture_overlap_requires_no_capture_only_keys(self):
        root,m,_=self.archive();m['tables']['raw_positions']['source']='server+capture';m['positions']['capture']=1
        c.write_json(root/'manifest.json',m);c.write_json(root/'snapshots/one/manifest.json',m)
        self.assertEqual(c.selected_archive(root.parent,self.day,self.at)['table']['rows'],1)
        m['positions']['server']=0;c.write_json(root/'manifest.json',m)
        with self.assertRaises(c.InputError):c.selected_archive(root.parent,self.day,self.at)
    def test_duplicate_conflict_schema_day_order_and_nonfinite(self):
        cases=[[self.row(),self.row()], [dict(self.row(),collected_at=self.start+86400000)],
               [dict(self.row(),id=123)], [dict(self.row(),bus_id=True)],
               [dict(self.row(),lat=999)], [dict(self.row(),collected_at=self.start+2),self.row()]]
        for rows in cases:
            with self.subTest(rows=rows):
                with tempfile.TemporaryDirectory() as d:
                    prior=self.root;self.root=Path(d)
                    with self.packaged(rows) as (p,r,m):
                        with self.assertRaises(c.InputError):list(inp.iter_rows(p,r['packageSha256'],self.at))
                    self.root=prior
        for raw in (b'{"a":1,"a":2}',b'{"a":1e999}',b'{"a":NaN}'):
            with self.assertRaises(c.InputError):c.strict_json(raw)
    def test_tampering_truncation_and_row_byte_counts(self):
        with self.packaged() as (p,r,m):
            f=p/'raw_positions.jsonl.gz';f.write_bytes(f.read_bytes()[:-2])
            with self.assertRaises(c.InputError):list(inp.iter_rows(p,r['packageSha256'],self.at))
    def test_hosted_boundary_rejects_local_decode(self):
        with patch.dict(os.environ,{},clear=True):
            with self.assertRaises(c.InputError):list(inp.iter_rows('unused','unused',self.at))
    def test_missing_file_and_symlink_never_create_empty_rows(self):
        root,m,_=self.archive();f=root/m['tables']['raw_positions']['file'];f.unlink();f.symlink_to('/dev/null')
        with self.assertRaises(c.InputError):c.selected_archive(root.parent,self.day,self.at)
        with self.assertRaises(c.InputError):c.safe_file(root,'../escape')
    def test_original_scientific_functions_are_exact_in_daily_generation(self):
        original=ast.parse((c.ROOT/'research/brown-rolling-seal/build.py').read_text())
        names={'read','write','write_prefix','pools','physical','evidence','audit_provider_rows'}
        original_functions={n.name:ast.dump(n) for n in original.body if isinstance(n,ast.FunctionDef) and n.name in names}
        for day in ('2026-09-24','2026-09-30'):
            config=c.schedule(day);generated=build_source(config,['research/brown-model-seal/runtime.py']);tree=ast.parse(generated)
            self.assertEqual(original_functions,{n.name:ast.dump(n) for n in tree.body if isinstance(n,ast.FunctionDef) and n.name in names})
            self.assertIn('range(1790136000000, 1790136000000+7*86400000+1, 3600000)',generated)
            self.assertIn('END = '+str(config['validUntil']),generated)
            self.assertIn(str(config['trainBefore']),replay_source(config))
            self.assertEqual(len(cutoffs(config)),5)
        self.assertEqual(len(cutoffs(c.schedule('2026-09-23',fixture=True))),3)
    def test_first_success_pending_and_scientific_states(self):
        state=dict(days={},selections={});self.assertEqual(ctl.may_attempt(state,'2026-09-24'),'attempt')
        for status in ('available','available_late','expired'):
            state['days']['2026-09-24']={'status':status};self.assertEqual(ctl.may_attempt(state,'2026-09-24'),'already_sealed')
        state['days']['2026-09-24']={'status':'scientific_halt'}
        with self.assertRaises(c.InputError):ctl.may_attempt(state,'2026-09-24')
        state['days']['2026-09-24']={'status':'running'}
        with self.assertRaises(c.InputError):ctl.may_attempt(state,'2026-09-25')
        state['days']['2026-09-24']={'status':'operational_failure'};self.assertEqual(ctl.may_attempt(state,'2026-09-24'),'attempt')
    def test_publish_fake_controller_commit_push_and_no_refit(self):
        repo=self.root/'repo';here=repo/'research/brown-daily-seals';here.mkdir(parents=True)
        (here/'IMPLEMENTATION.json').write_text('{}')
        state=dict(schema=1,days={},selections={});calls=[]
        args=SimpleNamespace(forecast_day='2026-09-24',archive_root=str(self.root/'unused'),implementation='a'*40,
            request_branch=ctl.BRANCH,state_root=str(self.root/'state'))
        def fake_package(archive,day,dest,at):
            dest.mkdir(parents=True);c.write_json(dest/'package.json',{'fixture':True});return dict(day=day,packageSha256=c.file_sha(dest/'package.json'))
        with patch.object(ctl,'ROOT',repo),patch.object(ctl,'HERE',here),patch.object(ctl,'verify_code'),patch.object(ctl,'verify_package'), \
             patch.object(ctl,'package',side_effect=fake_package),patch.object(ctl,'command',return_value='b'*40), \
             patch.object(ctl,'now_ms',return_value=self.at+7),patch.object(ctl.subprocess,'run',side_effect=lambda *a,**k:calls.append(a[0])):
            first=ctl.publish_day(args,state,self.at)
            self.assertEqual(first['requestCommit'],'b'*40);self.assertEqual(first['createdAt'],self.at+7)
            self.assertEqual([x[:2] for x in calls],[['git','add'],['git','commit'],['git','push']])
            request=c.strict_json((repo/first['requestPath']).read_bytes());self.assertEqual([x['day'] for x in request['inputs']],['2026-09-22'])
            self.assertEqual(c.file_sha(repo/first['requestPath']),first['requestSha256'])
            with self.assertRaises(c.InputError):ctl.publish_day(args,state,self.at+1)
            state['days'][args.forecast_day]['status']='available';self.assertEqual(ctl.publish_day(args,state,c.day_start('2026-10-01'))['status'],'already_sealed')
            self.assertEqual(len(calls),3)
    def test_missing_admission_remains_queued_without_second_push(self):
        state=dict(schema=1,selections={},days={'2026-09-24':dict(status='queued',requestCommit='a'*40)})
        args=SimpleNamespace(state_root=str(self.root/'state'))
        with patch.object(ctl,'api',return_value={'workflow_runs':[]}):
            self.assertEqual(ctl.reconcile(args,state,self.at)['days']['2026-09-24']['status'],'queued')
        with self.assertRaises(c.InputError):ctl.may_attempt(state,'2026-09-24')
    def test_reconcile_acceptance_uses_receipt_clock_and_preserves_catalog_after_crash(self):
        config=c.schedule('2026-09-24');start=config['validFrom'];repo=self.root/'repo';repo.mkdir()
        request={'day':config['day'],'requestId':'id','createdAt':config['trainBefore']+1};c.write_json(repo/'request.json',request)
        entry=dict(day=config['day'],status='running',requestCommit='a'*40,requestId='id',requestPath='request.json',requestSha256=c.file_sha(repo/'request.json'))
        run=dict(id=2,name=ctl.WORKFLOW,head_sha='a'*40,run_attempt=1,status='completed',conclusion='success')
        catalog=dict(status='sealed_pending_publish',requestId='id',requestSha256=entry['requestSha256'],builtAt=start-10000,
            publishedAt=start-9000,artifactId=1,artifactDigest='sha256:test',runId=2,runAttempt=1,requestCommit='a'*40,
            validFrom=start,validUntil=config['validUntil'],contextOnly=False)
        artifact=dict(id=1,digest='sha256:test',expired=False,workflow_run={'id':2},created_at=c.utc(start-9500))
        args=SimpleNamespace(state_root=str(self.root/'state'));state=dict(schema=1,selections={},days={config['day']:entry})
        def api(path):return {'workflow_runs':[run]} if path.startswith('actions/runs?') else artifact
        with patch.object(ctl,'ROOT',repo),patch.object(ctl,'api',side_effect=api),patch.object(ctl,'results_for',return_value=[catalog]),patch.object(ctl,'now_ms',return_value=start+50):
            result=ctl.reconcile(args,state,start)
            self.assertEqual(result['days'][config['day']]['publication']['acceptedAt'],start+50)
            state['days'][config['day']]=dict(entry)  # crash before state write, durable catalog survived
            with patch.object(ctl,'now_ms',return_value=start+100):
                result=ctl.reconcile(args,state,start)
                self.assertEqual(result['days'][config['day']]['publication']['acceptedAt'],start+50)
    def test_publication_cannot_backdate_or_extend(self):
        config=c.schedule('2026-09-24');start=config['validFrom'];r={'day':config['day'],'requestId':'id','createdAt':config['trainBefore']+1}
        cat=dict(status='sealed_pending_publish',requestId='id',requestSha256=c.sha(c.canonical(r)+b'\n'),builtAt=start+1000,publishedAt=start+2000,
            artifactId=1,artifactDigest='sha256:test',runId=2,validFrom=start,validUntil=config['validUntil'],contextOnly=False)
        artifact=dict(id=1,digest='sha256:test',expired=False,workflow_run={'id':2},created_at=c.utc(start+1500))
        accepted=validate_catalog(cat,r,artifact,start+3000)
        self.assertEqual(accepted['status'],'available_late');self.assertFalse(c.publication_eligible(accepted,start+2999))
        self.assertTrue(c.publication_eligible(accepted,start+3000));self.assertFalse(c.publication_eligible(accepted,config['validUntil']))
        with self.assertRaises(c.InputError):validate_catalog(cat,r,artifact,start+1000)
        self.assertEqual(validate_catalog(cat,r,artifact,config['validUntil'])['status'],'expired')
    def test_failure_classification_never_masks_scientific_gate(self):
        entry=dict(requestCommit='same');run=dict(head_sha='same',id=1,run_attempt=1,status='completed',conclusion='failure')
        self.assertEqual(ctl.apply_run(entry,run,[],None,self.at)['status'],'operational_failure')
        self.assertEqual(ctl.apply_run(entry,run,[{'status':'scientific_halt'}],None,self.at)['status'],'scientific_halt')
        self.assertEqual(ctl.apply_run(entry,run,[{'status':'provenance_invalid'}],None,self.at)['status'],'provenance_invalid')
        with self.assertRaises(c.InputError):ctl.apply_run(entry,dict(run,head_sha='other'),[],None,self.at)
    def test_controller_lock_does_not_steal_after_crash(self):
        root=self.root/'state';root.mkdir();(root/'controller.lock').mkdir()
        with self.assertRaises(c.InputError):
            with ctl.locked(root):pass
    def test_aggregate_child_rss_and_scratch_enforced(self):
        child='import time; x=bytearray(40*1024**2); time.sleep(10)'
        parent=f'import subprocess,sys; ps=[subprocess.Popen([sys.executable,"-c",{child!r}]) for _ in range(2)]; [p.wait() for p in ps]'
        report=self.root/'resource.json'
        with self.assertRaises(RuntimeError):run([sys.executable,'-c',parent],self.root,self.root,report,rss_limit=100*1024**2,seconds=5)
        self.assertEqual(c.strict_json(report.read_bytes())['limitViolation'],'aggregate-rss')
        code='from pathlib import Path; import time; Path("large").write_bytes(b"x"*2*1024**2); time.sleep(5)'
        with self.assertRaises(RuntimeError):run([sys.executable,'-c',code],self.root,self.root,report,scratch_limit=1024**2,seconds=4)
        self.assertEqual(c.strict_json(report.read_bytes())['limitViolation'],'scratch')
    def test_implementation_manifest_and_old_controls_remain_pinned(self):
        manifest=verify_implementation();self.assertIn('research/brown-rolling-seal/build.py',manifest['files'])
        self.assertIn('services/shuttle-v2/src/network/geo.ts',manifest['files'])

if __name__=='__main__':unittest.main(verbosity=2)
