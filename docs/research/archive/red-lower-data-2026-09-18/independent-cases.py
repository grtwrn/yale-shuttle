"""Read-only audit of lower-bound regressions; no fitting or forecast reruns."""
import collections, datetime, hashlib, json, math, pathlib, sqlite3
from zoneinfo import ZoneInfo

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parent
COORDS = json.loads((ROOT / 'red-eta-data/payload.json').read_text())['stop_coords']
TZ = ZoneInfo('America/New_York')

def distance(a, b):
    lat1, lat2 = map(math.radians, [a['lat'], b['lat']])
    dlat = lat2-lat1
    dlon = math.radians(b['lon']-a['lon'])
    h = math.sin(dlat/2)**2 + math.cos(lat1)*math.cos(lat2)*math.sin(dlon/2)**2
    return 6371000*2*math.asin(min(1, math.sqrt(h)))

def audit(label, score_path, db_path, selected):
    score = json.loads(score_path.read_text())
    db = sqlite3.connect('file:'+str(db_path)+'?mode=ro', uri=True)
    db.row_factory = sqlite3.Row
    events = [x for x in score['checkpoints'] if x['sourceStop']==11]
    result = {'data': label, 'cases': [], 'groups': []}
    for s in score['scores']:
        if s['sourceStop'] != 11 or s['phase'] == 'approach': continue
        rows = [x for x in events if (x['target'],x['phase'],x['checkpointSec']) == (s['target'],s['phase'],s['checkpointSec'])]
        metrics = {}
        for arm in ['baseline','candidate']:
            metrics[arm] = {k:s['allObserved'][arm][k] for k in ['n','meanWidthSec','WIS','early','late']}
            metrics[arm]['earlyByMoreThan60'] = sum(x[arm]['low']-x['truthSec']>60 for x in rows)
        result['groups'].append({**{k:s[k] for k in ['target','phase','checkpointSec']}, **metrics})
    for journey in score['journeys']:
        if journey['sourceId'] not in selected: continue
        source = dict(db.execute('SELECT * FROM stop_visits WHERE id=?',(journey['sourceId'],)).fetchone())
        target = dict(db.execute('SELECT * FROM stop_visits WHERE id=?',(journey['targetVisitId'],)).fetchone())
        legs = [dict(db.execute('SELECT * FROM legs WHERE id=?',(i,)).fetchone()) for i in journey['legIds']]
        raw = [dict(r) for r in db.execute('SELECT * FROM raw_positions WHERE route_id=3 AND bus_name=? AND collected_at BETWEEN ? AND ? ORDER BY collected_at',
                (source['bus_name'],source['pinned_at']-30000,(target['departed_at'] or target['arrived_at'])+30000))]
        gaps = [(b['collected_at']-a['collected_at'])/1000 for a,b in zip(raw,raw[1:])]
        speeds = [3.6*distance(a,b)/dt for a,b,dt in zip(raw,raw[1:],gaps) if dt>0]
        def around(stop, clock, before, after):
            points = [r for r in raw if clock-before*1000 <= r['collected_at'] <= clock+after*1000]
            return [{'seconds':round((r['collected_at']-clock)/1000,3), 'distanceToStopM':round(distance(r,COORDS[str(stop)]),2),
                     'stepM':None if i==0 else round(distance(points[i-1],r),2),'lastStop':r['last_stop_id']}
                    for i,r in enumerate(points)]
        misses = []
        for x in events:
            if x['journeyId']!=journey['journeyId'] or x['candidate']['low']<=x['truthSec']:continue
            misses.append({k:x[k] for k in ['at','phase','checkpointSec','truthSec']} | {
                'baselineLow':x['baseline']['low'],'candidateLow':x['candidate']['low'],
                'lowerExcessSec':x['candidate']['low']-x['truthSec'],
                'candidateLowerBeforeDetectorDepartureSec':None if target['departed_at'] is None else (target['departed_at']-x['at'])/1000-x['candidate']['low']})
        result['cases'].append({'sourceId':source['id'],'targetId':target['id'],'bus':source['bus_name'],
            'sourcePinET':datetime.datetime.fromtimestamp(source['pinned_at']/1000,TZ).isoformat(),
            'source':source,'target':target,'legs':legs,'earlyRows':misses,
            'raw':{'n':len(raw),'maxGapSec':max(gaps,default=None),'maxConsecutiveSpeedKmh':max(speeds,default=None),
                   'sourceDeparture':around(source['stop_id'],source['departed_at'],35,20),
                   'targetArrival':around(target['stop_id'],target['arrived_at'],20,20)}})
    db.close()
    return result

out = {'method':'Retrospective outcome audit. GPS/visit confirmation is a proxy for physical arrival, not proof of doors-open boarding. No record exclusions or model fitting.',
       'data':[
        audit('reused Sep16–17',HERE/'score.json',ROOT/'release-integration-data/outcomes-complete.db',
              {64318,65347,68304,58061,67957,66730,60375}),
        audit('new date Sep18 morning',HERE/'today/score.json',HERE/'outcomes-today.db', {70927,71209})],
       'trackingHashes':{name:hashlib.sha256((HERE/name).read_bytes()).hexdigest() for name in ['baseline-tracking.jsonl','candidate-tracking.jsonl']}}
(HERE/'independent-cases.json').write_text(json.dumps(out,indent=2)+'\n')
for d in out['data']:
    print(d['data'])
    for c in d['cases']:
        print(c['sourceId'],c['targetId'],c['sourcePinET'],c['target']['stop_id'],c['target']['outcome'],
              'raw',c['raw']['n'],'maxgap',round(c['raw']['maxGapSec'] or 0,2),'maxspeed',round(c['raw']['maxConsecutiveSpeedKmh'] or 0,1),
              'targetNear',round(c['target']['closest_m'],1),'sourceHow',c['source']['how'],
              'worstLowerExcess',round(max((r['lowerExcessSec'] for r in c['earlyRows']),default=0),2))
assert len(set(out['trackingHashes'].values()))==1,'Tracking diverged between arms'
print('Tracking byte-identical')
