from pathlib import Path
import hashlib,json,subprocess
O=Path(__file__).resolve().parent
A=O.parent
repo=Path('/home/gwarren/projects/yale-shuttle-watcher/overnight-eta-2026-09-17')
plan=json.loads((O/'PLAN.json').read_text())
assert subprocess.check_output(['git','rev-parse','HEAD'],cwd=repo,text=True).strip()==plan['head']
for name,want in plan['inputHashes'].items():
    assert hashlib.sha256(Path(name).read_bytes()).hexdigest()==want,name
s=(repo/'services/shuttle-v2/web/src/TransitMap.tsx').read_text()
a=s.index('    return stableOptions.map((o) => {',s.index('const options: TripOption[] | null'))
b=s.index('\n    // eslint-disable-next-line',a)
block=s[a:b]
f=(A/'cycle-6/shell-baseline.generated.mts').read_text()
a=f.index('    return stableOptions.map((o) => {');b=f.index('\n };',a)
f=f[:a]+block+f[b:]
f=f.replace('{journeyArrival:actualJourney}', '{journeyArrival:actualJourney,atStopJourneyBoard}')
f=f.replace('walkFrom:number,now:number)=>', "walkFrom:number,now:number,pickupState:'forecast'|'at-stop'='forecast')=>")
f=f.replace('actualJourney(board,visits,target,walkTo,walkFrom,now)', 'actualJourney(board,visits,target,walkTo,walkFrom,now,pickupState)')
provenance=json.loads((O/'source-extraction.json').read_text())
assert hashlib.sha256(block.encode()).hexdigest()==provenance['exactNumericalBlockSha256']
assert hashlib.sha256(f.encode()).hexdigest()==provenance['generatedSha256']
(O/'shell-current.generated.mts').write_text(f)
print('Exact production numerical extraction and all frozen input hashes verified')
