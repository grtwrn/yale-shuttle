"""Read-only audit of four deliberately selected ETA regression holds.

Run: python3 red-window-data/regression-validity-review.py
Writes an evidence JSON only; never edits records, app code, or model parameters.
"""
import collections, datetime, gzip, hashlib, json, math, pathlib, sqlite3, statistics
from zoneinfo import ZoneInfo

D = pathlib.Path(__file__).resolve().parent
R = D.parent / 'conditional-replay-data'
TZ = ZoneInfo('America/New_York')
IDS = [64318, 58224, 65347, 48550]
db = sqlite3.connect('file:' + str(R / 'outcomes.db') + '?mode=ro', uri=True)
db.row_factory = sqlite3.Row
def rows(sql, args=()): return [dict(r) for r in db.execute(sql, args)]
def et(t): return datetime.datetime.fromtimestamp(t / 1000, TZ).isoformat() if t is not None else None
def ms(t):
    if not isinstance(t,str): return t
    dt=datetime.datetime.fromisoformat(t.replace('Z','+00:00'))
    # Collector wire timestamps omit Z but are UTC, matching the server parser.
    return round((dt if dt.tzinfo else dt.replace(tzinfo=datetime.timezone.utc)).timestamp()*1000)
def metres(a, b):
    a1, o1, a2, o2 = map(math.radians, [a['lat'], a['lon'], b['lat'], b['lon']])
    h = math.sin((a2-a1)/2)**2 + math.cos(a1)*math.cos(a2)*math.sin((o2-o1)/2)**2
    return 12742000 * math.asin(min(1, math.sqrt(h)))
seq = json.loads(db.execute('select stops_json from routes where id=3').fetchone()[0])
stops = {r['id']: dict(r) for r in db.execute('select * from stops')}
visits = {i: rows('select * from stop_visits where id=?', (i,))[0] for i in IDS}

def chain(s, target):
    """Require each exact observed leg, arrival, and intermediate departure.

    Allows intermediate passed stops; target is the first physical occurrence,
    and its stopped/pass outcome is reported rather than silently changed.
    """
    idx, dep, path = s['stop_index'], s['departed_at'], []
    goal = seq.index(target)
    for _ in seq:
        legs = rows('''select * from legs where route_id=3 and bus_name=?
                       and from_index=? and departed_at=? and reached=1''', (s['bus_name'], idx, dep))
        if len(legs) != 1: return dict(path=path, error='missing or ambiguous exact next leg')
        leg = legs[0]
        if not (leg['from_stop_id'] == seq[idx] and leg['to_stop_id'] == seq[leg['to_index']]
                and 1 <= leg['hops'] <= (goal-idx) % len(seq)
                and (leg['to_index']-idx) % len(seq) == leg['hops'] and leg['arrived_at'] > dep):
            return dict(path=path, error='invalid route occurrence or clock')
        vs = rows('''select * from stop_visits where route_id=3 and bus_name=?
                     and stop_id=? and stop_index=? and anchored_at between ? and ?
                     and (arrived_at=? or (outcome='passed' and departed_at=?))''',
                  (s['bus_name'], leg['to_stop_id'], leg['to_index'], s['anchored_at'],
                   leg['arrived_at'], leg['arrived_at'], leg['arrived_at']))
        if len(vs) != 1: return dict(path=path, error='missing or ambiguous exact arrival visit')
        v = vs[0]; path.append(dict(leg=leg, visit=v))
        if v['how'] == 'gap': return dict(path=path, error='gap-classified endpoint')
        if leg['to_index'] == goal:
            return dict(path=path, error=None, targetId=v['id'], targetOutcome=v['outcome'],
                        targetClosestM=v['closest_m'], targetArrival=leg['arrived_at'],
                        targetArrivalET=et(leg['arrived_at']),
                        departureToTargetSec=(leg['arrived_at']-s['departed_at'])/1000,
                        targetStoppedSec=v['stand_sec'])
        if v['departed_at'] is None or v['departed_at'] < leg['arrived_at']:
            return dict(path=path, error='missing or reversed intermediate departure')
        idx, dep = leg['to_index'], v['departed_at']
    return dict(path=path, error='route traversal exceeded')

# An existing older archive can contain other routes only after retention. Count
# actual coverage rather than inferring it from the file name.
archive = pathlib.Path('/home/gwarren/shuttle-archive/2026-09-14/raw_positions.jsonl.gz')
archive_audit = dict(path=str(archive), exists=archive.exists(), relevantRows=[])
if archive.exists():
    counts = collections.Counter(); n = 0; s = visits[48550]
    for line in gzip.open(archive, 'rt'):
        r = json.loads(line); n += 1; counts[r['route_id']] += 1
        if r['route_id'] == 3 and r['bus_name'] == s['bus_name'] and s['anchored_at']-120000 <= r['collected_at'] <= s['departed_at']+180000:
            archive_audit['relevantRows'].append(r)
    archive_audit.update(totalRows=n, rowsByRoute=dict(counts), sha256=hashlib.sha256(archive.read_bytes()).hexdigest())

