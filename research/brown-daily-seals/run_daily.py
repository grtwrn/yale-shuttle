"""The only hosted workload entrypoint; aggregate limits include child workers."""
import os
from pathlib import Path
import sys
from contract import HERE,ROOT,require
from resource_guard import run

if __name__=='__main__':
    require(os.environ.get('GITHUB_ACTIONS')=='true','hosted only')
    (HERE/'results').mkdir(exist_ok=True)
    run([sys.executable,str(HERE/'sealing.py'),*sys.argv[1:]],ROOT,ROOT,HERE/'results/resources.json',
        seconds=55*60,rss_limit=6*1024**3,scratch_limit=12*1024**3)
