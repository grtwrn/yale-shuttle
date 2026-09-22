"""Hosted synthetic fixtures: the pinned recorder is driven by in-memory HTTP."""
import datetime as dt
import gzip
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import capture_input as d

HERE = Path(__file__).resolve().parent
RESULTS = HERE / 'results'
spec = importlib.util.spec_from_file_location('pinned_capture', RESULTS / 'recorder.py')
c = importlib.util.module_from_spec(spec)
spec.loader.exec_module(c)
EPOCH = dt.datetime(2026, 9, 22, 6, 0, tzinfo=dt.timezone.utc)


class Response(io.BytesIO):
    def __init__(self, body, status=200, headers=None):
        super().__init__(body)
        self.status = status
        self.headers = headers or {'Content-Type':'application/json', 'Content-Length':str(len(body))}

    def getcode(self):
        return self.status


def encoded(value):
    return (json.dumps(value, separators=(',', ':'), allow_nan=False)+'\n').encode()


class CaptureInputTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.t = 0
        self.utc = lambda: (EPOCH+dt.timedelta(seconds=self.t)).isoformat()
        self.addCleanup(patch.stopall)
        patch.object(c, 'utc', side_effect=self.utc).start()
        patch.object(c.time, 'monotonic', side_effect=lambda:1000+self.t).start()
        self.capture = c.Capture(self.root/'source', dt.datetime(2099, 1, 1, tzinfo=dt.timezone.utc), 100*1024**2, 0)
        self.web = {}
        def opened(request, timeout):
            self.t += .001
            item = self.web[request.full_url]
            if isinstance(item, Exception):
                raise item
            body, status, headers = item
            return Response(body, status, headers)
        patch.object(self.capture.opener, 'open', side_effect=opened).start()
        self.counter = 0

    def request(self, body=b'{"buses":[]}', kind='fleet', status=200, headers=None):
        url = c.BASE + {'fleet':'/api/buses','health':'/healthz','html':'/','module':'/assets/a.js'}[kind]
        self.web[url] = (body, status, headers)
        return self.capture.request(url, kind)[0]

    def freeze(self, count=None):
        self.counter += 1
        output = self.root/f'prefix-{self.counter}'
        seal = d.freeze_prefix(self.root/'source', output, count or self.capture.sequence)
        return output, seal

    def verify(self, prefix=None):
        return list(d.iter_verified(*(prefix or self.freeze())))

    def rewrite(self, prefix, change=None, manifest_change=None):
        """Construct a separately sealed synthetic corruption, not a repair."""
        root, _ = prefix
        records = [json.loads(line) for line in (root/'records.jsonl').read_bytes().splitlines()]
        if change:
            change(records)
        previous, lines = None, []
        for record in records:
            record['previousRecordSha256'] = previous
            line = encoded(record)
            previous = d.digest(line)
            lines.append(line)
        journal = b''.join(lines)
        (root/'records.jsonl').write_bytes(journal)
        manifest = json.loads((root/'manifest.json').read_bytes())
        manifest['lastRecordSha256'] = previous
        manifest['storedDataBytes'] += 1024*1024
        if manifest_change:
            manifest_change(manifest)
        raw_manifest = encoded(manifest)
        (root/'manifest.json').write_bytes(raw_manifest)
        seal = json.loads((root/'prefix.json').read_bytes())
        seal.update(journalBytes=len(journal), journalSha256=d.digest(journal), records=len(records),
                    lastRecordSha256=previous, manifestBytes=len(raw_manifest), manifestSha256=d.digest(raw_manifest))
        raw = encoded(seal)
        (root/'prefix.json').write_bytes(raw)
        return root, d.digest(raw)

    def bundle(self, build='a', body=b'export const a=1', fail_module=False):
        html = b'<script type="module" src="/assets/a.js"></script><link rel="modulepreload" href="/assets/shared.js">'
        self.web.update({c.BASE+'/healthz':(encoded({'build':build}),200,None),
                         c.BASE+'/':(html,200,None),c.BASE+'/assets/a.js':(body,503 if fail_module else 200,None),
                         c.BASE+'/assets/shared.js':(b'export const shared=1',200,None)})
        self.capture.release()
        return {'source':build*40,'webTree':build*40,'proofKnownAt':EPOCH.isoformat(),
                'files':{'index.html':{'sha256':d.digest(html),'bytes':len(html)},
                         'assets/a.js':{'sha256':d.digest(body),'bytes':len(body)},
                         'assets/shared.js':{'sha256':d.digest(b'export const shared=1'),'bytes':len(b'export const shared=1')}}}

    def events(self, proofs=(), prefix=None):
        return list(d.iter_capture(*(prefix or self.freeze()), proofs))

    def fleets(self, events):
        return [e for e in events if e['event']=='fleet-receipt']

    def test_exact_recorder_identity_bytes_chain_and_dedup(self):
        self.assertEqual(d.digest((RESULTS/'recorder.py').read_bytes()), d.SCRIPT_SHA256)
        body=b'{ "buses":[], "server_eta":{"at":1,"servedAt":90000} }\n'
        self.request(body); self.t+=15; self.request(body)
        rows=self.verify()
        self.assertEqual(rows[0]['rawBody'],body)
        self.assertTrue(rows[0]['fleetUsable'])
        self.assertEqual(rows[0]['body']['server_eta']['at'],1)
        self.assertEqual(rows[-1]['distinctBlobs'],1)
        self.assertEqual(rows[-1]['records'],2)
        self.assertEqual(rows[-1]['manifestRelationship'],'same-prefix')

    def test_fixed_prefix_excludes_future_append_and_partial_tail(self):
        self.request(); prefix=self.freeze()
        self.t+=15;self.request(b'{"buses":[{"name":"future synthetic"}]}')
        with (self.root/'source'/'records.jsonl').open('ab') as handle:handle.write(b'{unfinished')
        self.assertEqual(self.verify(prefix)[-1]['records'],1)
        earlier=self.freeze(1)
        self.assertEqual(self.verify(earlier)[-1]['manifestRelationship'],'ahead-of-prefix')
        with self.assertRaisesRegex(d.IntegrityError,'complete final record'):
            self.freeze(3)
        self.assertFalse((self.root/f'prefix-{self.counter}'/'prefix.json').exists())

    def test_external_seal_catches_wholesale_rewrite(self):
        self.request(); old=self.freeze();new=self.rewrite(old)
        with self.assertRaisesRegex(d.IntegrityError,'seal hash'):
            self.verify(old)
        self.assertEqual(self.verify(new)[-1]['records'],1)

    def test_journal_mutation_deletion_extra_tail_and_partial_lines(self):
        self.request();self.t+=15;self.request()
        for operation in [lambda x:x.replace(b'fleet',b'fleeT'),lambda x:x.splitlines(keepends=True)[0],
                          lambda x:x+b'{}\n',lambda x:x[:-1]]:
            prefix=self.freeze();path=prefix[0]/'records.jsonl';path.write_bytes(operation(path.read_bytes()))
            with self.assertRaises(d.IntegrityError):self.verify(prefix)

    def test_sequence_chain_and_recorded_metadata_are_checked_beyond_seal(self):
        self.request();self.t+=15;self.request()
        corruptions=[(lambda r:r[0].update(sequence=1),'sequence'),
                     (lambda r:r.reverse(),'sequence'),
                     (lambda r:r[0].update(busCount=99),'metadata'),
                     (lambda r:r[0].update(transportComplete=False),'completeness'),
                     (lambda r:r[0].update(url=c.BASE+'/api/reports'),'public endpoint')]
        for change,message in corruptions:
            with self.subTest(message=message):
                prefix=self.rewrite(self.freeze(),change)
                with self.assertRaisesRegex(d.IntegrityError,message):self.verify(prefix)
        prefix=self.freeze();root=prefix[0]
        data=(root/'records.jsonl').read_bytes().replace(b'"previousRecordSha256":null',b'"previousRecordSha256":"bad"',1)
        (root/'records.jsonl').write_bytes(data)
        seal=json.loads((root/'prefix.json').read_bytes());seal.update(journalBytes=len(data),journalSha256=d.digest(data))
        raw=encoded(seal);(root/'prefix.json').write_bytes(raw)
        with self.assertRaisesRegex(d.IntegrityError,'chain'):self.verify((root,d.digest(raw)))

    def test_manifest_identity_and_sequence_counters(self):
        self.request()
        for change,message in [(lambda m:m.update(scriptSha256='0'*64),'manifest'),
                               (lambda m:m.update(completeResponses=20),'counters'),
                               (lambda m:m.update(storedDataBytes=0),'stored bytes')]:
            with self.subTest(message=message):
                with self.assertRaisesRegex(d.IntegrityError,message):self.verify(self.rewrite(self.freeze(),manifest_change=change))

    def test_manifest_can_lag_selected_completed_records(self):
        self.request(); old=(self.root/'source'/'manifest.json').read_bytes()
        self.t+=15;self.request();(self.root/'source'/'manifest.json').write_bytes(old)
        result=self.verify()[-1]
        self.assertEqual(result['manifestRelationship'],'behind-prefix')
        self.assertEqual(result['records'],2)

    def test_terminal_unjournaled_gap_count_is_not_invented_as_record(self):
        self.request()
        result=self.verify(self.rewrite(self.freeze(),manifest_change=lambda m:m.update(status='stopped',skippedTicks=3)))[-1]
        self.assertEqual(result['unjournaledManifestSkippedTicks'],3)
        self.assertEqual(result['skippedTicks'],0)
        with self.assertRaisesRegex(d.IntegrityError,'gap count'):
            self.verify(self.rewrite(self.freeze(),manifest_change=lambda m:m.update(skippedTicks=3)))

    def test_missing_changed_and_symlink_blobs(self):
        entry=self.request()
        for mode in ['missing','changed','symlink']:
            prefix=self.freeze();blob=prefix[0]/entry['blob']
            if mode=='changed':blob.write_bytes(blob.read_bytes()+b'x')
            else:
                blob.unlink()
                if mode=='symlink':blob.symlink_to(self.root/'source'/entry['blob'])
            with self.assertRaises(d.IntegrityError):self.verify(prefix)
        with self.assertRaisesRegex(d.IntegrityError,'blob path'):
            self.verify(self.rewrite(self.freeze(),lambda rows:rows[0].update(blob='../private.gz')))

    def test_raw_hash_gzip_truncation_members_and_bomb_are_checked(self):
        entry=self.request(b'{"buses":[]}')
        for mode in ['raw','truncated','members','oversized']:
            with self.subTest(mode=mode):
                prefix=self.freeze();blob=prefix[0]/entry['blob'];original=blob.read_bytes()
                altered={'raw':gzip.compress(b'{"buses":11}',mtime=0),'truncated':original[:-5],
                         'members':original+gzip.compress(b'extra',mtime=0),
                         'oversized':gzip.compress(b'x'*(d.BODY_LIMIT+1),mtime=0)}[mode]
                blob.write_bytes(altered)
                prefix=self.rewrite(prefix,lambda rows:rows[0].update(blobBytes=len(altered),blobSha256=d.digest(altered)))
                with self.assertRaises(d.IntegrityError):self.verify(prefix)

    def test_json_nonfinite_nonobjects_encoding_and_duplicates(self):
        for raw in [b'{broken',b'[]',b'{"buses":[],"n":NaN}',b'{"buses":[],"n":1e999}']:
            self.request(raw)
        self.request(gzip.compress(b'{"buses":[]}'),headers={'Content-Encoding':'gzip'})
        self.request(b'{"buses":[],"buses":[1]}')
        rows=self.verify()
        self.assertTrue(all(not r['fleetUsable'] for r in rows[:-1]))
        self.assertEqual(rows[-2]['duplicateBodyKeys'],['buses'])
        events=self.fleets(self.events())
        self.assertEqual(events[-1]['status'],'unknown');self.assertFalse(events[-1]['replayAdmissible'])

    def test_parseable_http_and_partial_failures_never_become_empty_success(self):
        self.request(b'{"buses":[]}',status=503)
        self.request(b'{"buses":[]}',headers={'Content-Length':'100'})
        self.web[c.BASE+'/api/buses']=TimeoutError()
        self.capture.request(c.BASE+'/api/buses','fleet')
        rows=self.verify()
        self.assertTrue(rows[0]['record']['readComplete'])
        self.assertFalse(rows[1]['record']['readComplete'])
        self.assertEqual(rows[1]['body'],{'buses':[]})
        self.assertTrue(all(not r['fleetUsable'] for r in rows[:-1]))
        self.assertEqual([r['status'] for r in self.fleets(self.events())],['failure']*3)

    def test_monotonic_serial_violation_rejected_wall_regression_retained_unknown(self):
        self.request();self.t+=15;self.request();self.t+=15;self.request()
        with self.assertRaisesRegex(d.IntegrityError,'monotonic'):
            self.verify(self.rewrite(self.freeze(),lambda rows:rows[1].update(requestMonotonic=0)))
        prior=(EPOCH-dt.timedelta(seconds=1)).isoformat()
        prefix=self.rewrite(self.freeze(),lambda rows:rows[1].update(requestedAt=prior,receivedAt=prior))
        rows=self.verify(prefix)
        self.assertFalse(rows[0]['clockUnsafe']);self.assertTrue(rows[1]['clockUnsafe']);self.assertTrue(rows[2]['clockUnsafe'])
        self.assertEqual([r['status'] for r in self.fleets(self.events(prefix=prefix))],['ok','unknown','unknown'])

    def test_schedule_gap_is_preserved_separately(self):
        self.request();self.capture.manifest['skippedTicks']+=2
        self.capture.record(dict(kind='schedule-gap',at=self.utc(),skippedTicks=2,nextMonotonic=1045))
        rows=self.verify()
        self.assertEqual(rows[1]['event'],'schedule-gap');self.assertEqual(rows[-1]['skippedTicks'],2)
        self.assertEqual(len(self.fleets(self.events())),1)

    def test_complete_bundle_candidate_requires_explicit_assumption(self):
        proof=self.bundle();self.request()
        first=self.fleets(self.events([proof]))[0]['releaseEvidence']
        self.assertEqual(first['source'],'a'*40)
        self.assertEqual(first['status'],'candidate_under_continuity_assumption')
        self.assertTrue(first['assumptionRequired']);self.assertFalse(first['strictIdentityKnown']);self.assertFalse(first['acceptedRelease'])

    def test_later_proof_never_relabels_an_earlier_receipt(self):
        proof=self.bundle();self.request()
        proof['proofKnownAt']=(EPOCH+dt.timedelta(seconds=10)).isoformat()
        self.t=15;self.request()
        fleets=self.fleets(self.events([proof]))
        self.assertIsNone(fleets[0]['releaseEvidence']['source'])
        self.assertEqual(fleets[1]['releaseEvidence']['source'],'a'*40)
        self.assertGreater(fleets[1]['releaseEvidence']['knownAt'],fleets[0]['receivedAt'])

    def test_same_build_failed_resource_retry_cannot_fill_from_prior_group(self):
        proof=self.bundle(fail_module=True);self.request()
        self.t=60;self.bundle();self.request()
        events=self.events([proof]);fleets=self.fleets(events)
        self.assertIsNone(fleets[0]['releaseEvidence']['source'])
        self.assertEqual(fleets[1]['releaseEvidence']['source'],'a'*40)
        self.assertTrue(any(e.get('reason')=='failed_resource' for e in events))

    def test_changed_build_unknown_bundle_and_rollback_are_explicit(self):
        proof=self.bundle();self.request()
        self.t=60;self.bundle('b',b'export const b=2');self.request()
        self.t=120;self.bundle();self.request()
        events=self.events([proof]);fleets=self.fleets(events)
        self.assertEqual([f['releaseEvidence']['source'] for f in fleets],['a'*40,None,'a'*40])
        brackets=[e for e in events if e['event']=='health-bracket-known']
        self.assertEqual([e['verdict'] for e in brackets],['changed_observed_ends']*2)
        self.assertTrue(all(not e['retroactiveAttribution'] for e in brackets))

    def test_equal_brackets_cannot_exclude_unobserved_intermediate_release(self):
        proof=self.bundle();self.request()
        self.t=60;self.capture.release();self.request()
        events=self.events([proof])
        bracket=next(e for e in events if e['event']=='health-bracket-known')
        self.assertEqual(bracket['verdict'],'equal_observed_ends')
        self.assertTrue(bracket['unobservedIntermediateReleasePossible'])
        self.assertLess(self.fleets(events)[0]['receivedAt'],bracket['knownAt'])
        self.assertTrue(self.fleets(events)[-1]['releaseEvidence']['assumptionRequired'])

    def test_health_failure_does_not_claim_build_identity(self):
        proof=self.bundle();self.request()
        self.t=60;self.request(b'{"build":"a"}',kind='health',status=503);self.request()
        candidate=self.fleets(self.events([proof]))[-1]['releaseEvidence']
        self.assertEqual(candidate['status'],'bundle_observed_health_unknown')
        self.assertEqual(candidate['healthFailuresSinceBundle'],1)

    def test_prefix_ending_mid_bundle_remains_incomplete(self):
        proof=self.bundle();prefix=self.freeze(3)
        events=self.events([proof],prefix)
        self.assertTrue(any(e.get('reason')=='prefix_ended_before_resource_completion' for e in events))
        self.assertFalse(any(e['event']=='bundle-observation-complete' for e in events))

    def test_conflicting_proofs_remain_ambiguous(self):
        proof=self.bundle();self.request();other={**proof,'source':'b'*40,'webTree':'b'*40}
        candidate=self.fleets(self.events([proof,other]))[0]['releaseEvidence']
        self.assertEqual(candidate['status'],'ambiguous_source_proofs');self.assertIsNone(candidate['source'])

    def test_emit_verified_synthetic_envelope_bridge(self):
        proof=self.bundle()
        raw=encoded(dict(buses=[],routes={},stop_names={},stop_coords={},segments={},dwells={}))
        self.request(raw);self.t=15;self.request(raw)
        events=self.events([proof]);fleet=self.fleets(events)
        self.assertTrue(all(f['replayAdmissible'] and f['complete'] for f in fleet))
        (RESULTS/'verified-synthetic-receipts.json').write_text(json.dumps(fleet,indent=2)+'\n')


if __name__ == '__main__':
    suite=unittest.defaultTestLoader.loadTestsFromTestCase(CaptureInputTests)
    result=unittest.TextTestRunner(verbosity=2).run(suite)
    report=dict(tests=result.testsRun,failures=len(result.failures),errors=len(result.errors),successful=result.wasSuccessful(),
                recorderCommit=d.RECORDER,recorderScriptSha256=d.SCRIPT_SHA256,
                cases=unittest.defaultTestLoader.getTestCaseNames(CaptureInputTests),
                failureDetails=[{'test':str(t),'details':text} for t,text in result.failures+result.errors])
    (RESULTS/'decoder-fixtures.json').write_text(json.dumps(report,indent=2)+'\n')
    raise SystemExit(0 if result.wasSuccessful() else 1)
