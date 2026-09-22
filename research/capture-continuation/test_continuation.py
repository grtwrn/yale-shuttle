"""Hosted synthetic capture parts. No public response or prospective body read."""
import copy
import datetime as dt
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from continuation_common import utc_us,validate_plan,digest,load_deployment,parse_json
from continuation_control import launch_check,handoff_decision,snapshot_metadata,write_audit,recorder_args
from continuation_stitch import classify_record,index_parts,decision_events,decoder
from continuation_bundle import build

HERE=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('frozen_recorder',HERE/'reference/recorder.py');recorder=importlib.util.module_from_spec(spec);spec.loader.exec_module(recorder)
class Response(io.BytesIO):
    def __init__(self,body,status=200):super().__init__(body);self.status=status;self.headers={'Content-Type':'application/json','Content-Length':str(len(body))}
    def getcode(self):return self.status
def iso(us):return (dt.datetime(1970,1,1,tzinfo=dt.timezone.utc)+dt.timedelta(microseconds=us)).isoformat()

class ContinuationTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.root=Path(self.temp.name)
        self.plan=json.loads((HERE/'plan.json').read_text());self.parts={p['id']:p for p in self.plan['parts']};self.boundary=utc_us(self.parts['B']['primaryFrom'])
        self.wall=self.boundary-60000000;self.mono=1000.0;self.web=b'{"buses":[]}';self.status=200
        self.addCleanup(patch.stopall)
        patch.object(recorder,'utc',side_effect=lambda:iso(self.wall)).start()
        patch.object(recorder.time,'monotonic',side_effect=lambda:self.mono).start()
        # Freeze datetime too: these fixtures must remain runnable after Sep30.
        real_datetime=dt.datetime
        class Clock(real_datetime):
            @classmethod
            def now(cls,tz=None):return real_datetime.fromisoformat(iso(self.wall)).astimezone(tz)
        patch.object(recorder.dt,'datetime',Clock).start()
        self.sources={};self.prefixes={}
    def capture(self,pid):
        c=recorder.Capture(self.root/pid,dt.datetime.fromisoformat(self.plan['deadline'].replace('Z','+00:00')),self.plan['maximumPartBytes'],self.plan['minimumFreeBytes'])
        def opened(request,timeout):return Response(self.web,self.status)
        patch.object(c.opener,'open',side_effect=opened).start();patch.object(c,'capacity',return_value=None).start()
        self.sources[pid]=c;return c
    def request(self,c,at,kind='fleet',body=b'{"buses":[]}',status=200,receive_delta=1000):
        self.wall=at;self.mono+=15;self.web=body;self.status=status
        url=recorder.BASE+{'fleet':'/api/buses','health':'/healthz','html':'/','module':'/assets/a.js'}[kind]
        original_open=c.opener.open
        def opened(request,timeout):
            response=original_open(request,timeout);self.wall=at+receive_delta;self.mono+=max(0,receive_delta/1e6);return response
        with patch.object(c.opener,'open',side_effect=opened):return c.request(url,kind)[0]
    def freeze(self,pid,suffix=''):
        directory=self.root/(pid+'-sealed'+suffix);sha=decoder.freeze_prefix(self.root/pid,directory,self.sources[pid].sequence);self.prefixes[pid]=(directory,sha)
        if pid=='A':
            first=json.loads((directory/'records.jsonl').read_text().splitlines()[0]);line=(directory/'records.jsonl').read_bytes().splitlines(keepends=True)[0]
            self.parts['A']['preservedPrefix'].update(records=1,lastRecordSha256=digest(line))
        return directory,sha
    def minimal_parts(self):
        for pid in ('A','B','C'):
            c=self.capture(pid);self.request(c,utc_us(self.parts[pid]['primaryFrom'])+1000000);self.freeze(pid)
    def index(self):return index_parts(self.plan,self.prefixes,self.root/'index')

    def test_plan_constants_and_no_adaptive_fourth_part(self):
        validate_plan(self.plan)
        for change in ({'maximumPartBytes':4*1024**3},{'minimumFreeBytes':1},{'deadline':'2026-10-01T00:00:00Z'}):
            with self.assertRaises(ValueError):validate_plan(dict(self.plan,**change))
        with self.assertRaises(ValueError):validate_plan(dict(self.plan,parts=self.plan['parts']+[self.parts['C']]))
    def test_launch_window_exact_limits_and_no_existing_directory(self):
        p=self.parts['B'];at=utc_us(p['launchAt']);args=launch_check(self.plan,p,at,False,self.plan['recorderSha256'])
        self.assertIn('3221225472',args);self.assertIn('4294967296',args)
        for when,exists,sha in [(at-1,False,self.plan['recorderSha256']),(self.boundary+120000000,False,self.plan['recorderSha256']),(at,True,self.plan['recorderSha256']),(at,False,'bad')]:
            with self.assertRaises(ValueError):launch_check(self.plan,p,when,exists,sha)
    def test_request_ownership_exact_boundary_not_receipt(self):
        r={'kind':'fleet','requestedAt':iso(self.boundary-1),'receivedAt':iso(self.boundary+9000000)}
        self.assertEqual(classify_record(self.parts['A'],r),'primary');self.assertEqual(classify_record(self.parts['B'],r),'overlap_audit')
        r['requestedAt']=iso(self.boundary)
        self.assertEqual(classify_record(self.parts['A'],r),'overlap_audit');self.assertEqual(classify_record(self.parts['B'],r),'primary')
    def test_prelude_release_is_context_and_gaps_have_unknown_span(self):
        r={'kind':'health','requestedAt':iso(self.boundary-1)}
        self.assertEqual(classify_record(self.parts['B'],r),'prelude_context')
        self.assertEqual(classify_record(self.parts['A'],{'kind':'schedule-gap','at':iso(self.boundary+1)}),'gap_evidence')
    def test_live_metadata_handoff_ignores_prelude_and_failed_fleet(self):
        c=self.capture('B');self.request(c,self.boundary-1000000);self.request(c,self.boundary+1000000,status=503)
        meta=snapshot_metadata(self.root/'B',self.plan)
        self.assertEqual(handoff_decision(self.plan,self.parts['B'],self.boundary+3000000,meta)['status'],'waiting')
        self.request(c,self.boundary+15000000);meta=snapshot_metadata(self.root/'B',self.plan)
        self.assertEqual(handoff_decision(self.plan,self.parts['B'],self.boundary+16000000,meta)['status'],'ready')
        self.assertEqual(handoff_decision(self.plan,self.parts['B'],self.boundary+120000000,None)['status'],'failed')
    def test_future_receipt_cannot_trigger_handoff(self):
        c=self.capture('B');self.request(c,self.boundary+1000000,receive_delta=9000000);meta=snapshot_metadata(self.root/'B',self.plan)
        self.assertEqual(handoff_decision(self.plan,self.parts['B'],self.boundary+2000000,meta)['status'],'waiting')
        self.assertEqual(handoff_decision(self.plan,self.parts['B'],self.boundary+10000000,meta)['status'],'ready')
    def test_later_clock_rollback_blocks_old_transport_success_handoff(self):
        b=self.capture('B');self.request(b,self.boundary+1000000)
        self.request(b,self.boundary+500000);meta=snapshot_metadata(self.root/'B',self.plan)
        result=handoff_decision(self.plan,self.parts['B'],self.boundary+2000000,meta)
        self.assertEqual(result['status'],'failed');self.assertIn('unsafe successor clock',result['reason'])
    def test_preserve_failure_overlap_and_microsecond_receipt_order(self):
        a=self.capture('A');self.request(a,self.boundary-1000000,receive_delta=9000000);self.request(a,self.boundary+10000000);self.freeze('A')
        b=self.capture('B');self.request(b,self.boundary-500000,kind='health',body=b'{"build":"unqualified"}')
        self.request(b,self.boundary+1,status=503);self.request(b,self.boundary+15000000);self.freeze('B')
        audit=self.index();rows=list(decision_events(self.root/'index',self.boundary+30000000))
        self.assertEqual(audit['missingParts'],['C']);self.assertEqual(audit['scenarioResetEvents'],0)
        fleets=[r for r in rows if r['primaryFleetEvent']];self.assertEqual(len(fleets),3)
        self.assertEqual([r['capturePart'] for r in fleets],['B','A','B']);self.assertFalse(fleets[0]['updateFleet'])
        self.assertFalse(rows[0]['updateFleet']);self.assertTrue(rows[0]['releaseContextOnly'])
        self.assertEqual(audit['roles']['overlap_audit'],1)
    def test_same_body_is_not_extra_overlap_sample_or_identity_proof(self):
        for pid in ('A','B'):
            c=self.capture(pid);self.request(c,self.boundary-1000000);self.request(c,self.boundary+1000000);self.freeze(pid)
        audit=self.index();rows=list(decision_events(self.root/'index',self.boundary+2000000))
        self.assertEqual(sum(r['primaryFleetEvent'] for r in rows),2)
        self.assertEqual(len({r['captureScopedId'] for r in rows}),len(rows));self.assertIn('none added',audit['identityProof'])
    def test_deleted_future_prefix_preserves_admitted_events(self):
        c=self.capture('A');self.request(c,self.boundary-15000000);self.freeze('A');self.index()
        before=list(decision_events(self.root/'index',self.boundary-10000000))
        self.request(c,self.boundary-1000000)
        self.freeze('A','-long');index_parts(self.plan,self.prefixes,self.root/'long-index')
        after=list(decision_events(self.root/'long-index',self.boundary-10000000))
        # Prefix locator changes; physical record identity and all admitted
        # record/role/clock values do not depend on the later prefix length.
        self.assertNotEqual(before[0]['prefixSha256'],after[0]['prefixSha256'])
        self.assertEqual([{k:v for k,v in r.items() if k!='prefixSha256'} for r in before],
                         [{k:v for k,v in r.items() if k!='prefixSha256'} for r in after])
    def test_missing_successor_never_substitutes_old_overlap(self):
        a=self.capture('A');self.request(a,self.boundary-1000000);self.request(a,self.boundary+1000000);self.freeze('A');self.index()
        rows=list(decision_events(self.root/'index',self.boundary+2000000));self.assertEqual(len(rows),1)
        self.assertEqual(rows[0]['capturePart'],'A')
    def test_original_prefix_anchor_and_partial_index_fail_closed(self):
        self.minimal_parts();self.parts['A']['preservedPrefix']['lastRecordSha256']='0'*64
        with self.assertRaisesRegex(ValueError,'original A prefix'):self.index()
        self.assertFalse((self.root/'index/verification.json').exists())
        with self.assertRaises(FileNotFoundError):list(decision_events(self.root/'index',self.boundary))
    def test_clock_discontinuity_preserved_not_repaired(self):
        a=self.capture('A');self.request(a,self.boundary-1000000);self.request(a,self.boundary-2000000);self.freeze('A')
        audit=self.index();self.assertEqual(audit['unsafeClockParts'],['A']);self.assertFalse(audit['decisionReady'])
        self.assertTrue(any(r['clockUnsafe'] for r in decision_events(self.root/'index',self.boundary)))
    def test_handoff_result_is_write_once(self):
        path=self.root/'audit.json';write_audit(path,{'status':'failed'})
        with self.assertRaises(FileExistsError):write_audit(path,{'status':'complete'})
    def test_equal_receipts_tie_by_fixed_part_then_sequence(self):
        a=self.capture('A');self.request(a,self.boundary-1,receive_delta=1000001);self.freeze('A')
        b=self.capture('B');self.request(b,self.boundary,receive_delta=1000000);self.freeze('B');self.index()
        rows=list(decision_events(self.root/'index',self.boundary+1000000))
        self.assertEqual([r['capturePart'] for r in rows],['A','B'])
        self.assertEqual(rows[0]['receiptUs'],rows[1]['receiptUs'])
    def test_schedule_gap_cap_stop_and_no_eof_synthetic_sample(self):
        a=self.capture('A');self.request(a,self.boundary-1000000)
        self.wall=self.boundary;a.manifest['skippedTicks']+=2
        a.record(dict(kind='schedule-gap',at=iso(self.wall),skippedTicks=2,nextMonotonic=self.mono+30))
        a.manifest.update(status='stopped',stopReason='capture-byte-limit',finishedAt=iso(self.wall));a.save();self.freeze('A')
        audit=self.index();rows=list(decision_events(self.root/'index',self.boundary+2000000))
        self.assertEqual(len(rows),2);self.assertEqual(sum(r['primaryFleetEvent'] for r in rows),1)
        self.assertEqual(rows[1]['gapOwnership'],'unknown span; no requestedAt')
        self.assertEqual(rows[1]['record']['skippedTicks'],2)
        self.assertEqual(audit['parts']['A']['sourceStopReason'],'capture-byte-limit')
        self.assertEqual(audit['parts']['A']['collectionStatus'],'closed');self.assertFalse(audit['decisionReady'])
    def test_handoff_chain_mutation_rejected_without_body_reads(self):
        b=self.capture('B');self.request(b,self.boundary+1)
        journal=self.root/'B/records.jsonl';row=json.loads(journal.read_text());row['sequence']=7;journal.write_text(json.dumps(row)+'\n')
        with self.assertRaisesRegex(ValueError,'chain mismatch'):snapshot_metadata(self.root/'B',self.plan)
    def test_duplicate_and_nonfinite_metadata_rejected(self):
        for raw in ('{"x":1,"x":2}','{"x":NaN}','{"x":1e999}'):
            with self.assertRaises(ValueError):parse_json(raw)
    def test_submillisecond_clock_rollback_is_unsafe(self):
        a=self.capture('A');self.request(a,self.boundary-1000000,receive_delta=400)
        self.request(a,self.boundary-999601,receive_delta=200);self.freeze('A')
        audit=self.index();self.assertEqual(audit['unsafeClockParts'],['A']);self.assertTrue(audit['parts']['A']['exactClockUnsafe'])
    def test_single_scenario_state_survives_part_boundary_and_failure(self):
        a=self.capture('A');self.request(a,self.boundary-15000000);self.freeze('A')
        b=self.capture('B');self.request(b,self.boundary-1000000,kind='health',status=503)
        self.request(b,self.boundary+1,status=503);self.request(b,self.boundary+15000000);self.freeze('B');self.index()
        rows=list(decision_events(self.root/'index',self.boundary+20000000))
        # A tiny consumer contract fixture, not a real frontend parity claim.
        state={'armed':False,'walking':True,'lastFleetReceipt':None,'updates':0}
        for row in rows:
            self.assertFalse(row['strictIdentityKnown']);self.assertFalse(row['acceptedRelease'])
            if row['updateFleet']:state.update(lastFleetReceipt=row['receiptUs'],updates=state['updates']+1)
        self.assertEqual(state['updates'],2);self.assertFalse(state['armed']);self.assertTrue(state['walking'])
        self.assertEqual(sum(r['primaryFleetEvent'] for r in rows),3)
        self.assertTrue(any(r['releaseContextOnly'] and r['record']['status']==503 for r in rows))
    def test_unqualified_new_part_health_cannot_acquire_old_identity(self):
        a=self.capture('A');self.request(a,self.boundary-1000000,kind='health',body=b'{"build":"old"}');self.freeze('A')
        b=self.capture('B');self.request(b,self.boundary-500000,kind='health',body=b'{"build":"new"}')
        self.request(b,self.boundary+1);self.freeze('B');self.index()
        rows=list(decision_events(self.root/'index',self.boundary+2000000))
        self.assertTrue(all(r['acceptedRelease'] is False and r['strictIdentityKnown'] is False for r in rows))
        self.assertEqual([r['capturePart'] for r in rows if r['primaryFleetEvent']],['B'])
    def test_bundle_manifest_hashes_and_fixed_future_units(self):
        out=self.root/'review';seal=build('a'*40,out);manifest=load_deployment(out/'bundle/deployment-manifest.json',seal['deploymentManifestSha256'])
        self.assertEqual(manifest['plan']['maximumAggregateBytes'],9*1024**3)
        timers=list((out/'units').glob('*.timer'));self.assertEqual(len(timers),4)
        self.assertNotIn('start shuttle-public', (out/'INSTALL-REVIEW-ONLY.sh').read_text())
        (out/'bundle/continuation_control.py').write_text('changed')
        with self.assertRaisesRegex(ValueError,'tool hash'):load_deployment(out/'bundle/deployment-manifest.json',seal['deploymentManifestSha256'])

if __name__=='__main__':unittest.main()
