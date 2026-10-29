#!/usr/bin/env python3
"""Keep a host-kernel lease out of all children and supervise the controller."""
import fcntl
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import json

service = Path(__file__).resolve().parents[2]
root = Path(os.environ.get("LEARNING_DIR", str(service / "scripts/.learning-loop"))).resolve()
root.mkdir(parents=True, exist_ok=True)
fd = os.open(root / "host-runtime.lock", os.O_CREAT | os.O_RDWR, 0o600)
try:
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
except BlockingIOError:
    print("Learning runtime supervisor is already running", file=sys.stderr)
    os.close(fd)
    sys.exit(1)
node = os.environ.get("LEARNING_HOST_NODE") or shutil.which("node")
if not node:
    raise RuntimeError("Host Node executable is unavailable")
os.ftruncate(fd, 0)
os.write(fd, (json.dumps({"v": 1, "leasePid": os.getpid(), "launcher": str(Path(__file__).resolve())}) + "\n").encode())
env = dict(os.environ, LEARNING_HOST_LEASE_PID=str(os.getpid()))
child = subprocess.Popen([node, str(Path(__file__).with_name("start.mjs"))], env=env, close_fds=True)
def forward(signum, _frame):
    if child.poll() is None:
        child.send_signal(signum)
signal.signal(signal.SIGTERM, forward)
signal.signal(signal.SIGINT, forward)
try:
    result = child.wait()
finally:
    os.close(fd)
sys.exit(result if result >= 0 else 128 - result)