# Wire state is not a second physical sensor; it is useful for causal availability
# and determining whether a clock was reset during a shuffle.
wire = collections.defaultdict(list)
for line in (R / 'raw-frames.jsonl').open():
    f = json.loads(line)
    at = round(datetime.datetime.fromisoformat(f['at'].replace('Z', '+00:00')).timestamp()*1000)
    for s in visits.values():
        if not s['pinned_at']-15000 <= at <= s['departed_at']+60000: continue
        for b in f['buses']:
            if b['bus_name'] == s['bus_name'] and b.get('observed_at') == at:
                wire[s['id']].append(dict(at=at, atET=et(at), **b))

shadow = json.loads((D / 'release-wire-shadow.json').read_text())
report = dict(method=__doc__, selection='Four requested regression/stress cases; not a random sample or prevalence estimate.',
              clockDefinition='Pin starts first attributed fix within 75m. Arrived starts the first repeated-coordinate plateau. Departed is the final plateau endpoint, retrospectively confirmed by onward movement; it is not its causal receipt time or verified door-close time.',
              archiveAudit=archive_audit, cases=[])
for s in visits.values():
    inbound = rows('''select * from legs where route_id=3 and bus_name=? and to_index=?
                      and (arrived_at=? or to_pinned_at=?) order by arrived_at''',
                   (s['bus_name'], s['stop_index'], s['arrived_at'], s['pinned_at']))
    legacy = rows('''select * from arrivals where route_id=3 and bus_name=? and stop_id=?
                    and arrived_at between ? and ? order by arrived_at''',
                  (s['bus_name'], s['stop_id'], s['anchored_at']-120000, s['departed_at']+60000))
    nearby = rows('''select * from stop_visits where route_id=3 and bus_name=? and stop_id=?
                    and id!=? and anchored_at between ? and ? order by anchored_at''',
                  (s['bus_name'], s['stop_id'], s['id'], s['anchored_at']-120000, s['departed_at']+60000))
    prior = rows('''select * from stop_visits where route_id=3 and bus_name=? and stop_id in(11,121)
                   and departed_at<? and departed_at>? order by departed_at''',
                 (s['bus_name'], s['anchored_at'], s['anchored_at']-10800000))
    paths = {str(t): chain(s,t) for t in [48,4]}
    hi = max([s['departed_at']+120000] + [p['targetArrival']+60000 for p in paths.values() if not p['error']])
    raw = rows('''select * from raw_positions where route_id=3 and bus_name=?
                  and collected_at between ? and ? order by collected_at,id''',
               (s['bus_name'], s['anchored_at']-120000, hi))
    if s['id'] == 48550 and not raw: raw = archive_audit['relevantRows']
    runs = []
    for r in raw:
        if runs and (runs[-1]['lat'],runs[-1]['lon']) == (r['lat'],r['lon']):
            runs[-1]['end'] = r['collected_at']; runs[-1]['n'] += 1
        else: runs.append(dict(start=r['collected_at'],end=r['collected_at'],n=1,lat=r['lat'],lon=r['lon'],distanceToSourceM=metres(r,stops[s['stop_id']])))
    for r in runs: r.update(startET=et(r['start']),endET=et(r['end']),seconds=(r['end']-r['start'])/1000)
    within = [r for r in raw if s['pinned_at'] <= r['collected_at'] <= s['departed_at']]
    source_runs = [r for r in runs if r['end'] >= s['pinned_at'] and r['start'] <= s['departed_at']]
    source_plateaus = [r for r in source_runs if r['seconds'] >= 10]
    final_run = next((r for r in runs if r['end'] == s['departed_at']),None)
    first_move = next((r for r in raw if r['collected_at'] > s['departed_at'] and final_run and
                       (r['lat'],r['lon']) != (final_run['lat'],final_run['lon'])),None)
    hops = [dict(at=b['collected_at'],seconds=(b['collected_at']-a['collected_at'])/1000,
                 metres=metres(a,b),mps=metres(a,b)/((b['collected_at']-a['collected_at'])/1000))
            for a,b in zip(raw,raw[1:]) if b['collected_at']>a['collected_at']]
    gps = dict(available=bool(raw),n=len(raw),sourcePolls=len(within),busIds=sorted({r['bus_id'] for r in raw}),
               maxGapSec=max([h['seconds'] for h in hops],default=None),maxStepMps=max([h['mps'] for h in hops],default=None),
               duplicateTimestamps=len(raw)-len({r['collected_at'] for r in raw}),sourceRuns=source_runs,
               sourcePlateaus=source_plateaus,sourceWithin75Polls=sum(metres(r,stops[s['stop_id']])<=75 for r in within),
               sourceMaxDistanceM=max([metres(r,stops[s['stop_id']]) for r in within],default=None),
               finalPlateau=final_run,firstFinalCoordinateChange=first_move,
               firstFinalCoordinateChangeLagSec=(first_move['collected_at']-s['departed_at'])/1000 if first_move else None,
               finalMovementWindow=[dict(**r,atET=et(r['collected_at']),distanceToSourceM=metres(r,stops[s['stop_id']])) for r in raw if s['departed_at']-15000<=r['collected_at']<=s['departed_at']+45000])
    gps['reconstructedConfirmationAt'] = round(first_move['collected_at']+s['confirm_sec']*1000) if first_move and s['confirm_sec'] is not None else None
    gps['reconstructedConfirmationET'] = et(gps['reconstructedConfirmationAt'])
    for t,p in paths.items():
        if p['error']: continue
        target = p['path'][-1]['visit']
        rr = [r for r in raw if target['arrived_at']-15000<=r['collected_at']<=(target['departed_at'] or target['arrived_at'])+15000]
        p['rawTargetWindow'] = [dict(**r,atET=et(r['collected_at']),distanceToTargetM=metres(r,stops[int(t)])) for r in rr]
        p['minRawTargetDistanceM'] = min([metres(r,stops[int(t)]) for r in rr],default=None)
    ww=wire[s['id']]
    pins=sorted({ms(b['at_stop_since']) for b in ww if b['at']<=s['departed_at'] and b.get('at_stop_id')==s['stop_id'] and b.get('at_stop_since')})
    case=dict(source=s,clocksET={k:et(s[k]) for k in ['anchored_at','pinned_at','arrived_at','departed_at','first_moved_at','last_at_rest_at']},
              pinToDepartureSec=(s['departed_at']-s['pinned_at'])/1000,
              inboundLegs=inbound,nearbyModernVisits=nearby,nearbyLegacyVisits=legacy,priorRegulatorVisits=prior,
              paths=paths,gps=gps,wirePinOrigins=pins,wirePinOriginsET=[et(t)for t in pins],
              wireFinalMovementWindow=[r for r in ww if s['departed_at']-15000<=r['at']<=s['departed_at']+45000],
              wireCheckpoints=[r for r in shadow['checkpoints'] if r['id']==s['id']],
              decision='retain',provenDetectorError=False,
              evidenceGrade='Raw GPS plus exact visit/leg consistency' if raw else 'Complete event/leg clocks; raw GPS unavailable')
    assert s['how']!='gap' and s['outcome']=='stopped' and s['departed_at']>=s['arrived_at']>=s['pinned_at']
    assert len(inbound)==1 and len(legacy)==1 and not nearby
    assert legacy[0]['departed_at'] is not None
    # A missing downstream path is an evaluation limitation, not evidence that
    # the independently complete source hold is erroneous.
    if raw:
        assert len(gps['busIds'])==1 and gps['duplicateTimestamps']==0 and gps['maxGapSec']<15
        assert final_run and first_move and 0<gps['firstFinalCoordinateChangeLagSec']<10
        assert pins==[s['pinned_at']], (s['id'],pins,s['pinned_at'])
        assert gps['reconstructedConfirmationAt']==legacy[0]['departed_at']
    report['cases'].append(case)
