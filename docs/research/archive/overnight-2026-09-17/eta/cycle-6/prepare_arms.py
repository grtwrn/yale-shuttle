"""Reproduce declared shell transformations; no application source writes."""
from pathlib import Path
import hashlib,json
O=Path(__file__).resolve().parent; B=O.parent/'cycle-5/traversal-guard'
source=B/'shell-live.generated.mts'
plan=json.loads((O/'COUNTERFACTUAL_PLAN.json').read_text())
assert hashlib.sha256(source.read_bytes()).hexdigest()==plan['hashes'][str(source)]
s=source.read_text()
needle='const arrival = journeyArrival(board, visits, o.alightStopId, effectiveWalkToSec, o.walkFromSec, nowMs);'
replacement='''const firstDestination = visits.filter(a => norm(a.busName) === norm(hereBus.bus_name) && a.stopId === o.alightStopId).sort((a,b) => a.stopsAhead-b.stopsAhead)[0];
        const forecastBoard = board ?? live.filter(a => norm(a.busName) === norm(hereBus.bus_name) && firstDestination && a.stopsAhead < firstDestination.stopsAhead).sort((a,b) => a.stopsAhead-b.stopsAhead)[0];
        const arrival = journeyArrival(forecastBoard, visits, o.alightStopId, effectiveWalkToSec, o.walkFromSec, nowMs);'''
assert s.count(needle)==1
(O/'ordered-transform.json').write_text(json.dumps(dict(needle=needle,replacement=replacement),indent=2)+'\n')
results={'baseline':s,'ordered':s.replace(needle,replacement)}
needle='if (hereBus && cfg && effectiveWalkToSec <= dwellBoardWindowSec(hereBus, cfg.routeIds[0], o.boardStopId, dwellTimes)) {'
replacement=needle[:-3]+' && live.some(a => norm(a.busName) === norm(hereBus.bus_name) && a.stopsAhead === 0 && a.eta === 0)) {'
assert s.count(needle)==1
results['fallthrough']=s.replace(needle,replacement)
saved=json.loads((O/'prepare-arms.json').read_text())['sources']
for name,text in results.items():
    file=O/f'shell-{name}.generated.mts'
    assert hashlib.sha256(text.encode()).hexdigest()==saved[file.name]
    if file.exists():assert file.read_text()==text
    else:file.write_text(text)
print('All three exact generated arms verified; application source untouched.')
