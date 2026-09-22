"""Hosted watchdog: aggregate process-tree RSS, whole-workspace scratch, deadline."""
import json
import os
from pathlib import Path
import signal
import subprocess
import time

RSS_LIMIT = 2 * 1024**3
SCRATCH_LIMIT = 8 * 1024**3
SECONDS_LIMIT = 90 * 60


def processes():
    rows = {}
    for path in Path('/proc').glob('[0-9]*/stat'):
        try:
            # comm may contain spaces or ')'; remaining numeric fields are
            # indexed from the last closing parenthesis.
            fields = path.read_text().rsplit(')',1)[1].split()
            rows[int(path.parent.name)] = (int(fields[1]), int(fields[2]), int(fields[21])*os.sysconf('SC_PAGE_SIZE'))
        except (OSError, ValueError, IndexError):
            pass
    return rows


def tree_rss(root_pid, group_pid, coordinator):
    rows = processes()
    included = {root_pid, coordinator}
    included.update(pid for pid,(_,group,_) in rows.items() if group == group_pid)
    changed = True
    while changed:
        more = {pid for pid,(parent,_,_) in rows.items() if parent in included}
        changed = not more <= included
        included |= more
    return sum(rows[pid][2] for pid in included if pid in rows), len(included & rows.keys())


def tree_bytes(root):
    seen, total = set(), 0
    for directory, _, files in os.walk(root):
        for name in files:
            try:
                stat = (Path(directory)/name).stat(follow_symlinks=False)
                identity = (stat.st_dev,stat.st_ino)
                if identity not in seen:
                    total += stat.st_blocks*512
                    seen.add(identity)
            except OSError:
                pass
    return total


def run(command, cwd, scratch, report, env=None, seconds=SECONDS_LIMIT,
        rss_limit=RSS_LIMIT, scratch_limit=SCRATCH_LIMIT):
    began = time.monotonic()
    child = subprocess.Popen(command,cwd=cwd,env=env,start_new_session=True)
    result = dict(command=command,peakAggregateRssBytes=0,peakProcesses=0,peakScratchBytes=0,
                  rssLimit=rss_limit,scratchLimit=scratch_limit,deadlineSeconds=seconds,
                  rssSamplingSeconds=.1,scratchSamplingSeconds=2,limitViolation=None)
    next_disk = 0
    while child.poll() is None:
        now = time.monotonic()
        rss, count = tree_rss(child.pid,child.pid,os.getpid())
        result['peakAggregateRssBytes'] = max(result['peakAggregateRssBytes'],rss)
        result['peakProcesses'] = max(result['peakProcesses'],count)
        if now >= next_disk:
            result['peakScratchBytes'] = max(result['peakScratchBytes'],tree_bytes(scratch))
            next_disk = time.monotonic()+2
        reason = ('aggregate-rss' if rss > rss_limit else
                  'scratch' if result['peakScratchBytes'] > scratch_limit else
                  'deadline' if now-began > seconds else None)
        if reason:
            result['limitViolation'] = reason
            os.killpg(child.pid,signal.SIGKILL)
            break
        time.sleep(.1)
    result['exitCode'] = child.wait()
    result['elapsedSeconds'] = time.monotonic()-began
    result['peakScratchBytes'] = max(result['peakScratchBytes'],tree_bytes(scratch))
    if result['peakScratchBytes'] > scratch_limit:
        result['limitViolation'] = 'scratch'
    Path(report).write_text(json.dumps(result,indent=2)+'\n')
    if result['exitCode'] or result['limitViolation']:
        raise RuntimeError('Hosted workload failed: '+str(result))
    return result
