"""Hosted Brown cause audit; consumes immutable predictions, never fits/scores."""
import bisect
import collections
import datetime as dt
import gzip
import hashlib
import json
from pathlib import Path
import sys
from zoneinfo import ZoneInfo

HERE = Path(__file__).resolve().parent
INPUT = HERE / 'input/window'
CANONICAL = HERE / 'input/canonical/canonical-windows/results'
OUT = HERE / 'results'
ARMS = ('frozen_K8', 'rolling_K5')
TZ = ZoneInfo('America/New_York')
sys.path.insert(0, str(HERE.parent / 'useful-windows'))
import rider_risk as risk


def read(file):
    with gzip.open(file, 'rt') as source:
        return [json.loads(line) for line in source if line.strip()]


def digest(file):
    h = hashlib.sha256()
    with file.open('rb') as source:
        for block in iter(lambda: source.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def key(r):
    return r['at'], r['bus'], r['route'], r['target']


def local(at):
    return dt.datetime.fromtimestamp(at/1000, TZ).isoformat()


def classify(a, b, arm, n, emitted):
    ae, be = a['candidateEvidence'][arm], b['candidateEvidence'][arm]
    active = be if be['changed'] else ae
    source, wait, origin = active['source'], active['wait'], active['origin']
    k = int(arm.split('_K')[1])
    old, new = a['origins'].get(str(source)), b['origins'].get(str(source))
    flags = dict(source=source, wait=wait, activeOrigin=origin,
                 originBefore=old, originAfter=new, sourceAgeAfterSec=(b['at']-origin)/1000)
    if ae['changed'] and be['changed']:
        if any(ae.get(k) != be.get(k) for k in ('source', 'origin', 'wait')):
            return 'source-origin switch', 'active source/wait/origin changed', flags
        return 'other explicit reason', 'daily refit with unchanged source/wait/origin', flags
    fallback = b if not be['changed'] else a
    reason = fallback['candidateEvidence'][arm]['reason']
    flags['fallbackReason'] = reason
    flags['fallbackAt'] = fallback['at']
    if old and new and old['departed'] != new['departed']:
        return 'source-origin switch', 'different causally retained source departures', flags
    if not old and new and a['asof'] < new['knownAt'] <= b['asof'] and be['changed']:
        return 'source-origin switch', 'source departure first becomes causally known between snapshots', flags
    if reason == 'released/live':
        release = fallback['origins'].get(str(wait))
        confirmed = bool(release and origin < release['departed'] <= fallback['began']
                         and release['knownAt'] <= fallback['asof'])
        # A separately reconstructed reducer event can corroborate a departure,
        # but only when it was already emitted by the fallback snapshot.
        corroboration = [v for v in emitted if v['stop_index'] == wait
                         and v.get('departed_at') is not None and v.get('arrived_at') is not None
                         and v['outcome'] in ('passed', 'stopped') and v['how'] != 'gap'
                         and origin < v['departed_at'] <= fallback['began']
                         and v['known_at'] <= fallback['asof']]
        flags.update(retainedWaitDeparture=release, confirmingWaitVisitIds=[v['id'] for v in corroboration],
                     releaseLatch=fallback.get('releasedOrigins', {}).get(f'{k}/{wait}') == origin,
                     phasePastWait=(fallback['index']-source) % n > k,
                     drivingFromWait=fallback['index'] == wait and fallback['phase'] == 'drive')
        if confirmed or corroboration:
            return 'confirmed wait departure', 'retained causal departure or already emitted completed wait visit', flags
        return 'other explicit reason', 'release latch/phase/progress without retained confirmed wait departure', flags
    if reason == 'not warm/fresh':
        age = (fallback['asof']-fallback.get('observedAt', 0))/1000
        flags['fallbackObservationAgeSec'] = age
        if not fallback.get('observedAt'):
            detail = 'no retained tracker observation'
        elif age > 15:
            detail = 'retained GPS observation older than existing15s freshness limit'
        elif fallback['index'] < 0 or fallback['phase'] == 'unknown':
            detail = 'fresh GPS but no usable reducer phase/index'
        else:
            detail = 'not-ready despite fresh retained GPS/phase; warmup/identity state not retained in feature'
        return 'stale/missing tracker evidence', detail, flags
    if reason == 'group countdown expired':
        return 'group countdown expiry', 'existing whole-target group has a point countdown<=60s; not a GPS-gap claim', flags
    if reason == 'source departure unavailable':
        age = (fallback['at']-origin)/1000
        flags['fallbackSourceAgeSec'] = age
        if age > 2700:
            return 'other explicit reason', 'source removed by existing45-minute feature horizon', flags
        newer = [v for v in emitted if v['stop_index'] == source and v.get('departed_at') is not None
                 and v['departed_at'] != origin and v['known_at'] <= fallback['asof']]
        if newer:
            flags['newSourceEmissionIds'] = [v['id'] for v in newer]
            return 'source-origin switch', 'new source emission but no currently eligible retained origin', flags
        return 'other explicit reason', 'source departure absent from causal feature before age horizon', flags
    return 'other explicit reason', reason, flags


def clock_comparison(a, b, arm):
    result = {}
    for field in ('eta', 'low', 'high'):
        ca, cb = a['candidates'][arm][field], b['candidates'][arm][field]
        da, db = a['deployed'][field], b['deployed'][field]
        jump = (b['at']-a['at'])/1000 + cb-ca
        base_jump = (b['at']-a['at'])/1000 + db-da
        result[field] = dict(beforeAbsolute=a['at']+ca*1000, afterAbsolute=b['at']+cb*1000,
            deployedBeforeAbsolute=a['at']+da*1000, deployedAfterAbsolute=b['at']+db*1000,
            absoluteJumpSec=jump, deployedAbsoluteJumpSec=base_jump,
            introducedJumpSec=jump-base_jump)
    assert result['eta']['introducedJumpSec'] == 0
    return result


def gps_audit(connectivity, bus, start, end):
    reason = connectivity.reason(bus, 19, start, end)
    times, points, _ = connectivity.data.get(bus, ([], [], []))
    lo = max(0, bisect.bisect_right(times, start)-1)
    hi = min(len(times), bisect.bisect_left(times, end)+1)
    selected = points[lo:hi]
    return dict(start=start, end=end, continuous=reason is None, reason=reason,
        samples=len(selected), providerIds=sorted({r[4] for r in selected}, key=str),
        routeIds=sorted({r[3] for r in selected}),
        maxGapSec=max(((b[0]-a[0])/1000 for a, b in zip(selected, selected[1:])), default=None),
        firstFix=selected[0] if selected else None, lastFix=selected[-1] if selected else None)


def snapshot(r, arm):
    return {k: r.get(k) for k in ('at', 'asof', 'observedAt', 'ready', 'index', 'nearest',
        'anchorIndex', 'targetIndex', 'phase', 'began', 'stopsAhead', 'origins', 'releasedOrigins')} | dict(
        candidate=r['candidates'][arm], underlyingCandidate=r['underlyingCandidates'][arm],
        evidence=r['candidateEvidence'][arm], deployed=r['deployed'],
        windowChanged=r['candidates'][arm] != r['deployed'])


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    protected = ('unscored.jsonl.gz', 'forecasts.jsonl.gz', 'summary.json', 'audit.json',
                 'action-audit.json', 'rider-risk/rider-risk-summary.json', 'rider-risk/rider-risk-records.jsonl.gz')
    before_hashes = {file: digest(INPUT / file) for file in protected}
    raw_hashes = {}
    for line in (INPUT / 'immutable-inputs.sha256').read_text().splitlines():
        expected, file = line.split(maxsplit=1)
        assert digest(Path(file)) == expected
        raw_hashes[file] = expected
    original_summary = json.loads((INPUT / 'summary.json').read_text())
    topology = json.loads((INPUT / 'canonical-topology.json').read_text())
    route = next(r for r in topology['routes'] if r['id'] == 19)
    stops = {r['id']: r['name'] for r in topology['stops']}
    sequence = route['stops']; n = len(sequence)
    labels = {key(r): r['label'] for r in read(INPUT / 'forecasts.jsonl.gz') if r['route'] == 19}
    rows = [dict(r, label=labels.get(key(r))) for r in read(INPUT / 'unscored.jsonl.gz') if r['route'] == 19]
    groups = collections.defaultdict(list)
    for r in rows:
        groups[r['bus'], r['target']].append(r)
    connectivity = risk.Connectivity(Path('research/k-sweep/results/raw_positions.jsonl.gz'), {r['bus'] for r in rows})
    visits = collections.defaultdict(list)
    for v in read(CANONICAL / 'training-visits.jsonl.gz'):
        if v['route_id'] == 19:
            visits[v['bus_name']].append(v)
    for vs in visits.values():
        vs.sort(key=lambda v: v['known_at'])
    visit_times = {bus: [v['known_at'] for v in vs] for bus, vs in visits.items()}
    records, parity = [], {}
    for arm in ARMS:
        skipped = collections.Counter()
        matched = []
        for (bus, target), rs in groups.items():
            rs.sort(key=lambda r: r['at'])
            for a, b in zip(rs, rs[1:]):
                ae, be = a['candidateEvidence'][arm], b['candidateEvidence'][arm]
                if not (ae['changed'] or be['changed']):
                    continue
                if ae['changed'] != be['changed']:
                    transition = 'candidate-to-fallback' if ae['changed'] else 'fallback-to-candidate'
                elif any(ae.get(k) != be.get(k) for k in ('source', 'origin', 'wait')):
                    transition = 'new-source-or-wait'
                elif arm.startswith('rolling_') and risk.day(a['at']) != risk.day(b['at']):
                    transition = 'daily-refit'
                else:
                    continue
                if not a['label'] or not b['label']:
                    skipped['unlabelledTransitions'] += 1
                    continue
                if a['label']['id'] != b['label']['id']:
                    skipped['differentPickupOccurrenceTransitions'] += 1
                    continue
                if not 0 < b['at']-a['at'] <= 30000:
                    skipped['unobservedGapTransitions'] += 1
                    continue
                assert a['label'] == b['label']
                times = visit_times.get(bus, [])
                emitted = visits.get(bus, [])[bisect.bisect_right(times, a['asof']):bisect.bisect_right(times, b['asof'])]
                assert all(v['known_at'] <= b['asof'] for v in emitted)
                cause, detail, flags = classify(a, b, arm, n, emitted)
                clocks = clock_comparison(a, b, arm)
                old_record = dict(bus=bus, at=b['at'], target=target, transition=transition,
                    reason=be['reason'], arrivalClockJump={k: x['absoluteJumpSec'] for k, x in clocks.items()},
                    deployedArrivalClockJump={k: x['deployedAbsoluteJumpSec'] for k, x in clocks.items()})
                matched.append(old_record)
                active = be if be['changed'] else ae
                indices = set((active['source'], active['wait'], b['targetIndex']))
                adjacent = sorted({(i+d) % n for i in indices for d in (-1, 0, 1)})
                record = dict(id=f'{arm}/{bus}/{target}/{b["at"]}', arm=arm, bus=bus, route=19,
                    at=b['at'], atET=local(b['at']), target=target, targetIndex=b['targetIndex'],
                    targetName=stops[target], label=b['label'], transition=transition, cause=cause, detail=detail,
                    flags=flags, clocks=clocks, elapsedSec=(b['at']-a['at'])/1000,
                    maxIntroducedBoundJumpSec=max(abs(clocks[k]['introducedJumpSec']) for k in ('low', 'high')),
                    before=snapshot(a, arm), after=snapshot(b, arm), causalEmissions=emitted,
                    gpsBetween=gps_audit(connectivity, bus, a['at'], b['at']),
                    gpsThroughDeparture=gps_audit(connectivity, bus, a['at'], b['label']['departure']),
                    adjacentOccurrences=[dict(index=i, stop=sequence[i], name=stops[sequence[i]]) for i in adjacent])
                records.append(record)
        expected = original_summary['routes']['19'][arm]['handoffs']
        assert matched == expected['records'], f'Prior transition identity/numeric audit changed for {arm}'
        for name in ('unlabelledTransitions', 'differentPickupOccurrenceTransitions', 'unobservedGapTransitions'):
            assert skipped[name] == expected[name]
        parity[arm] = dict(identical=True, matched=len(matched), excluded=dict(skipped))
    records.sort(key=lambda r: (r['at'], r['arm'], r['bus'], r['target']))
    with gzip.open(OUT / 'handoff-records.jsonl.gz', 'wt') as file:
        for record in records:
            file.write(json.dumps(record, separators=(',', ':')) + '\n')
    causes = {}
    for cause in sorted({r['cause'] for r in records}):
        rs = [r for r in records if r['cause'] == cause]
        causes[cause] = dict(count=len(rs), byArm=dict(collections.Counter(r['arm'] for r in rs)),
            details=dict(collections.Counter(r['detail'] for r in rs)), first=rs[0],
            largest=sorted(rs, key=lambda r: (-r['maxIntroducedBoundJumpSec'], r['at'], r['id']))[0],
            gpsBetweenContinuous=sum(r['gpsBetween']['continuous'] for r in rs),
            gpsThroughDepartureContinuous=sum(r['gpsThroughDeparture']['continuous'] for r in rs))
    assert before_hashes == {file: digest(INPUT / file) for file in protected}
    assert raw_hashes == {file: digest(Path(file)) for file in raw_hashes}
    summary = dict(windowRun=35685527686, canonicalRun=35684356219, arms=ARMS,
        hashesBefore=before_hashes, hashesAfter=before_hashes, priorBytesUnchanged=True, rawHashes=raw_hashes,
        parity=parity, records=len(records), causes=causes,
        routeSequence=[dict(index=i, stop=s, name=stops[s]) for i, s in enumerate(sequence)],
        note='Same physical visits and previous handoff selection; no forecasts, scores, labels, fits, thresholds or new dates changed.')
    (OUT / 'summary.json').write_text(json.dumps(summary, indent=2) + '\n')
    lines = ['# Brown handoff causes', '', summary['note'], '',
        '| Cause | Cases | Arm counts | Continuous GPS between / through departure |', '|---|---:|---|---|']
    for name, group in causes.items():
        lines.append(f"| {name} | {group['count']} | {group['byArm']} | {group['gpsBetweenContinuous']} / {group['gpsThroughDepartureContinuous']} |")
    for name, group in causes.items():
        lines += ['', f'## {name}', '', str(group['details']), '',
            '| Example | ET time | Arm / bus / pickup | Transition | Absolute jumps point / low / high, s | Additional jumps point / low / high, s | Evidence |',
            '|---|---|---|---|---|---|---|']
        for tag in ('first', 'largest'):
            r = group[tag]
            absolute = ' / '.join(str(r['clocks'][k]['absoluteJumpSec']) for k in ('eta', 'low', 'high'))
            extra = ' / '.join(str(r['clocks'][k]['introducedJumpSec']) for k in ('eta', 'low', 'high'))
            lines.append(f"| {tag} | {r['atET']} | {r['arm']} / {r['bus']} / {r['targetName']} | {r['transition']} | {absolute} | {extra} | {r['detail']} |")
    lines += ['', 'All detailed snapshots, absolute timestamps, source/wait clocks, causal emissions and bracketing GPS/provider checks are retained in handoff-records.jsonl.gz. First/largest selection is chronological / largest additional bound movement, with chronological ties. No smoothing or causal-policy change is tested.']
    (OUT / 'REPORT.md').write_text('\n'.join(lines) + '\n')
    print(json.dumps(dict(records=len(records), parity=parity, causes={k: v['details'] for k, v in causes.items()}, priorBytesUnchanged=True)))


if __name__ == '__main__':
    main()
