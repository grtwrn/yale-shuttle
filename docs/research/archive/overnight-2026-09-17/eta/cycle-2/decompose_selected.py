"""Outcome-only connected-time accounting for frozen selected cases, read-only."""
import json
from pathlib import Path
import sqlite3
OUT=Path(__file__).resolve().parent
ROOT=Path('/home/gwarren/projects/yale-shuttle-watcher')
manifest=json.loads((OUT/'case-manifest.json').read_text())
db=sqlite3.connect('file:'+str(ROOT/'conditional-replay-data/outcomes.db')+'?mode=ro',uri=True);db.row_factory=sqlite3.Row
result=[]
for case in manifest['selection']:
    v=case['visit'];source_hold=(v['departed_at']-v['pinned_at'])/1000
    decomposition=[]
    for j in case['journeys']:
        legs=[dict(db.execute('SELECT * FROM legs WHERE id=?',(lid,)).fetchone()) for lid in j['legIds']]
        assert legs[0]['departed_at']==v['departed_at']
        # Exact elapsed intervals, not legacy dwell subtraction or speed inference.
        legs_sec=sum((l['arrived_at']-l['departed_at'])/1000 for l in legs)
        between=[(b['departed_at']-a['arrived_at'])/1000 for a,b in zip(legs,legs[1:])]
        final_adjustment=(j['targetArrivedAt']-legs[-1]['arrived_at'])/1000
        total=(j['targetArrivedAt']-v['pinned_at'])/1000
        assert abs(total-(source_hold+legs_sec+sum(between)+final_adjustment))<1e-8
        decomposition.append(dict(target=j['target'],targetOutcome=j['targetOutcome'],totalObservedSec=total,
            sourcePinnedHoldSec=source_hold,legElapsedSec=legs_sec,betweenLegResidenceSec=sum(between),
            endpointTimestampAdjustmentSec=final_adjustment,legIds=j['legIds'],
            departureErrors=[dict(checkpointSec=r['checkpointSec'],predicted=r['candidate']['eta'],actual=r['truthSec'],
            errorPredictedMinusActual=r['candidate']['eta']-r['truthSec']) for r in case['allCheckpoints']
            if r['target']==j['target'] and r['phase']=='departure']))
    result.append(dict(sourceId=v['id'],sourceStop=v['stop_id'],pinnedHoldSec=source_hold,
        pinMinusBroadRestSec=sorted({r['pinMinusRestOriginSec'] for r in case['pinCheckpoints'] if r['pinMinusRestOriginSec'] is not None}),
        restedAtPin=any(r['rested'] for r in case['pinCheckpoints']),journeys=decomposition))
db.close()
(OUT/'connected-time-decomposition.json').write_text(json.dumps(result,indent=2)+'\n')
for r in result:
 print(json.dumps(dict(sourceId=r['sourceId'],sourceStop=r['sourceStop'],pinnedHoldSec=r['pinnedHoldSec'],pinMinusBroadRestSec=r['pinMinusBroadRestSec'],
 departureErrorAt0=[dict(target=j['target'],errors=[e['errorPredictedMinusActual'] for e in j['departureErrors'] if e['checkpointSec']==0]) for j in r['journeys']])))
