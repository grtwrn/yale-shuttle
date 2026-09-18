"""Extract current shell and the frozen diagnostic without changing the app."""
from pathlib import Path
import hashlib, json
O=Path(__file__).resolve().parent
repo=Path('/home/gwarren/projects/yale-shuttle-watcher/overnight-eta-2026-09-17')
source=(repo/'services/shuttle-v2/web/src/TransitMap.tsx').read_text()
start=source.index('    return stableOptions.map((o) => {',source.index('const options: TripOption[] | null'))
end=source.index('\n    // eslint-disable-next-line',start)
template=(O.parent/'cycle-10/shell-current.generated.mts').read_text()
a=template.index('    return stableOptions.map((o) => {');b=template.index('\n };',a)
current=template[:a]+source[start:end]+template[b:]
assert current==template, 'current numerical block changed from prior reviewed current production'
needle='if (hereBus && cfg && effectiveWalkToSec <= dwellBoardWindowSec(hereBus, cfg.routeIds[0], o.boardStopId, dwellTimes)) {'
replacement=needle[:-3]+' && live.some(a => norm(a.busName) === norm(hereBus.bus_name) && a.stopsAhead === 0 && a.eta === 0)) {'
assert current.count(needle)==1
diagnostic=current.replace(needle,replacement)
for name,s in [('current',current),('diagnostic',diagnostic)]:
    (O/f'shell-{name}.generated.mts').write_text(s)
(O/'paired-source.json').write_text(json.dumps({'currentSha256':hashlib.sha256(current.encode()).hexdigest(),
    'diagnosticSha256':hashlib.sha256(diagnostic.encode()).hexdigest(),
    'transform':{'needle':needle,'replacement':replacement},'currentEqualsReviewedProduction':True},indent=2)+'\n')
print('Current shell extracted exactly; prior diagnostic guard applied once')
