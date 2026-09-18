"""Read-only, selected-case audit; no fitting or record exclusion.

Run from any directory. Reuses the audited standalone Events extractor without
executing its main(). Retrospective labels are kept apart from as-of features.
"""
import datetime as dt
import importlib.util
import json
from pathlib import Path
import sqlite3
from zoneinfo import ZoneInfo

ROOT = Path('/home/gwarren/projects/yale-shuttle-watcher')
OUT = ROOT / 'red-lower-data-2026-09-18'
TZ = ZoneInfo('America/New_York')
IDS = {64318, 65347, 68304, 70927}
module_path = ROOT / 'overnight-2026-09-17/eta/cycle-1/extract_landmarks.py'
spec = importlib.util.spec_from_file_location('landmark_events', module_path)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)


def iso(at):
    return dt.datetime.fromtimestamp(at / 1000, TZ).isoformat()


def millis(s):
    return int(dt.datetime.fromisoformat(s.replace('Z', '+00:00')).timestamp() * 1000)


def compact(v):
    if not v:
        return None
    keys = ('id', 'bus_name', 'route_id', 'stop_id', 'anchored_at', 'pinned_at',
            'arrived_at', 'departed_at', 'first_moved_at', 'how', 'closest_m')
    return {k: v[k] for k in keys if k in v}


continuous = json.loads((OUT / 'independent-targeted-continuous.json').read_text())
journeys = {v['sourceId']: v for d in continuous['data'] for v in d['journeys'] if v['sourceId'] in IDS}
saved_cases = json.loads((OUT / 'independent-cases.json').read_text())
audits = {v['sourceId']: v for d in saved_cases['data'] for v in d['cases'] if v['sourceId'] in IDS and v['target']['stop_id'] == 48}
cohort = json.loads((ROOT / 'red-window-data/operating-pattern-screen.json').read_text())['featureRows']
output = []
for db_rel, frame_rel, wanted in [
    ('release-integration-data/outcomes-complete.db', 'release-integration-data/raw-complete-frames.jsonl', IDS - {70927}),
    ('red-lower-data-2026-09-18/outcomes-today.db', 'red-lower-data-2026-09-18/raw-today-frames.jsonl', {70927}),
]:
    db = sqlite3.connect(f'file:{ROOT / db_rel}?mode=ro', uri=True)
    db.row_factory = sqlite3.Row
    sources = [dict(db.execute('SELECT * FROM stop_visits WHERE id=?', (i,)).fetchone()) for i in sorted(wanted)]
    end = max(v['departed_at'] for v in sources) + 120000
    start = min(v['pinned_at'] for v in sources) - 7200000
    visits = [dict(v) for v in db.execute('SELECT * FROM stop_visits WHERE anchored_at BETWEEN ? AND ? ORDER BY anchored_at,id', (start, end))]
    seq = json.loads(db.execute('SELECT stops_json FROM routes WHERE id=3').fetchone()[0])
    names = dict(db.execute('SELECT id,name FROM stops'))
    events = mod.Events(visits, seq)
    cases = []
    for v in sources:
        pin = v['pinned_at']
        r = dict(id=v['id'], bus=v['bus_name'], stop=11, a=pin, day=mod.day(pin))
        ids = events.identities(r)
        historical = {}
        for stop in (11, 121):
            legacy = db.execute('SELECT * FROM arrivals WHERE bus_name=? AND route_id=3 AND stop_id=? AND departed_at<=? ORDER BY departed_at DESC LIMIT 1', (v['bus_name'], stop, pin - 120000)).fetchone()
            legacy = dict(legacy) if legacy else None
            if legacy and mod.day(legacy['departed_at']) != mod.day(pin):
                legacy = None
            own = [w for w in visits if w['route_id'] == 3 and w['bus_name'] == v['bus_name'] and w['stop_id'] == stop and mod.ready(w) is not None and mod.ready(w) <= pin and mod.day(w['departed_at']) == mod.day(pin)]
            modern = max(own, key=lambda w: w['departed_at'], default=None)
            historical[str(stop)] = dict(legacy=compact(legacy), legacyAgeAtPinSec=(pin-legacy['departed_at'])/1000 if legacy else None,
                                        modern=compact(modern), modernAgeAtPinSec=(pin-modern['departed_at'])/1000 if modern else None)
        snapshots = []
        for elapsed in (0, 60, 120):
            at = pin + elapsed * 1000
            peers = {}
            for role in ('ahead', 'follower'):
                s = events.snapshot(ids[role], 11, at, 'arrival15')
                s.pop('features')
                for key in ('latestAllRoute', 'progress'):
                    if s[key]:
                        e = dict(s[key])
                        s[key] = e
                        e['stopName'] = names.get(e['stop'])
                        e['ageSec'] = (at-e['physical'])/1000
                        e['forwardStopsFromWinchester'] = (e['index']-seq.index(11)) % len(seq)
                        e['stopsUntilWinchester'] = (seq.index(11)-e['index']) % len(seq)
                s['reachedStopIds'] = [e['stop'] for e in s.pop('reached')]
                peers[role] = s
            snapshots.append(dict(elapsedSec=elapsed, at=at, peers=peers, wireAsOf=None))
        j = journeys[v['id']]
        c = dict(sourceId=v['id'], bus=v['bus_name'], pinET=iso(pin), source=compact(v), outcomeDB=db_rel,
                 pinHoldSec=(v['departed_at']-pin)/1000, sourceApproachAnchorToPinSec=(pin-v['anchored_at'])/1000,
                 previousOwnClocks=historical, latchedIdentities=ids, snapshots=snapshots,
                 firstReconstructedWirePin=None,
                 hindsight=dict(targetVisitId=j['targetVisitId'], targetArrivedAt=j['targetArrivedAt'], targetDepartedAt=j['targetDepartedAt'],
                                sourceDepartureToTargetArrivalSec=(j['targetArrivedAt']-v['departed_at'])/1000,
                                targetHoldSec=j['targetHoldSec'], exactLegIds=j['legIds'],
                                worstChanged=j.get('changedOnly'), worstCandidate=j['candidate']),
                 savedValidityAudit=audits.get(v['id']))
        cases.append(c)
    for line in (ROOT / frame_rel).open():
        f = json.loads(line)
        at = millis(f['at'])
        if at < min(c['source']['pinned_at'] for c in cases)-15000:
            continue
        if at > max(c['source']['pinned_at'] for c in cases)+180000:
            break
        for c in cases:
            pin = c['source']['pinned_at']
            if not pin-15000 <= at <= pin+180000:
                continue
            bus = next((b for b in f['buses'] if b['bus_name'] == c['bus']), None)
            if bus is None:
                continue
            summary = dict(at=at, bus=bus, otherRedBuses=[b for b in f['buses'] if b['route_id'] == 3 and b['bus_name'] != c['bus']])
            if c['firstReconstructedWirePin'] is None and bus.get('at_stop_id') == 11 and abs(millis(bus['at_stop_since']+'Z')-pin) < 1000:
                c['firstReconstructedWirePin'] = dict(summary, pinVisibilityDelaySec=(at-pin)/1000,
                    legacyClockLapAtPinSec={k: value-(at-pin)/1000 for k, value in bus.get('lap', {}).items()})
            for s in c['snapshots']:
                if at <= s['at']:
                    s['wireAsOf'] = summary
    for c in cases:
        w = c['firstReconstructedWirePin']
        if w:
            c['hindsight']['priorReconstructedLegacyDepartureToCurrentDepartureSec'] = w['legacyClockLapAtPinSec'].get('11', 0) + c['pinHoldSec']
        c['savedComponentForecasts'] = []
    output.extend(cases)
    db.close()

