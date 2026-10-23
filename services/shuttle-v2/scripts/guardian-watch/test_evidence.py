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

    def boarding_feed_fixture(self, *, event_only=False, unavailable=False):
        module = Path(__file__).resolve().parent.parent / "rider-watch/feed-evidence.mjs"
        source = ("import {retainFeedResponse} from " + json.dumps(module.as_uri()) + ";"
                  "const refs=[];for(let i=0;i<3;i++)refs.push(await retainFeedResponse(" + json.dumps(str(self.watch)) + ","
                  "{runId:'1234',body:Buffer.from(' '+JSON.stringify({buses:[],control:i})+'\\n'),receivedAt:1234+i*1000}));"
                  "process.stdout.write(JSON.stringify(refs));")
        refs = json.loads(subprocess.check_output(["node", "--input-type=module", "-e", source]))
        self.event = {**self.event, "runId": "1234"}
        self.refs = {**self.refs, "runId": "1234"}
        self.rows(self.watch / "samples.jsonl", [{"runId": "1234", "feedResponse": refs[0]}, {"runId": "1234", "feedResponse": refs[2]}])
        check_ref = {"state": "unavailable", "runId": "1234", "reason": "raw-feed-response-unavailable"} if unavailable else refs[1]
        observation = {"v": 1, "sample": {"feedResponse": refs[0]}, "checks": [{"kind": "card-boards", "feedResponse": check_ref}]}
        journey = {"id": "1234", "samples": 2}
        events = [self.event]
        if event_only:
            events.append({**self.event, "kind": "boarding-checks", "detail": observation})
        else:
            journey["boardingObservation"] = observation
            if not unavailable:
                # The same body may serve two contexts; neither tag can erase
                # the other when duplicate references are collected.
                journey["arrivalObservation"] = {"feedResponse": refs[1]}
            events.append({**self.event, "kind": "boarding-missed", "detail": {"boardingObservation": observation}})
        self.rows(self.watch / "events.jsonl", events)
        self.rows(self.watch / "journeys.jsonl", [journey])
        return refs

    def test_middle_boarding_recheck_body_survives_guardian_context_selection(self):
        refs = self.boarding_feed_fixture()
        receipt = self.capture()
        manifest = self.manifest(receipt)
        coverage = manifest["feedResponseCoverage"]
        self.assertTrue(coverage["contextComplete"])
        self.assertEqual(coverage["boardingContextReferences"], 2)
        self.assertEqual(coverage["retainedBodies"], 3)
        records = [json.loads(line) for line in gzip.decompress((Path(receipt["directory"]) / "feed-responses.jsonl.gz").read_bytes()).splitlines()]
        middle = next(row for row in records if row["id"] == refs[1]["id"])
        self.assertEqual(evidence.verify_feed_response(middle), b' {"buses":[],"control":1}\n')
        shutil.rmtree(self.watch / "feed-responses")
        self.assertEqual(evidence.verify_bundle(receipt["directory"]), receipt)

    def test_retry_event_preserves_checks_absent_from_latest_journey(self):
        self.boarding_feed_fixture(event_only=True)
        coverage = self.manifest(self.capture())["feedResponseCoverage"]
        self.assertTrue(coverage["contextComplete"])
        self.assertEqual(coverage["retainedBodies"], 3)

    def test_boarding_context_uses_existing_byte_limit_and_reports_omissions(self):
        self.boarding_feed_fixture()
        with patch.object(evidence, "MAX_FEED_CONTEXT_BYTES", 1):
            coverage = self.manifest(self.capture())["feedResponseCoverage"]
        self.assertFalse(coverage["contextComplete"])
        self.assertEqual(coverage["omittedByByteBudget"], 3)
        self.assertEqual(coverage["retainedBodies"], 0)

    def test_unavailable_boarding_receipt_prevents_complete_context_claim(self):
        self.boarding_feed_fixture(unavailable=True)
        coverage = self.manifest(self.capture())["feedResponseCoverage"]
        self.assertFalse(coverage["contextComplete"])
        self.assertGreater(coverage["unavailableBoardingReferences"], 0)
        self.assertEqual(coverage["retainedBodies"], 2)

    def arrival_text_feed_fixture(self, *, event_only=False, same_receipt=False, unavailable=False):
        module = Path(__file__).resolve().parent.parent / "rider-watch/feed-evidence.mjs"
        source = ("import {retainFeedResponse} from " + json.dumps(module.as_uri()) + ";"
                  "const refs=[];for(let i=0;i<5;i++)refs.push(await retainFeedResponse(" + json.dumps(str(self.watch)) + ","
                  "{runId:'1234',body:Buffer.from(' '+JSON.stringify({buses:[],textControl:i})+'\\n'),receivedAt:1234+i*1000}));"
                  "process.stdout.write(JSON.stringify(refs));")
        refs = json.loads(subprocess.check_output(["node", "--input-type=module", "-e", source]))
        self.event = {**self.event, "runId": "1234"}
        self.refs = {**self.refs, "runId": "1234"}
        self.rows(self.watch / "samples.jsonl", [{"runId": "1234", "feedResponse": refs[i]} for i in [0, 2, 4]])
        text_ref = refs[1] if same_receipt else refs[2]
        if unavailable:
            text_ref = {"state": "unavailable", "runId": "1234", "reason": "raw-feed-response-unavailable"}
        observation = {"feedResponse": refs[1]}
        screen = {"sampledAt": "2026-10-23T19:06:28Z", "feedResponse": text_ref}
        journey = {"id": "1234", "samples": 3, "boardingObservation": {
            "v": 1, "sample": {"feedResponse": refs[0]}, "checks": [{"feedResponse": refs[3]}]}}
        if not event_only:
            journey.update({"arrivalObservation": observation, "arrivalTextContext": screen})
        self.rows(self.watch / "journeys.jsonl", [journey])
        self.rows(self.watch / "events.jsonl", [self.event, {**self.event, "kind": "arrived", "detail": {
            "observation": observation, "screen": screen}}])
        return refs

    def test_arrival_text_middle_body_is_retained_separately_from_first_arrival(self):
        refs = self.arrival_text_feed_fixture()
        receipt = self.capture()
        coverage = self.manifest(receipt)["feedResponseCoverage"]
        records = [json.loads(line) for line in gzip.decompress((Path(receipt["directory"]) / "feed-responses.jsonl.gz").read_bytes()).splitlines()]
        self.assertIn(refs[2]["id"], {row["id"] for row in records})
        self.assertEqual(coverage["arrivalTextContextReferences"], 1)
        self.assertEqual(coverage["retainedBodies"], 5)
        self.assertTrue(coverage["contextComplete"])

    def test_arrival_text_event_preserves_context_absent_from_journey(self):
        self.arrival_text_feed_fixture(event_only=True)
        coverage = self.manifest(self.capture())["feedResponseCoverage"]
        self.assertEqual(coverage["arrivalTextContextReferences"], 1)
        self.assertEqual(coverage["retainedBodies"], 5)
        self.assertTrue(coverage["contextComplete"])

    def test_arrival_text_and_first_arrival_tags_share_one_body(self):
        self.arrival_text_feed_fixture(same_receipt=True)
        coverage = self.manifest(self.capture())["feedResponseCoverage"]
        self.assertEqual(coverage["arrivalTextContextReferences"], 1)
        self.assertEqual(coverage["retainedBodies"], 4)
        self.assertTrue(coverage["contextComplete"])

    def test_arrival_text_unavailable_receipt_prevents_complete_context_claim(self):
        self.arrival_text_feed_fixture(unavailable=True)
        coverage = self.manifest(self.capture())["feedResponseCoverage"]
        self.assertFalse(coverage["contextComplete"])
        self.assertGreater(coverage["unavailableArrivalTextReferences"], 0)

    def test_arrival_text_context_keeps_existing_byte_budget(self):
        self.arrival_text_feed_fixture()
        with patch.object(evidence, "MAX_FEED_CONTEXT_BYTES", 1):
            coverage = self.manifest(self.capture())["feedResponseCoverage"]
        self.assertEqual(coverage["arrivalTextContextReferences"], 1)
        self.assertEqual(coverage["omittedByByteBudget"], 5)
        self.assertFalse(coverage["contextComplete"])

    def test_legacy_null_arrival_does_not_block_incident_capture(self):
        self.rows(self.watch / "journeys.jsonl", [{"id": "r1", "samples": 2,
                  "arrivalObservation": None, "arrivalTextContext": None}])
        self.rows(self.watch / "events.jsonl", [self.event, {**self.event, "kind": "arrived",
                  "detail": {"observation": None, "screen": None}}])
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


    def service_disclosure_fixture(self, *, event_only=False, unavailable=False):
        module = Path(__file__).resolve().parent.parent / "rider-watch/feed-evidence.mjs"
        source = ("import {retainFeedResponse} from " + json.dumps(module.as_uri()) + ";"
                  "const refs=[];for(let i=0;i<5;i++)refs.push(await retainFeedResponse(" + json.dumps(str(self.watch)) + ","
                  "{runId:'1234',body:Buffer.from(' '+JSON.stringify({buses:[],serviceControl:i})+'\\n'),receivedAt:1234+i*1000}));"
                  "process.stdout.write(JSON.stringify(refs));")
        refs = json.loads(subprocess.check_output(["node", "--input-type=module", "-e", source]))
        self.event = {**self.event, "runId": "1234", "kind": "candidate-pickup-service"}
        self.refs = {**self.refs, "runId": "1234"}
        self.rows(self.watch / "samples.jsonl", [{"runId": "1234", "feedResponse": refs[i]} for i in [0, 2, 4]])
        first = {"state": "unavailable", "runId": "1234", "reason": "raw-body-unavailable"} if unavailable else refs[1]
        observation = {"v": 1, "policy": {"routeLabel": "Purple", "stopId": 122},
                       "observations": [{"feedResponse": first}, {"feedResponse": refs[3]}]}
        journey = {"id": "1234", "samples": 3}
        if not event_only:
            journey["pickupServiceObservation"] = observation
        self.rows(self.watch / "journeys.jsonl", [journey])
        self.rows(self.watch / "events.jsonl", [{**self.event, "detail": observation}])
        return refs

    def test_service_disclosure_keeps_both_middle_confirmation_responses(self):
        refs = self.service_disclosure_fixture()
        receipt = self.capture()
        coverage = self.manifest(receipt)["feedResponseCoverage"]
        self.assertEqual(coverage["pickupServiceContextReferences"], 2)
        self.assertEqual(coverage["retainedBodies"], 4)
        self.assertEqual(coverage["omittedByContextSelection"], 1)
        self.assertTrue(coverage["contextComplete"])
        records = [json.loads(line) for line in gzip.decompress((Path(receipt["directory"]) / "feed-responses.jsonl.gz").read_bytes()).splitlines()]
        self.assertTrue({refs[1]["id"], refs[3]["id"]}.issubset({r["id"] for r in records}))
        for record in records:
            evidence.verify_feed_response(record)
        shutil.rmtree(self.watch / "feed-responses")
        self.assertEqual(evidence.verify_bundle(receipt["directory"]), receipt)

    def test_service_disclosure_event_survives_journey_without_observations(self):
        self.service_disclosure_fixture(event_only=True)
        coverage = self.manifest(self.capture())["feedResponseCoverage"]
        self.assertEqual(coverage["pickupServiceContextReferences"], 2)
        self.assertEqual(coverage["retainedBodies"], 4)
        self.assertTrue(coverage["contextComplete"])

    def test_service_disclosure_respects_existing_body_budget(self):
        self.service_disclosure_fixture()
        with patch.object(evidence, "MAX_FEED_CONTEXT_BYTES", 1):
            coverage = self.manifest(self.capture())["feedResponseCoverage"]
        self.assertEqual(coverage["pickupServiceContextReferences"], 2)
        self.assertEqual(coverage["omittedByByteBudget"], 4)
        self.assertFalse(coverage["contextComplete"])

    def test_unavailable_service_confirmation_body_is_explicit(self):
        self.service_disclosure_fixture(unavailable=True)
        coverage = self.manifest(self.capture())["feedResponseCoverage"]
        self.assertGreater(coverage["unavailablePickupServiceReferences"], 0)
        self.assertFalse(coverage["contextComplete"])



if __name__ == "__main__":
    unittest.main()
