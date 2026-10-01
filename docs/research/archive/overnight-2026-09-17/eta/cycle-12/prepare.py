from pathlib import Path
import difflib, hashlib, json, subprocess

out=Path(__file__).resolve().parent
repo=Path('/home/gwarren/projects/yale-shuttle-watcher/overnight-eta-2026-09-17')
web=repo/'services/shuttle-v2/web/src'
plan=json.loads((out/'PLAN.json').read_text())
assert subprocess.check_output(['git','rev-parse','HEAD'],cwd=repo,text=True).strip()==plan['head']
for name,want in plan['inputHashes'].items():
    assert hashlib.sha256(Path(name).read_bytes()).hexdigest()==want,name

def replace_once(s,old,new):
    assert s.count(old)==1,(old,s.count(old))
    return s.replace(old,new)

shell=(web/'TransitMap.tsx').read_text()
shell=replace_once(shell,'import { tripBusIdentity }', 'import { forecastPickupSelection, rawPickupSelection } from "./livePickupSelection";\nimport { tripBusIdentity }')
shell=replace_once(shell,'    if (isFutureMode) return stableOptions;', '    if (isFutureMode) return stableOptions.map(o => ({ ...o, livePickupSelection: undefined }));')
shell=replace_once(shell,'        if (!from || !toLL) return o;', '        if (!from || !toLL) return { ...o, livePickupSelection: undefined };')
shell=replace_once(shell,'return { ...o, totalSec, walkToSec: totalSec, directWalkSec: totalSec };','return { ...o, livePickupSelection: undefined, totalSec, walkToSec: totalSec, directWalkSec: totalSec };')
shell=replace_once(shell,'return { ...o, etaUnavailable: true, journeyArrival: undefined };','return { ...o, livePickupSelection: undefined, etaUnavailable: true, journeyArrival: undefined };')
shell=replace_once(shell,'          journeyArrival: arrival, busName: norm(hereBus.bus_name), departed: false,','          livePickupSelection: rawPickupSelection(hereBus.bus_name, o.boardStopId, nowMs),\n          journeyArrival: arrival, busName: norm(hereBus.bus_name), departed: false,')
assert shell.count('return { ...o, journeyArrival: undefined, departed: true };')==2
shell=shell.replace('return { ...o, journeyArrival: undefined, departed: true };','return { ...o, livePickupSelection: undefined, journeyArrival: undefined, departed: true };')
shell=replace_once(shell,'        journeyArrival: arrival, busName: match.busName, departed, missedBus,','        livePickupSelection: forecastPickupSelection(picked, nowMs),\n        journeyArrival: arrival, busName: match.busName, departed, missedBus,')
planner=(web/'planner.ts').read_text()
planner=replace_once(planner,"import type { JourneyArrival } from './journeyArrival';", "import type { JourneyArrival } from './journeyArrival';\nimport type { LivePickupSelection } from './livePickupSelection';")
planner=replace_once(planner,'  journeyArrival?: JourneyArrival;', '  journeyArrival?: JourneyArrival;\n  /** Existing countdown and selected boarding evidence, independent of destination availability. */\n  livePickupSelection?: LivePickupSelection;')
sources={'TransitMap.tsx':shell,'planner.ts':planner,'livePickupSelection.ts':(out/'livePickupSelection.ts').read_text()}
patch=''
for name,source in sources.items():
    (out/name).write_text(source)
    path='services/shuttle-v2/web/src/'+name
    old=(web/name).read_text() if (web/name).exists() else ''
    patch+=''.join(difflib.unified_diff(old.splitlines(True),source.splitlines(True),fromfile='a/'+path if old else '/dev/null',tofile='b/'+path))
(out/'eta-projection.patch').write_text(patch)
# Reuse the reviewed exact wrapper, replacing only the real numerical block.
generated=(out.parent/'cycle-10/shell-current.generated.mts').read_text()
a=shell.index('    return stableOptions.map((o) => {',shell.index('const options: TripOption[] | null'))
b=shell.index('\n    // eslint-disable-next-line',a)
block=shell[a:b]
c=generated.index('    return stableOptions.map((o) => {');d=generated.index('\n };',c)
generated=generated[:c]+block+generated[d:]
generated="import { forecastPickupSelection, rawPickupSelection } from './livePickupSelection.ts';\n"+generated
(out/'shell-candidate.generated.mts').write_text(generated)
# A second wrapper tests the actual future-mode guard, not a duplicate helper.
future=shell[shell.index('    const isFutureMode =',shell.index('const options: TripOption[] | null')):a]
(out/'future-guard.generated.mts').write_text('export function futureOptions(stableOptions:any[], targetDate:Date|null) {\n'+future+'\nreturn null;\n}\n')
manifest={str(web/name):{'artifact':str(out/name),'sha256':hashlib.sha256(src.encode()).hexdigest()} for name,src in sources.items()}
(out/'overlay.json').write_text(json.dumps(manifest,indent=2)+'\n')
(out/'source-extraction.json').write_text(json.dumps({'numericalBlockSha256':hashlib.sha256(block.encode()).hexdigest(),'generatedSha256':hashlib.sha256(generated.encode()).hexdigest()},indent=2)+'\n')
print('Prepared 3 virtual source modules and ETA-only patch; application checkout unchanged')