comparator = json.loads((ROOT / 'overnight-2026-09-17/eta/cycle-1/comparator.json').read_text())
predictions = [json.loads(l) for l in (ROOT / 'overnight-2026-09-17/eta/cycle-1/predictions.jsonl').open()]
for c in output:
    c['savedComponentForecasts'] = [v for v in comparator['forecasts'] if v['id'] == c['sourceId']] + [v for v in predictions if v['id'] == c['sourceId'] and v['regime'] == 'arrival15']

# The manager's later immutable read-only export includes today's legacy clock,
# unlike outcomes-today.db. Keep this provenance explicit instead of substituting
# the modern departure clock for the served legacy feature.
followup_dir = ROOT / 'red-early-covariates-2026-09-18'
followup = json.loads((followup_dir / 'legacy-followup.json').read_text())
early_predictions = [json.loads(l) for l in (followup_dir / 'features-predictions.jsonl').open()]
for c in output:
    pin = c['source']['pinned_at']
    c['followupLegacyAtPin'] = {}
    for stop in (11, 121):
        eligible = [v for v in followup['arrivals'] if v['bus_name'] == c['bus'] and v['stop_id'] == stop
                    and v['departed_at'] <= pin-120000 and mod.day(v['departed_at']) == mod.day(pin)]
        v = max(eligible, key=lambda v: v['departed_at'], default=None)
        c['followupLegacyAtPin'][str(stop)] = dict(record=v, ageSec=(pin-v['departed_at'])/1000 if v else None)
        if v and c['firstReconstructedWirePin']:
            age = c['firstReconstructedWirePin']['legacyClockLapAtPinSec'].get(str(stop))
            assert age is None or abs(age-(pin-v['departed_at'])/1000) < 5
    c['savedEarlyReleaseDiagnostic'] = [{k:r[k] for k in ('elapsed','truthRemaining','event','predictions')}
                                       for r in early_predictions if r['id'] == c['sourceId'] and r['regime'] == 'arrival15']

