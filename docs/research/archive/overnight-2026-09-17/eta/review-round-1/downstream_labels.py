"""Selected retrospective labels for the next trace, never forecast features."""
import json
from pathlib import Path
import sqlite3

ROOT=Path('/home/gwarren/projects/yale-shuttle-watcher')
TEAM=ROOT/'overnight-2026-09-17/eta'
manifest=json.loads((TEAM/'cycle-2/case-manifest.json').read_text())
db=sqlite3.connect('file:'+str(ROOT/'conditional-replay-data/outcomes.db')+'?mode=ro',uri=True)
db.row_factory=sqlite3.Row
result=[]
try:
    for case in manifest['selection']:
        if case['sourceStop']!=121:continue
        journey=next(j for j in case['journeys'] if j['target']==48)
        legs=[dict(db.execute('SELECT * FROM legs WHERE id=?',(lid,)).fetchone()) for lid in journey['legIds']]
        departure=next(l for l in legs if l['from_stop_id']==11)
        visits=db.execute('SELECT * FROM stop_visits WHERE bus_name=? AND route_id=3 AND stop_id=11 AND departed_at=?',
                          (departure['bus_name'],departure['departed_at'])).fetchall()
        assert len(visits)==1
        v=visits[0]
        result.append(dict(unionSourceId=case['sourceId'],winchesterVisitId=v['id'],
            winchesterPinnedHoldSec=(v['departed_at']-v['pinned_at'])/1000,
            winchesterAnchorToPinSec=(v['pinned_at']-v['anchored_at'])/1000,
            sourceDepartureToWinchesterPinSec=(v['pinned_at']-case['visit']['departed_at'])/1000,
            divisionTargetVisitId=journey['targetVisitId'],
            scope='Retrospective outcome accounting, never an input to earlier forecasts.'))
finally:db.close()
assert len(result)==5
(Path(__file__).resolve().parent/'downstream-winchester-labels.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps(result,indent=2))
