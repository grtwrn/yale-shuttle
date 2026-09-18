"""Bounded saved-output and read-only raw-record audit; no fitting or replay."""
from pathlib import Path
import datetime as dt
import json
import math
import sqlite3
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent
db = sqlite3.connect(f'file:{ROOT / "outcomes.db"}?mode=ro', uri=True)
db.row_factory = sqlite3.Row
tz = ZoneInfo('America/New_York')
score = json.loads((ROOT/'score-core.json').read_text())
cohort = {e['id']: e for f in ('cohort.json', 'extension-cohort.json')
          for e in json.loads((ROOT.parent/'own-history'/f).read_text())}
stops = {r['id']: dict(r) for r in db.execute('select * from stops')}


def visit(i):
    return dict(db.execute('select * from stop_visits where id=?', (i,)).fetchone())


def distance(a, b):
    p, q = math.radians(a['lat']), math.radians(b['lat'])
    h = math.sin((q-p)/2)**2 + math.cos(p)*math.cos(q)*math.sin(math.radians(b['lon']-a['lon'])/2)**2
    return 6371000*2*math.asin(min(1, math.sqrt(h)))


def audit(v):
    a = v['pinned_at'] or v['anchored_at']; d = v['departed_at']
    rows = [dict(r) for r in db.execute('select * from raw_positions where bus_name=? and collected_at between ? and ? order by collected_at',
                                      (v['bus_name'], a-30000, d+30000))]
    inside = [r for r in rows if a <= r['collected_at'] <= d]
    longest = run = 0
    for x, y in zip(inside, inside[1:]):
        run = run+(y['collected_at']-x['collected_at'])/1000 if (x['lat'],x['lon']) == (y['lat'],y['lon']) else 0
        longest = max(longest, run)
    final = next((r for r in reversed(rows) if r['collected_at'] <= d), None)
    moved = next((r for r in rows if r['collected_at'] > d and final and distance(final, r) > 15), None)
    inbound = [dict(r) for r in db.execute('select * from legs where bus_name=? and to_stop_id=? and to_pinned_at=?',
                                         (v['bus_name'], v['stop_id'], v['pinned_at']))]
    previous = db.execute('select * from raw_positions where bus_name=? and collected_at<? order by collected_at desc limit 1',
                          (v['bus_name'], a)).fetchone()
    previous = dict(previous) if previous else None
    return dict(visit=v, pinET=dt.datetime.fromtimestamp(a/1000,tz).isoformat(), pinToDepartureSec=(d-a)/1000,
                rawRows=len(inside), routeIds=sorted({r['route_id'] for r in rows}), busIds=sorted({r['bus_id'] for r in rows}),
                maxGapSec=max(((y['collected_at']-x['collected_at'])/1000 for x,y in zip(rows,rows[1:])),default=None),
                longestExactCoordinatePlateauSec=longest,
                minimumDistanceToStopM=min((distance(r,stops[v['stop_id']]) for r in inside),default=None),
                firstFinalMovementAfterDepartureSec=(moved['collected_at']-d)/1000 if moved else None,
                lastRawBeforePin=previous, gapFromPreviousRawSec=(a-previous['collected_at'])/1000 if previous else None,
                inboundLegs=inbound,
                finalRaw=[r for r in rows if d-15000 <= r['collected_at'] <= d+20000])


result = dict(method='Read-only audit of preselected largest regressions and jump threshold crossings. No exclusions or refits.', cases=[])
for sid in (71451, 67062, 64725):
    e = cohort[sid]; s = visit(sid); prior = e['histories']['primary']['latest']['11']
    paths = []
    for j in score['journeys']:
        if j['sourceId'] != sid: continue
        legs = [dict(db.execute('select * from legs where id=?',(i,)).fetchone()) for i in j['legIds']]
        assert legs[0]['departed_at'] == s['departed_at']
        intermediate = []
        for first, second in zip(legs,legs[1:]):
            assert first['to_stop_id'] == second['from_stop_id'] and first['to_index'] == second['from_index']
            vs = [dict(r) for r in db.execute('select * from stop_visits where bus_name=? and route_id=3 and stop_id=? and stop_index=? and arrived_at=? and departed_at=?',
                   (s['bus_name'],first['to_stop_id'],first['to_index'],first['arrived_at'],second['departed_at']))]
            assert len(vs) == 1
            assert vs[0]['how'] != 'gap'
            intermediate += vs
        target = visit(j['targetVisitId'])
        assert legs[-1]['arrived_at'] == target['arrived_at']
        assert all(l['bus_name'] == s['bus_name'] and l['route_id'] == 3 for l in legs)
        paths.append(dict(journey=j,legs=legs,intermediateVisits=intermediate,target=audit(target),
                          departureToTargetSec=(target['arrived_at']-s['departed_at'])/1000))
    result['cases'].append(dict(sourceId=sid,source=audit(s),priorWinchester=audit(visit(prior['id'])),priorFeature=prior,
                               ownUnionAgeSec=e['ownUnionAge'],lapSec=e['lap'],paths=paths,
                               largestRegressionCheckpoints=[r for r in score['largestRegressions'] if r['sourceId']==sid]))

result['newDownwardThresholdCrossings'] = [j for j in score['jumps'] if j['target']==48 and j['candidate'] < -60 <= j['baseline']]
result['avoidedDownwardThresholdCrossings'] = [j for j in score['jumps'] if j['target']==48 and j['baseline'] < -60 <= j['candidate']]
result['continuousEarlyCases'] = []
for arm in json.loads((ROOT/'continuous.json').read_text())['data']:
    for j in arm['journeys']:
        if 'arrivalExcessSec' not in j.get('baseline',{}): continue
        b=j['baseline']['arrivalExcessSec']['value']; c=j['candidate']['arrivalExcessSec']['value']
        if b <= 0 < c or c > 15:
            result['continuousEarlyCases'].append(dict(comparator=arm['label'],journey=j))

(ROOT/'independent-case-audit.json').write_text(json.dumps(result,indent=2)+'\n')
for c in result['cases']:
    print('source',c['sourceId'])
    for label,v in [('source',c['source']),('prior',c['priorWinchester'])] + [('target',p['target']) for p in c['paths']]:
        print(label,v['visit']['id'],'hold',v['pinToDepartureSec'],'stand',v['visit']['stand_sec'],'raw',v['rawRows'],
              'gap',v['maxGapSec'],'plateau',v['longestExactCoordinatePlateauSec'],'moveAfter',v['firstFinalMovementAfterDepartureSec'],
              'inbound',[r['id'] for r in v['inboundLegs']])
    print('target journeys',[(p['journey']['target'],p['departureToTargetSec'],p['journey']['legIds']) for p in c['paths']])
db.close()