fixed_elapsed_scores = []
for period in ('Sep14_17', 'Sep18'):
    for elapsed in (0, 60, 180, 300, 480):
        rs = [r for r in early_predictions if r['split'] == 'development' and r['regime'] == 'arrival15'
              and r['elapsed'] == elapsed and (r['day'] == '2026-09-18') == (period == 'Sep18')]
        fixed_elapsed_scores.append(dict(period=period, elapsed=elapsed, n=len(rs),
            brier={arm:sum((r['predictions'][arm]-r['event'])**2 for r in rs)/len(rs) if rs else None
                   for arm in ('clock','lap_clock','lap_clock_anchor')}))

db = sqlite3.connect(f'file:{ROOT / "release-integration-data/outcomes-complete.db"}?mode=ro', uri=True)
db.row_factory = sqlite3.Row
v = dict(db.execute('SELECT * FROM stop_visits WHERE id=65237').fetchone())
predecessor_audit = dict(visit=v,
    verdict='Pin/hold start is restart-truncated; independently observed final departure remains valid peer evidence.',
    raw=[dict(r) for r in db.execute('SELECT * FROM raw_positions WHERE route_id=3 AND bus_name=? AND collected_at BETWEEN ? AND ? ORDER BY collected_at',
                                   (v['bus_name'], v['departed_at']-35000, v['departed_at']+40000))],
    outgoingLegs=[dict(r) for r in db.execute('SELECT * FROM legs WHERE route_id=3 AND bus_name=? AND from_stop_id=11 AND departed_at=?', (v['bus_name'],v['departed_at']))],
    confirmingLegacy=[dict(r) for r in db.execute('SELECT * FROM arrivals WHERE route_id=3 AND bus_name=? AND stop_id=11 AND departed_at BETWEEN ? AND ?',
                                                (v['bus_name'],v['departed_at']-30000,v['departed_at']+30000))])
assert len(predecessor_audit['outgoingLegs']) == 1 and predecessor_audit['outgoingLegs'][0]['reached'] == 1
assert mod.ready(v) < next(c['source']['pinned_at'] for c in output if c['sourceId'] == 65347)
db.close()

result = dict(method='Selected-case audit; no fitting or new model selection. Event identity and snapshot functions imported from audited overnight extractor. Same-day own legacy departures require at least120s availability; peer modern departures use confirmed120 rule; unconditional anchor+15s progress is an availability approximation. All wire values are causal raw-feed reconstruction, not actual historical first-publication receipts.',
    limitations=['These cases were selected by observed early-bound errors, so they cannot estimate covariate effects or tail probabilities.', 'Past confirmed departure order is not guaranteed current physical order. Stop-index gaps are coarse and do not equal minutes-to-stop.', 'Raw wire lap clocks are rounded to5s; labels use full-precision timestamps. Legacy arrivals in today DB do not include Sep18; reconstructed wire and separately identified subsequent read-only export supply that evidence.', 'Valid stopped targets and exact leg chains remain included; GPS arrival/departure is not proof of doors-open boarding.'], cases=output,
    fixedElapsedScreenCheck=dict(method='Unweighted per-checkpoint Brier scores of the manager\'s already-fitted saved models; no refit or model selection. The original fit uses visit-balanced, outcome-dependent landmark weights.', scores=fixed_elapsed_scores))
result['predecessor65237Audit'] = predecessor_audit
(OUT/'early-case-covariates.json').write_text(json.dumps(result, indent=2)+'\n')
for c in output:
    print(c['sourceId'], c['pinET'], 'hold', round(c['pinHoldSec'],1), 'ride',round(c['hindsight']['sourceDepartureToTargetArrivalSec'],1), 'wirelap', c['firstReconstructedWirePin']['legacyClockLapAtPinSec'] if c['firstReconstructedWirePin'] else None)
    print('identities', c['latchedIdentities'])
    for s in c['snapshots'][:1]:
        print('pin peers', {k:v['progress'] for k,v in s['peers'].items()})