report['summary']=dict(selected=4,retain=4,exclude=0,provenDetectorErrors=0,rawSupported=3,eventOnly=1,
                       claim='No positive reason to discard these four records. Retain the event-only Union case with its lower evidence grade; show sensitivity, not residual-based removal.')
survival = json.loads((D/'release-survival-screen.json').read_text())
report['longUnionComponentCheckpoints']=[r for r in survival['predictions'] if r['id']==48550]
report['inputHashes']={str(p.relative_to(D.parent)):hashlib.sha256(p.read_bytes()).hexdigest() for p in [D/'release-wire-shadow.json',D/'release-survival-screen.json',R/'raw-frames.jsonl',pathlib.Path(__file__)]}
(D/'regression-validity-review.json').write_text(json.dumps(report,indent=2)+'\n')
for c in report['cases']:
    g=c['gps'];print(json.dumps(dict(id=c['source']['id'],clocks=c['clocksET'],hold=c['pinToDepartureSec'],raw=g['n'],gap=g['maxGapSec'],maxStepMps=g['maxStepMps'],plateaus=[dict(start=r['startET'],end=r['endET'],sec=r['seconds'],metres=r['distanceToSourceM']) for r in g['sourcePlateaus']],firstFinalMoveLag=g['firstFinalCoordinateChangeLagSec'],targets={k:{a:p.get(a) for a in ['error','targetId','targetOutcome','departureToTargetSec','minRawTargetDistanceM']} for k,p in c['paths'].items()},decision=c['decision'])))
