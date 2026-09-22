import json
from pathlib import Path
import sys
import tempfile
import unittest
from resource_guard import run
from benchmark import expected, reconcile


class ResourceGuardTests(unittest.TestCase):
    def test_aggregate_children_not_only_coordinator(self):
        # Deliberately two toy children, never concurrent React sessions. Each
        # allocation is below the test cap; their aggregate must trip it.
        with tempfile.TemporaryDirectory() as root:
            child='import time; a=bytearray(40*1024**2); time.sleep(10)'
            parent=f'import subprocess,sys; p=[subprocess.Popen([sys.executable,"-c",{child!r}]) for _ in range(2)]; [x.wait() for x in p]'
            report=Path(root)/'report.json'
            with self.assertRaises(RuntimeError):
                run([sys.executable,'-c',parent],root,root,report,rss_limit=95*1024**2,seconds=5)
            result=json.loads(report.read_text())
            self.assertEqual(result['limitViolation'],'aggregate-rss')
            self.assertGreaterEqual(result['peakProcesses'],4)

    def test_scratch_is_enforced(self):
        with tempfile.TemporaryDirectory() as root:
            report=Path(root)/'report.json'
            code='from pathlib import Path; import time; Path("large").write_bytes(b"x"*2*1024**2); time.sleep(5)'
            with self.assertRaises(RuntimeError):
                run([sys.executable,'-c',code],root,root,report,scratch_limit=1024**2,seconds=4)
            self.assertEqual(json.loads(report.read_text())['limitViolation'],'scratch')

    def test_failed_shard_retains_every_assigned_denominator(self):
        with tempfile.TemporaryDirectory() as root:
            root=Path(root);assigned=expected('full',1)
            self.assertEqual(len(assigned),2016)
            result=reconcile(root,assigned,'synthetic resource failure')
            self.assertFalse(result['success']);self.assertEqual(result['missingKeys'],2016)
            rows=[json.loads(line) for line in (root/'denominators.jsonl').read_text().splitlines()]
            self.assertEqual({r['id'] for r in rows},{r['id'] for r in assigned})


if __name__ == '__main__':
    unittest.main(verbosity=2)
