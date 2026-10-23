import contextlib
import io
import gzip
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time
import unittest
from unittest.mock import patch

import evidence
import poll


class IncidentEvidenceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.watch = self.root / "rider"
        self.watch.mkdir()
        (self.watch / "images").mkdir()
        self.pending = self.root / "pending"
        self.pending.mkdir()
        self.store = self.root / "evidence"
        self.event = {"at": "2026-10-17T16:00:00Z", "runId": "r1", "kind": "journey-finished", "detail": "ride-timeout-needs-review"}
        self.refs = {"watcherDir": str(self.watch), "runId": "r1", "screenshots": [str(self.watch / "images/last.jpg")]}
        self.rows(self.watch / "samples-1.jsonl", [{"runId": "r1", "text": "before"}, {"runId": "other", "text": "unrelated"}])
        self.rows(self.watch / "samples.jsonl", [{"runId": "r1", "text": "after"}])
        self.rows(self.watch / "events.jsonl", [self.event])
        self.rows(self.watch / "journeys.jsonl", [{"id": "r1", "samples": 2, "result": "ride-timeout-needs-review"}])
        self.rows(self.watch / "images.jsonl", [{"name": "first.jpg", "runId": "r1", "label": "waiting"}, {"name": "last.jpg", "runId": "r1", "label": "timeout"}])
        (self.watch / "images/first.jpg").write_bytes(b"first screenshot")
        (self.watch / "images/last.jpg").write_bytes(b"last screenshot")
        self.rows(self.watch / "status.json", [{"capture": "current"}])

    def rows(self, path, rows):
        path.write_text("".join(json.dumps(row) + "\n" for row in rows))

    def capture(self, incident="incident1", event=None, refs=None):
        return evidence.capture_bundle(self.store, incident, event or self.event, refs or self.refs, [self.watch])

    def manifest(self, receipt):
        return json.loads((Path(receipt["directory"]) / "manifest.json").read_text())

    def feed_fixture(self):
        module = Path(__file__).resolve().parent.parent / "rider-watch/feed-evidence.mjs"
        raw = '{ "buses":[],"text":"héllo 🚌","same":1,"same":2 }\n'.encode()
        source = ("import {retainFeedResponse} from " + json.dumps(module.as_uri()) + ";"
                  "const reference=await retainFeedResponse(" + json.dumps(str(self.watch)) + ","
                  "{runId:'1234',body:Buffer.from(" + json.dumps(list(raw)) + "),receivedAt:1234,"
                  "headers:{'content-type':'application/json','set-cookie':'DO_NOT_RETAIN'}});"
                  "process.stdout.write(JSON.stringify(reference));")
        reference = json.loads(subprocess.check_output(["node", "--input-type=module", "-e", source]))
        self.event = {**self.event, "runId": "1234"}
        self.refs = {**self.refs, "runId": "1234"}
        self.rows(self.watch / "samples.jsonl", [{"runId": "1234", "text": "actual", "feedResponse": reference}])
        self.rows(self.watch / "journeys.jsonl", [{"id": "1234", "samples": 1, "arrivalObservation": {"feedResponse": reference}}])
        return raw, reference

    def test_node_captured_feed_bytes_survive_in_python_incident_bundle_after_cache_rotation(self):
        raw, _ = self.feed_fixture()
        receipt = self.capture()
        manifest = self.manifest(receipt)
        self.assertTrue(manifest["feedResponseCoverage"]["contextComplete"])
        self.assertTrue(manifest["feedResponseCoverage"]["fullTripBodiesRetained"])
        records = [json.loads(line) for line in gzip.decompress((Path(receipt["directory"]) / "feed-responses.jsonl.gz").read_bytes()).splitlines()]
        self.assertEqual(len(records), 1)
        self.assertEqual(evidence.verify_feed_response(records[0]), raw)
        self.assertNotIn("DO_NOT_RETAIN", json.dumps(records))
        shutil.rmtree(self.watch / "feed-responses")
        self.assertEqual(evidence.verify_bundle(receipt["directory"]), receipt)

    def test_damaged_feed_body_is_an_explicit_gap_and_does_not_prevent_incident_delivery(self):
        _, reference = self.feed_fixture()
        source = self.watch / reference["file"]
        record = json.loads(source.read_text())
        record["decodedSHA256"] = "0" * 64
        self.rows(source, [record])
        receipt = self.capture()
        manifest = self.manifest(receipt)
        self.assertTrue(manifest["sampleCoverage"]["complete"])
        self.assertFalse(manifest["feedResponseCoverage"]["contextComplete"])
        self.assertEqual(manifest["feedResponseCoverage"]["retainedBodies"], 0)
        self.assertTrue(manifest["gaps"])
        self.assertTrue(source.exists())

    def test_feed_context_byte_budget_reports_omission_without_expanding_bundle_budget(self):
        self.feed_fixture()
        with patch.object(evidence, "MAX_FEED_CONTEXT_BYTES", 1):
            receipt = self.capture()
        coverage = self.manifest(receipt)["feedResponseCoverage"]
        self.assertFalse(coverage["contextComplete"])
        self.assertEqual(coverage["omittedByByteBudget"], 1)
        self.assertEqual(coverage["retainedBodies"], 0)

    def test_legacy_null_arrival_does_not_block_incident_capture(self):
        self.rows(self.watch / "journeys.jsonl", [{"id": "r1", "samples": 2, "arrivalObservation": None}])
        receipt = self.capture()
        self.assertTrue(receipt["sampleCoverage"]["complete"])
        self.assertEqual(self.manifest(receipt)["feedResponseCoverage"]["retainedBodies"], 0)

    def test_snapshot_survives_source_rotation_and_captures_only_its_run(self):
        receipt = self.capture()
        self.assertTrue(receipt["sampleCoverage"]["complete"])
        directory = Path(receipt["directory"])
        rows = [json.loads(line) for line in gzip.decompress((directory / "samples.jsonl.gz").read_bytes()).splitlines()]
        self.assertEqual([r["text"] for r in rows], ["before", "after"])
        self.assertEqual((directory / "images/first.jpg").read_bytes(), b"first screenshot")
        shutil.rmtree(self.watch)
        self.assertEqual(evidence.verify_bundle(directory), receipt)
        self.assertEqual(oct((directory / "manifest.json").stat().st_mode & 0o777), "0o600")

    def test_duplicate_capture_is_immutable_and_checksum_damage_is_refused(self):
        receipt = self.capture()
        self.rows(self.watch / "samples.jsonl", [{"runId": "r1", "text": "later"}])
        self.assertEqual(self.capture(), receipt)
        (Path(receipt["directory"]) / "samples.jsonl.gz").write_bytes(b"corrupt")
        with self.assertRaisesRegex(ValueError, "checksum"):
            self.capture()

    def test_missing_historical_samples_and_incomplete_rows_are_explicit(self):
        (self.watch / "samples-1.jsonl").unlink()
        (self.watch / "samples.jsonl").write_bytes(b'{"runId":"r1"}\n{"runId":"r1"')
        receipt = self.capture()
        self.assertFalse(receipt["sampleCoverage"]["complete"])
        self.assertEqual(receipt["sampleCoverage"]["rows"], 1)
        self.assertEqual(receipt["sampleCoverage"]["partialSourceRows"], 1)
        self.assertEqual(receipt["sampleCoverage"]["expectedFromJourney"], 2)

    def test_pending_protected_overage_then_processed_bundle_expires(self):
        receipt = self.capture()
        self.rows(self.pending / "incident.json", [{"id": "incident1"}])
        result = evidence.maintain_bundles(self.store, self.pending, max_bytes=1, now=time.time() + 20 * evidence.DAY)
        self.assertGreater(result["protectedOverageBytes"], 0)
        self.assertEqual(result["removedBundles"], 0)
        self.assertTrue(Path(receipt["directory"]).exists())
        (self.pending / "incident.json").unlink()
        result = evidence.maintain_bundles(self.store, self.pending, max_bytes=1, now=time.time() + 20 * evidence.DAY)
        self.assertEqual(result["removedBundles"], 1)
        self.assertFalse(Path(receipt["directory"]).exists())

    def test_corrupt_pending_queue_refuses_cleanup(self):
        receipt = self.capture()
        (self.pending / "broken.json").write_text("{")
        with self.assertRaises(ValueError):
            evidence.maintain_bundles(self.store, self.pending, max_bytes=1)
        self.assertTrue(Path(receipt["directory"]).exists())

    def test_image_path_traversal_and_symlinks_cannot_copy_other_files(self):
        secret = self.root / "secret.jpg"
        secret.write_bytes(b"not evidence")
        (self.watch / "images/link.jpg").symlink_to(secret)
        refs = {**self.refs, "screenshots": [str(self.watch / "images/link.jpg"), str(secret)]}
        receipt = self.capture(refs=refs)
        directory = Path(receipt["directory"])
        self.assertFalse((directory / "images/link.jpg").exists())
        self.assertTrue(self.manifest(receipt)["gaps"])
        with self.assertRaisesRegex(ValueError, "source"):
            self.capture(refs={**refs, "watcherDir": str(self.root)})

    def test_capture_waits_for_node_compatible_lock_and_cleans_partial_bundle(self):
        (self.watch / "storage.lock").write_text(str(os.getpid()))
        with self.assertRaises(TimeoutError):
            with evidence.rider_lock(self.watch, timeout=0.01):
                pass
        (self.watch / "storage.lock").unlink()
        with patch.object(evidence, "MAX_SELECTED_BYTES", 1):
            with self.assertRaisesRegex(ValueError, "selected logs"):
                self.capture()
        self.assertFalse(list(self.store.rglob(".incoming-*")))
        self.assertFalse((self.watch / "storage.lock").exists())
        self.assertTrue(self.capture()["sampleCoverage"]["complete"])

    def test_abandoned_partial_bundle_is_removed_but_a_live_writer_is_protected(self):
        parent = self.store / "incident1"
        parent.mkdir(parents=True)
        abandoned = parent / (".incoming-999999999-" + "a" * 32)
        abandoned.mkdir()
        (abandoned / "partial").write_bytes(b"incomplete")
        active = parent / (".incoming-" + str(os.getpid()) + "-" + "b" * 32)
        active.mkdir()
        (active / "partial").write_bytes(b"active")
        result = evidence.maintain_bundles(self.store, self.pending, max_bytes=1)
        self.assertFalse(abandoned.exists())
        self.assertTrue(active.exists())
        self.assertEqual(result["abandonedPartialBundlesRemoved"], 1)
        self.assertEqual(result["protectedBytes"], 6)

    def test_monitor_log_rotation_keeps_launchd_append_descriptor_and_one_bounded_tail(self):
        file = self.root / "monitor.log"
        original = bytes(range(128))
        file.write_bytes(original)
        inode = file.stat().st_ino
        with open(file, "ab") as writer, patch.multiple(poll, STATE=str(self.root), MONITOR_LOG_BYTES=64):
            poll.rotate_monitor_log()
            self.assertEqual(file.stat().st_ino, inode)
            self.assertEqual(gzip.decompress((self.root / "monitor.log.previous.gz").read_bytes()), original[-64:])
            writer.write(b"new poll")
            writer.flush()
            self.assertEqual(file.read_bytes(), b"new poll")
            writer.write(b"x" * 128)
            writer.flush()
            poll.rotate_monitor_log()
        self.assertEqual(gzip.decompress((self.root / "monitor.log.previous.gz").read_bytes()), b"x" * 64)
        self.assertEqual(len(list(self.root.glob("monitor.log*.gz"))), 1)
        self.assertFalse(list(self.root.glob("*.partial")))

    def bridge(self):
        patches = {"WATCH": str(self.watch), "WATCH_RED": str(self.root / "red"), "PENDING": str(self.pending), "EVIDENCE": str(self.store)}
        return patch.multiple(poll, **patches)

    def test_bridge_deduplication_retains_evidence_for_both_occurrences(self):
        state = {"open": {}}
        with self.bridge():
            poll.raise_incident(state, "rider-journey-failed", "Green", 1000, "first", {"event": self.event}, dict(self.refs))
            other = {**self.event, "runId": "r2", "at": "2026-10-17T16:01:00Z"}
            poll.raise_incident(state, "rider-journey-failed", "Green", 1060, "second", {"event": other}, {**self.refs, "runId": "r2"})
            poll.backfill_pending()
        files = list(self.pending.glob("*.json"))
        self.assertEqual(len(files), 1)
        incident = json.loads(files[0].read_text())
        self.assertEqual(len(incident["evidenceBundles"]), 2)
        self.assertEqual(len(incident["occurrences"]), 2)
        self.assertNotEqual(incident["occurrences"][-1]["evidenceBundle"]["directory"], incident["evidence"]["bundle"]["directory"])

    def test_capture_failure_is_visible_and_retry_preserves_original_alert(self):
        state = {"open": {}}
        with self.bridge():
            with patch.object(poll, "capture_bundle", side_effect=OSError("disk unavailable")):
                poll.raise_incident(state, "rider-journey-failed", "Green", 1000, "first", {"event": self.event}, dict(self.refs))
            file = next(self.pending.glob("*.json"))
            first = json.loads(file.read_text())
            self.assertIn("evidenceCaptureError", first)
            poll.backfill_pending()
            after = json.loads(file.read_text())
        self.assertNotIn("evidenceCaptureError", after)
        self.assertEqual(after["detail"], first["detail"])
        self.assertEqual(after["occurrences"], first["occurrences"])
        self.assertTrue(after["evidence"]["bundle"]["sampleCoverage"]["complete"])


    def test_scheduled_poll_reports_failed_backfill_then_recovers_without_replaying_events(self):
        state_file = self.root / "bridge-state.json"
        offset = (self.watch / "events.jsonl").stat().st_size
        state = {"offset": offset, "runs": {"r1": "Green"}, "open": {}, "since": 1, "journeyAlertsSince": 1}
        state_file.write_text(json.dumps(state))
        inc = {"id": "oldincident", "kind": "rider-journey-failed", "detectedAt": self.event["at"],
               "detail": {"event": self.event}, "evidence": self.refs, "occurrences": [{"at": self.event["at"]}]}
        (self.pending / "old.json").write_text(json.dumps(inc))
        with self.bridge(), patch.multiple(poll, STATE=str(self.root), BRIDGE=str(state_file)), patch.object(poll, "check_health"), contextlib.redirect_stdout(io.StringIO()):
            with patch.object(poll, "capture_bundle", side_effect=OSError("temporarily full")):
                self.assertEqual(poll.run_once(), 1)
            failed = json.loads((self.root / "evidence-status.json").read_text())
            self.assertFalse(failed["ok"])
            self.assertEqual(poll.run_once(), 0)
        self.assertEqual(json.loads(state_file.read_text())["offset"], offset)
        self.assertEqual(len(list(self.pending.glob("*.json"))), 1)
        recovered = json.loads((self.pending / "old.json").read_text())
        self.assertEqual(recovered["occurrences"], inc["occurrences"])
        self.assertTrue(recovered["evidence"]["bundle"]["sampleCoverage"]["complete"])
        self.assertTrue(json.loads((self.root / "evidence-status.json").read_text())["ok"])


if __name__ == "__main__":
    unittest.main()
