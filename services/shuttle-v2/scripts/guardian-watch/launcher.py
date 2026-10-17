#!/usr/bin/env python3
"""Stable launchd entrypoint for the reviewed repository monitor."""
from pathlib import Path
import os
import runpy
import sys

root = Path(os.environ.get("YALE_SHUTTLE_ROOT", Path.home() / "projects/yale-shuttle-watcher"))
script = root / "services/shuttle-v2/scripts/guardian-watch/poll.py"
sys.path.insert(0, str(script.parent))
runpy.run_path(str(script), run_name="__main__")
