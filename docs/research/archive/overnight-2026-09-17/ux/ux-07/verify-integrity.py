import hashlib
import json
import subprocess
from pathlib import Path

root = Path('/home/gwarren/projects/yale-shuttle-watcher/overnight-ux-2026-09-17')
artifact = Path(__file__).resolve().parent
base = '373505d5076f21a08de69d9587be9b2a55956642'
head = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root).decode().strip()
assert head == base, 'Builder HEAD must remain unchanged'
relative = 'services/shuttle-v2/web/src/TransitMap.tsx'
baseline = subprocess.check_output(['git', 'show', base+':'+relative], cwd=root).decode()
assert baseline == (artifact/'TransitMap.baseline.tsx').read_text()
current = (root/relative).read_text()
def block(s, start, end):
    return s[s.index(start):s.index(end, s.index(start))]
proof = {}
for label, start, end in [
    ('numerical_options', '  const options: TripOption[] | null = useMemo', '  // Origin and destination are the same place'),
    ('map_filter', '  const mapDrawnHidden = useMemo', '  // ── STOP-ARRIVAL ALERTS'),
]:
    before, after = block(baseline,start,end), block(current,start,end)
    assert before == after, label
    proof[label+'_sha256'] = hashlib.sha256(before.encode()).hexdigest()
# The poll keeps the same validation, arrival attachment, filters and state updates.
# Only separate presentation bookkeeping of success/failure was added.
start, end = '        // Rider counting rides along', '    // Adaptive cadence:'
before, after = block(baseline,start,end), block(current,start,end)
after = after.replace('        setBusSnapshotFailed(false);\n','').replace('          setBusSnapshotFailed(true);\n','')
assert before == after, 'poll behavior beyond presentation flag'
for name in ['planner.ts','journeyArrival.ts','arrivals.ts','etaSource.ts','liveUpdates.ts','mapFilter.ts','schedule.ts']:
    rel = 'services/shuttle-v2/web/src/'+name
    assert subprocess.check_output(['git','show',base+':'+rel],cwd=root) == (root/rel).read_bytes(),name
sources = {p: hashlib.sha256((root/p).read_bytes()).hexdigest() for p in [relative,'services/shuttle-v2/scripts/empty-service-check.mjs']}
subprocess.run(['git','diff','--check'],cwd=root,check=True)
subprocess.run(['git','diff','--cached','--exit-code'],cwd=root,check=True)
subprocess.run(['node','--check','services/shuttle-v2/scripts/empty-service-check.mjs'],cwd=root,check=True)
(artifact/'integrity.json').write_text(json.dumps({'head':head,'base':base,'sources':sources,**proof,'poll_only_adds_presentation_flag':True,'index_empty':True},indent=2)+'\n')
print('PASS: HEAD/source hashes, frozen baseline, unchanged numerical options/map filter/poll behavior/modules, empty index, syntax and whitespace')
