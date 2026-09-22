"""Hosted orchestration fixtures; tiny synthetic metadata only, never fleet history."""
import contextlib
import datetime as dt
import io
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest

from aggregate_benchmark import aggregate, input_checks
from benchmark import DATES, ROUTES, HERE, expected, reconcile
from capture_input import file_hash
from shared_input import describe_spool, validate_shared, write_json


def tiny_shared(root,date):
    """Small hand-authored spool schema fixture, not a verified real capture."""
    directory=root/('shared-'+date);spool=directory/'spool';meta=directory/'metadata'
    spool.mkdir(parents=True);meta.mkdir()
    day=dt.datetime.fromisoformat(date+'T04:00:00+00:00')
    origin=int(day.timestamp()*1000000)
    with sqlite3.connect(spool/'events.sqlite') as db:
        db.execute('CREATE TABLE events(ordinal INTEGER,at_us INTEGER,kind TEXT,event_json TEXT)')
        for i,delta in enumerate((0,86400000000)):
            at=origin+delta;utc=(day+dt.timedelta(microseconds=delta)).isoformat()
            row=dict(receivedAtUtc=utc,bodySha256=str(at).zfill(64))
            db.execute('INSERT INTO events VALUES(?,?,?,?)',(i,at,'fleet-receipt',json.dumps(row)))
    sha,size=file_hash(spool/'events.sqlite')
    ready=dict(captureId='synthetic-'+date,prefixSha256='a'*64,databaseSha256=sha,databaseBytes=size,
               syntheticGenerator=dict(start=date+'T04:00:00+00:00',seconds=87300,
               generatorSha256=file_hash(HERE/'make_synthetic_capture.py')[0]))
    write_json(spool/'ready.json',ready)
    (spool/'ready.sha256').write_text(file_hash(spool/'ready.json')[0]+'\n')
    describe_spool(spool,meta,date)
    write_json(meta/'generation-resources.json',dict(exitCode=0,limitViolation=None,elapsedSeconds=1))
    return directory


class PartitionTests(unittest.TestCase):
    def test_fixed_partition_preserves_all_keys_and_retained_streams(self):
        blocks=[expected('full',route,date) for date in DATES for route in ROUTES]
        self.assertEqual(len(blocks),98);self.assertTrue(all(len(b)==288 for b in blocks))
        rows=[row for block in blocks for row in block]
        self.assertEqual(len(rows),28224);self.assertEqual(len({r['id'] for r in rows}),28224)
        original={r['id'] for route in ROUTES for r in expected('full',route)}
        self.assertEqual({r['id'] for r in rows},original)
        self.assertEqual(sum((r['date']==DATES[0] and r['slot']==0) or (r['date']==DATES[-1] and r['slot']==47) for r in rows),168)

    def test_missing_whole_generation_and_shards_preserve_all_denominators(self):
        with tempfile.TemporaryDirectory() as root:
            root=Path(root)
            with contextlib.redirect_stdout(io.StringIO()):report=aggregate('full',root/'absent',root/'result')
            self.assertFalse(report['success']);self.assertEqual(report['counts']['expected'],28224)
            self.assertEqual(report['counts']['missingArtifactKeys'],28224)
            self.assertEqual(len(report['shards']),98);self.assertEqual(len(report['sharedInputs']),7)
            rows=[json.loads(line) for line in (root/'result'/'all-denominators.jsonl').read_text().splitlines()]
            for date in DATES:self.assertEqual(sum(r['date']==date for r in rows),4032)

    def test_failed_daily_shard_keeps_288_with_partial_row_evidence(self):
        with tempfile.TemporaryDirectory() as root:
            root=Path(root);assigned=expected('full',1,DATES[0]);day=root/('day-'+DATES[0]);day.mkdir()
            (day/'episodes.jsonl').write_text(json.dumps({**assigned[0],'executionStatus':'completed'})+'\n'+ '{"unfinished":')
            result=reconcile(root,assigned,'fixed synthetic failure')
            self.assertFalse(result['success']);self.assertEqual(result['completed'],1)
            self.assertEqual(result['missingKeys'],287);self.assertEqual(len(result['partialManifestLines']),1)
            self.assertEqual(len((root/'denominators.jsonl').read_text().splitlines()),288)

    def test_hard_killed_artifact_cannot_abort_global_denominators(self):
        with tempfile.TemporaryDirectory() as root:
            root=Path(root);artifact=root/('selection-scale-full-1-'+DATES[0]);artifact.mkdir()
            planned=expected('full',1,DATES[0]);row={**planned[0],'executionStatus':'completed'}
            (artifact/'summary.json').write_text('{"partial":')
            (artifact/'denominators.jsonl').write_text(json.dumps(row)+'\n'+json.dumps(row)+'\n'+json.dumps({**planned[1],'executionStatus':'completed'})+'\n'+ '{"partial":')
            (artifact/'worker-resources.json').write_text('{')
            with contextlib.redirect_stdout(io.StringIO()):report=aggregate('full',root,root/'result')
            self.assertFalse(report['success']);self.assertEqual(report['counts']['expected'],28224)
            self.assertEqual(report['counts']['terminalKeys'],1)
            self.assertEqual(report['counts']['missingArtifactKeys'],28223)
            self.assertEqual(len(report['shards'][0]['summary']['artifactIssues']),2)

    def test_shared_spool_hashes_date_and_generator_are_enforced(self):
        with tempfile.TemporaryDirectory() as root:
            directory=tiny_shared(Path(root),DATES[0])
            shared=validate_shared(directory,DATES[0]);self.assertEqual(shared['fleetReceipts'],2)
            with self.assertRaises(ValueError):validate_shared(directory,DATES[1])
            with (directory/'spool'/'events.sqlite').open('ab') as handle:handle.write(b'x')
            with self.assertRaises(ValueError):validate_shared(directory,DATES[0])

    def test_adjacent_inputs_require_same_original_clock_and_body(self):
        with tempfile.TemporaryDirectory() as root:
            root=Path(root)
            for date in DATES:
                directory=tiny_shared(root,date)
                (directory/'metadata').rename(root/('selection-input-metadata-'+date))
            checks=input_checks(root);self.assertTrue(all(r['success'] for r in checks))
            self.assertEqual([r['adjacentOverlapReceipts'] for r in checks],[0,1,1,1,1,1,1])
            meta=root/('selection-input-metadata-'+DATES[2]);index=meta/'fleet-index.jsonl'
            rows=[json.loads(line) for line in index.read_text().splitlines()];rows[0]['bodySha256']='b'*64
            index.write_text(''.join(json.dumps(r)+'\n' for r in rows))
            shared=json.loads((meta/'shared.json').read_text());shared['fleetIndexSha256']=file_hash(index)[0];write_json(meta/'shared.json',shared)
            checks=input_checks(root);self.assertFalse(checks[2]['success'])
            self.assertIn('disagree',checks[2]['error'])

    def test_generation_failure_resources_remain_a_failure(self):
        with tempfile.TemporaryDirectory() as root:
            root=Path(root);directory=tiny_shared(root,DATES[0]);meta=directory/'metadata'
            write_json(meta/'generation-resources.json',dict(exitCode=-9,limitViolation='scratch',elapsedSeconds=1))
            meta.rename(root/('selection-input-metadata-'+DATES[0]))
            checks=input_checks(root);self.assertFalse(checks[0]['success'])
            self.assertIn('resource failure',checks[0]['error'])


if __name__=='__main__':unittest.main(verbosity=2)
