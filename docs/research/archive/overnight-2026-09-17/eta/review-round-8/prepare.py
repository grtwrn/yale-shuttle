from pathlib import Path
import json,hashlib,subprocess
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
candidate=candidate.replace('walkFrom:number,now:number)=>', 'walkFrom:number,now:number,pickupState?: \'forecast\' | \'at-stop\')=>').replace('walkTo,walkFrom,now);', 'walkTo,walkFrom,now,pickupState);')
(O/'shell-candidate.generated.mts').write_text(candidate)
(O/'source-extraction.json').write_text(json.dumps({'source_sha256':hashlib.sha256(s.encode()).hexdigest(),'block_sha256':hashlib.sha256(block.encode()).hexdigest(),'candidate_sha256':hashlib.sha256(candidate.encode()).hexdigest()},indent=2)+'\n')
# Freeze the supplied head as a separate comparator, including its helper.
base='1b66a1914a92a79c0936cf65473617cf7b7695f9'
read_base=lambda path:subprocess.check_output(['git','show',base+':'+path],cwd=repo).decode()
head=read_base('services/shuttle-v2/web/src/TransitMap.tsx')
start=head.index('    return stableOptions.map((o) => {',head.index('const options: TripOption[] | null'))
end=head.index('\n    // eslint-disable-next-line',start)
a=candidate.index('    return stableOptions.map((o) => {');b=candidate.index('\n };',a)
baseline=(candidate[:a]+head[start:end]+candidate[b:]).replace("await load('journeyArrival.ts')", "await import('./head-journeyArrival.generated.mts')")
(O/'shell-head.generated.mts').write_text(baseline)
(O/'head-journeyArrival.generated.mts').write_text(read_base('services/shuttle-v2/web/src/journeyArrival.ts'))
