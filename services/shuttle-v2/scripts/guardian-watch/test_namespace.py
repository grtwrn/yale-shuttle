import contextlib
import hashlib
import io
import json
import os
from pathlib import Path
import runpy
import selectors
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import evidence
import poll


class IndependentNamespaceTests(unittest.TestCase):
    def paths(self, root):
        root = Path(root)
        state = root / "guardian"
        state.mkdir()
        return dict(NAMESPACE="linux-arm64-rider-red-guardian-v1", WATCH=str(root / "rider"),
                    WATCH_RED=str(root / "rider-red"), STATE=str(state),
                    PENDING=str(state / "pending"), PROCESSED=str(state / "processed"),
                    BRIDGE=str(state / "bridge-state.json"), EVIDENCE=str(state / "evidence"))

    def incident(self, namespace, directory):
        state = {"open": {}}
        with patch.multiple(poll, NAMESPACE=namespace, PENDING=str(directory)), patch.object(poll, "retain_evidence"):
            poll.raise_incident(state, "candidate-pickup", "Red", 123.0, "Same observed event", {}, {}, {"kind": "candidate-pickup"})
        return json.loads(next(Path(directory).glob("*.json")).read_text())

    def test_legacy_incident_identity_and_classification_remain_unchanged(self):
        with tempfile.TemporaryDirectory() as root:
            incident = self.incident(None, root)
        self.assertEqual(incident["source"], "mac-rider-watcher")
        self.assertNotIn("namespace", incident)
        self.assertEqual(incident["id"], hashlib.sha1(b"candidate-pickup|Red|123.0").hexdigest()[:20])

    def test_same_event_in_two_independent_roles_has_distinct_ids_and_explicit_sources(self):
        with tempfile.TemporaryDirectory() as root:
            red = Path(root) / "red"; random = Path(root) / "random"
            red.mkdir(); random.mkdir()
            a = self.incident("linux-arm64-rider-red-guardian-v1", red)
            b = self.incident("linux-arm64-rider-random-guardian-v1", random)
        self.assertNotEqual(a["id"], b["id"])
        self.assertEqual(a["source"], "linux-arm64-rider-watcher")
        self.assertEqual(a["namespace"], "linux-arm64-rider-red-guardian-v1")
        self.assertEqual(b["namespace"], "linux-arm64-rider-random-guardian-v1")

    def test_namespace_refuses_legacy_or_other_role_offsets_without_mutating_them(self):
        for original in [{"offset": 32, "runs": {"old": "Red"}},
                         {"namespace": "linux-arm64-rider-random-guardian-v1", "source": "linux-arm64-rider-watcher", "offset": 99}]:
            state = dict(original)
            with patch.object(poll, "NAMESPACE", "linux-arm64-rider-red-guardian-v1"), self.assertRaisesRegex(ValueError, "another namespace"):
                poll.bind_namespace(state)
            self.assertEqual(state, original)

    def test_matching_namespace_preserves_existing_offsets_and_runs(self):
        state = {}
        with patch.object(poll, "NAMESPACE", "linux-arm64-rider-red-guardian-v1"):
            poll.bind_namespace(state)
            state.update(offset=47, runs={"own": "Red"})
            poll.bind_namespace(state)
        self.assertEqual(state["offset"], 47)
        self.assertEqual(state["runs"], {"own": "Red"})
        with patch.object(poll, "NAMESPACE", None), self.assertRaisesRegex(ValueError, "explicit role"):
            poll.bind_namespace(state)

    def test_opt_in_requires_known_role_and_explicit_absolute_paths(self):
        for values in [
            {"GUARDIAN_NAMESPACE": "other-role"},
            {"GUARDIAN_NAMESPACE": "linux-arm64-rider-red-guardian-v1"},
            {"GUARDIAN_NAMESPACE": "linux-arm64-rider-red-guardian-v1",
             "GUARDIAN_STATE": "relative", "GUARDIAN_WATCH": "/private/rider"},
        ]:
            with patch.dict(os.environ, values, clear=True), self.assertRaises(ValueError):
                runpy.run_path(poll.__file__, run_name="guardian_namespace_config_test")

    def test_corrupt_or_unmarked_bridge_refuses_before_filesystem_mutation(self):
        for raw in [b'{"offset":', b'{}', b'{"offset":47,"runs":{"old":"Red"}}']:
            with tempfile.TemporaryDirectory() as root:
                values = self.paths(root)
                bridge = Path(values["BRIDGE"]); bridge.write_bytes(raw)
                log = Path(values["STATE"]) / "monitor.log"
                log.write_bytes(b"x" * (poll.MONITOR_LOG_BYTES + 1))
                before = {p.name: p.read_bytes() for p in Path(values["STATE"]).iterdir()}
                with patch.multiple(poll, **values), self.assertRaises(ValueError):
                    poll.main()
                self.assertEqual(before, {p.name: p.read_bytes() for p in Path(values["STATE"]).iterdir()})

    def test_legacy_or_other_role_queue_cannot_seed_a_new_namespace(self):
        for folder, incident in [
            ("pending", {"source": "mac-rider-watcher"}),
            ("processed", {"namespace": "linux-arm64-rider-random-guardian-v1",
                           "source": "linux-arm64-rider-watcher"}),
        ]:
            with tempfile.TemporaryDirectory() as root:
                values = self.paths(root)
                queue = Path(values["STATE"]) / folder; queue.mkdir()
                file = queue / "old.json"; file.write_text(json.dumps(incident))
                original = file.read_bytes()
                with patch.multiple(poll, **values), self.assertRaisesRegex(ValueError, "another namespace"):
                    poll.main()
                self.assertEqual(file.read_bytes(), original)
                self.assertFalse(Path(values["BRIDGE"]).exists())
                self.assertFalse((Path(values["STATE"]) / "monitor.lock").exists())

    def test_matching_bridge_cannot_follow_an_open_incident_outside_its_queue(self):
        with tempfile.TemporaryDirectory() as root:
            values = self.paths(root)
            bridge = {"namespace": values["NAMESPACE"], "source": "linux-arm64-rider-watcher",
                      "offset": 10, "open": {"old": {"path": str(Path(root) / "other" / "incident.json"), "lastAt": 1}}}
            Path(values["BRIDGE"]).write_text(json.dumps(bridge))
            original = Path(values["BRIDGE"]).read_bytes()
            with patch.multiple(poll, **values), self.assertRaisesRegex(ValueError, "outside its own queue"):
                poll.run_once()
            self.assertEqual(Path(values["BRIDGE"]).read_bytes(), original)
            self.assertFalse(Path(values["PENDING"]).exists())

    def test_matching_labels_do_not_allow_corrupt_consumed_state_to_mutate_files(self):
        variants = [
            {"offset": "bad"}, {"offset": -1}, {"runs": []}, {"open": []},
            {"red": {"offset": "bad", "runs": {}}}, {"red": []},
            {"red": {"offset": 0, "runs": []}}, {"since": float("nan")},
            {"open": {"bad": {"path": "/unused/incident.json", "lastAt": float("inf")}}},
        ]
        for change in variants:
            with self.subTest(change=change), tempfile.TemporaryDirectory() as root:
                values = self.paths(root)
                Path(values["WATCH_RED"]).mkdir()
                (Path(values["WATCH_RED"]) / "events.jsonl").write_text("")
                bridge = {"namespace": values["NAMESPACE"], "source": "linux-arm64-rider-watcher",
                          "offset": 0, "runs": {}, "open": {}, "red": {"offset": 0, "runs": {}}}
                bridge.update(change)
                Path(values["BRIDGE"]).write_text(json.dumps(bridge))
                state = Path(values["STATE"])
                (state / "monitor.log").write_bytes(b"x" * (poll.MONITOR_LOG_BYTES + 1))
                before = {p.name: p.read_bytes() for p in state.iterdir()}
                with patch.multiple(poll, **values), self.assertRaises(ValueError):
                    poll.main()
                self.assertEqual(before, {p.name: p.read_bytes() for p in state.iterdir()})

    def test_red_only_mount_keeps_absent_general_unknown_and_scans_new_red_events(self):
        with tempfile.TemporaryDirectory() as root:
            root = Path(root); watch = root / "rider"; red = root / "rider-red"; red.mkdir()
            state = root / "guardian"; state.mkdir()
            values = dict(NAMESPACE="linux-arm64-rider-red-guardian-v1", WATCH=str(watch), WATCH_RED=str(red),
                          STATE=str(state), PENDING=str(state / "pending"), PROCESSED=str(state / "processed"),
                          BRIDGE=str(state / "bridge-state.json"), EVIDENCE=str(state / "evidence"))
            with contextlib.redirect_stdout(io.StringIO()), patch.multiple(poll, **values), patch.object(poll, "check_health"), patch.object(poll, "backfill_pending"), \
                 patch.object(poll, "maintain_bundles", return_value={}), patch.object(poll, "retain_evidence"), patch.object(poll, "now", return_value=100):
                self.assertEqual(poll.run_once(), 0)  # Prime BEFORE any rider event.
                event = {"at": poll.iso(101), "kind": "candidate-pickup", "line": "Red", "runId": "new-red", "detail": {"text": "Review"}}
                (red / "events.jsonl").write_text(json.dumps(event) + "\n")
                with patch.object(poll, "now", return_value=102):
                    self.assertEqual(poll.run_once(), 0)
            bridge = json.loads((state / "bridge-state.json").read_text())
            incident = json.loads(next((state / "pending").glob("*.json")).read_text())
            self.assertEqual(bridge["offset"], 0)
            self.assertEqual(bridge["red"]["offset"], (red / "events.jsonl").stat().st_size)
            self.assertEqual(incident["line"], "Red")
            self.assertEqual(incident["namespace"], "linux-arm64-rider-red-guardian-v1")
            self.assertEqual(bridge["riderFeedHealth"][str(watch)]["state"], "unknown")
            self.assertFalse(watch.exists())

    @unittest.skipUnless(sys.platform == "linux", "Node PID fixture requires admitted Linux execution")
    def test_live_node_writer_lock_is_never_removed_by_linux_guardian(self):
        # Execute only under the separately admitted Linux Node22 qualification.
        node = os.environ.get("GUARDIAN_NODE", "node")
        with tempfile.TemporaryDirectory() as root:
            lock = Path(root) / "storage.lock"
            source = "const fs=require('node:fs');if(process.platform!=='linux'||process.versions.node.split('.')[0]!=='22')throw Error('Linux Node22 required');fs.writeFileSync(process.argv[1],String(process.pid),{flag:'wx'});console.log(process.pid);process.stdin.resume();process.stdin.on('end',()=>process.exit(0));"
            child = subprocess.Popen([node, "-e", source, str(lock)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            selector = selectors.DefaultSelector()
            try:
                selector.register(child.stdout, selectors.EVENT_READ)
                self.assertTrue(selector.select(2), "Node lock fixture did not become ready")
                self.assertEqual(int(child.stdout.readline(64)), child.pid)
                inode = lock.stat().st_ino
                with self.assertRaises(TimeoutError):
                    with evidence.rider_lock(root, timeout=0.01):
                        self.fail("Guardian must wait for a live writer")
                self.assertEqual(lock.stat().st_ino, inode)
                self.assertEqual(lock.read_text(), str(child.pid))
            finally:
                child.stdin.close()
                try: child.wait(timeout=2)
                except subprocess.TimeoutExpired: child.kill(); child.wait(timeout=2)
                selector.close(); child.stdout.close(); child.stderr.close()


@unittest.skipUnless(os.environ.get("GUARDIAN_INTEGRATION_WATCH"), "Separate same-CID docker exec fixture")
class GuardianPidNamespaceIntegration(unittest.TestCase):
    def test_docker_exec_guardian_preserves_the_existing_node_writer_lock(self):
        self.assertEqual(sys.platform, "linux")
        watch = Path(os.environ["GUARDIAN_INTEGRATION_WATCH"])
        lock = watch / "storage.lock"
        raw = lock.read_bytes()
        self.assertLessEqual(len(raw), 64)
        owner = int(raw)
        self.assertGreater(owner, 1)
        self.assertNotEqual(owner, os.getpid())
        self.assertEqual(os.readlink("/proc/self/ns/pid"), os.readlink(f"/proc/{owner}/ns/pid"))
        self.assertEqual(os.readlink(f"/proc/{owner}/exe"), "/usr/local/bin/node")
        os.kill(owner, 0)
        before = lock.stat()
        with self.assertRaises(TimeoutError):
            with evidence.rider_lock(watch, timeout=0.01):
                self.fail("docker exec Guardian must honor the existing guest Node PID")
        self.assertEqual(lock.stat().st_ino, before.st_ino)
        self.assertEqual(lock.read_bytes(), raw)
        os.kill(owner, 0)


if __name__ == "__main__":
    unittest.main()
