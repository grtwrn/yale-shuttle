import datetime,importlib.util,json,pathlib,tempfile,types,unittest
spec=importlib.util.spec_from_file_location('nightly',pathlib.Path(__file__).with_name('standing-forecast-nightly.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)

class NightlyGuards(unittest.TestCase):
    def test_exact_source_identity(self):
        a=dict(algorithm='a',policy={'n':2},sourceHashes={'worker':'hash'},dependencies={},helperSha256='helper')
        m.same_identity(a,{**a,'node':'other-recorded-version'})
        for key,value in [('algorithm','other'),('policy',{'n':3}),('sourceHashes',{'worker':'changed'})]:
            with self.assertRaises(RuntimeError):m.same_identity(a,{**a,key:value})

    def test_machine_ambiguity_refuses_restart_target(self):
        self.assertEqual(m.choose_machine([{'id':'one','state':'started'},{'id':'old','state':'stopped'}]),'one')
        for rows in [[],[{'id':'one','state':'started'},{'id':'two','state':'started'}]]:
            with self.assertRaises(RuntimeError):m.choose_machine(rows)

    def test_fit_cutoff_matches_frozen_snapshot(self):
        a=dict(algorithm='a',policy={});s=dict(snapshotCutoff=1000,dayStart=0)
        v={**a,'request':dict(cutoff=1000,serviceDayCutoff=0),'fit':dict(fittedAt=1000),'diagnostics':dict(serviceDayCutoff=0)}
        m.validate_result(v,a,s)
        with self.assertRaises(RuntimeError):m.validate_result(v,a,{**s,'snapshotCutoff':1001})

    def test_missed_timer_cannot_publish_during_daytime(self):
        def t(h,minute):return datetime.datetime(2026,9,9,h,minute,tzinfo=m.ET)
        self.assertFalse(m.publication_window(t(0,29)))
        self.assertTrue(m.publication_window(t(0,30)))
        self.assertTrue(m.publication_window(t(3,59)))
        self.assertFalse(m.publication_window(t(4,0)))
        self.assertFalse(m.publication_window(t(8,5)))

    def test_rollback_does_not_restart_active_daytime_service(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder=pathlib.Path(tmp)
            (folder/'install-receipt.json').write_text(json.dumps({'action':'installed'}))
            runner=m.Runner(types.SimpleNamespace(),folder);runner.restarted=True
            runner.prepare_remote=lambda:None;runner.put=lambda *args:None
            runner.remote_helper=lambda *args:{'action':'restored'}
            runner.event=lambda *args,**kw:None
            def refuse(_label):raise RuntimeError('Active buses or daytime')
            runner.check_publication_window=refuse
            calls=[];runner.call=lambda *args,**kw:calls.append(args)
            runner.rollback()
            self.assertTrue(runner.rollback_confirmed)
            self.assertEqual(calls,[])

    def test_retention_removes_only_owned_old_success_snapshots(self):
        with tempfile.TemporaryDirectory() as tmp:
            state=pathlib.Path(tmp)
            for i in range(10):
                d=state/'runs'/str(i);d.mkdir(parents=True)
                (d/'snapshot.db').write_bytes(b'private');(d/'fit.json').write_text('{}')
                (d/'success.json').write_text(json.dumps(dict(runner='standing-forecast-nightly-v1',completedAt=f'2026-09-{i+1:02d}')))
            other=state/'runs'/'unowned';other.mkdir();(other/'snapshot.db').write_bytes(b'keep')
            m.prune_owned_snapshots(state,7)
            self.assertEqual(len(list((state/'runs').glob('*/snapshot.db'))),8)
            self.assertEqual(len(list((state/'runs').glob('*/fit.json'))),10)
            self.assertTrue((other/'snapshot.db').exists())

if __name__=='__main__':unittest.main()
