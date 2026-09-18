from pathlib import Path
import json,hashlib
O=Path(__file__).resolve().parent
C=O.parent/'cycle-6'
repo=Path('/home/gwarren/projects/yale-shuttle-watcher/overnight-eta-2026-09-17')
s=(repo/'services/shuttle-v2/web/src/TransitMap.tsx').read_text()
start=s.index('    return stableOptions.map((o) => {',s.index('const options: TripOption[] | null'))
end=s.index('\n    // eslint-disable-next-line',start)
block=s[start:end]
f=(C/'shell-baseline.generated.mts').read_text()
a=f.index('    return stableOptions.map((o) => {');b=f.index('\n };',a)
# Keep instrumentation and shell wrapper, extract numerical code from the candidate source.
candidate=f[:a]+block+f[b:]
candidate=candidate.replace('{journeyArrival:actualJourney}', '{journeyArrival:actualJourney,atStopJourneyBoard}')
(O/'shell-candidate.generated.mts').write_text(candidate)
(O/'source-extraction.json').write_text(json.dumps({'source_sha256':hashlib.sha256(s.encode()).hexdigest(),'block_sha256':hashlib.sha256(block.encode()).hexdigest(),'candidate_sha256':hashlib.sha256(candidate.encode()).hexdigest()},indent=2)+'\n')
for name in ['browser_ordered.mjs','browser_ordered_transitions.mjs']:
 t=(C/name).read_text().replace("const reportOut='"+str(C)+"';", "const reportOut='"+str(O)+"';")
 t=t.replace("reportOut+'/ordered-browser-decisions.jsonl'", "'"+str(C)+"/ordered-browser-decisions.jsonl'")
 t=t.replace("reportOut+'/ordered-dist'+file", "service+'/web/dist'+file")
 (O/name).write_text(t)
