"""Use unchanged audited scorer contracts; write only this experiment's outputs."""
from pathlib import Path
import sys,json,subprocess,hashlib
O=Path(sys.argv[1]).resolve();A=Path('/home/gwarren/projects/yale-shuttle-watcher/release-integration-data')
# Persist chronological partition identities used for prior deployment; both are reused evaluation now.
cut=1789665240913
fds={k:(O/f'full-{k}-pairs.jsonl').open('w') for k in ['development','reused-afternoon']}
old={ (r['at'],r['bus'],r['target'],r['stopsAhead']):r['candidate'] for r in map(json.loads,(A/'final-pairs.jsonl').open()) }
parity=0
for line in (O/'full-pairs.jsonl').open():
 r=json.loads(line);key=(r['at'],r['bus'],r['target'],r['stopsAhead'])
 assert r['baseline']==old[key],('current baseline differs from prior release ON',key,r['baseline'],old[key])
 parity+=1;fds['development' if r['at']<=cut else 'reused-afternoon'].write(line)
for f in fds.values():f.close()
(O/'full-baseline-parity.json').write_text(json.dumps(dict(exactPriorReleaseOnRows=parity,comparator='Both current-code baseline and candidate have release ON; comparison to archived candidate establishes prior release parity, not new baseline OFF.'),indent=2)+'\n')
for part in fds:
 cmd=['python','/home/gwarren/projects/yale-shuttle-watcher/red-window-data/full-path-score.py','--pairs',str(O/f'full-{part}-pairs.jsonl'),'--db',str(A/'outcomes-complete.db'),'--out',str(O/f'full-{part}-score.json'),'--min-warm-sec','600']
 with (O/f'full-{part}-score.log').open('w') as f:subprocess.run(cmd,stdout=f,stderr=subprocess.STDOUT,check=True)
s=(A/'final-next-occurrence-review.py').read_text()
s=s.replace("P=D/'final-pairs.jsonl'","P=D/'full-pairs.jsonl'")
s=s.replace("str(D/'outcomes-complete.db')",f"str(pathlib.Path('{A}/outcomes-complete.db'))")
s=s.replace("(D/'raw-complete-frames.jsonl').open()",f"(pathlib.Path('{A}/raw-complete-frames.jsonl')).open()")
s=s.replace("D/'final-next-occurrence-review.json'","D/'full-next-occurrence-review.json'")
(O/'score_next.py').write_text(s)
with (O/'full-next-occurrence.log').open('w') as f:subprocess.run(['python',str(O/'score_next.py')],stdout=f,stderr=subprocess.STDOUT,check=True)
print(json.dumps(dict(baselineParity=parity,firstScorers=['development','reused-afternoon'],secondScorer='full-next-occurrence-review.json')))
