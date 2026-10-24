"""Review completed virtual pickups against their first literal displayed window.

This uses the rider's shared GPS feed, not independent physical arrival truth.
Unusable or changed identities are unknown, never a passing estimate.
"""
import gzip
import json
import math
import re
import zlib
from datetime import datetime
from pathlib import Path
from evidence import verify_bundle, verify_feed_response

# Same five-minute diagnostic tolerance as canary-metrics.firstSightMissSec.
MISS_SECONDS = 300


def timestamp(value):
    try:
        result = datetime.fromisoformat(str(value).replace('Z', '+00:00'))
        return result.timestamp() if result.tzinfo is not None else None
    except (ValueError, TypeError, OverflowError):
        return None


def number(value):
    return type(value) in (int, float) and math.isfinite(value)


def bus_name(value):
    if not isinstance(value, str):
        return None
    value = value.removeprefix('#')
    return value if re.fullmatch(r'[A-Za-z0-9-]{1,24}', value) else None


def distance(a, b):
    if not all(number(p.get(k)) for p in (a, b) for k in ('lat', 'lon')):
        return None
    if any(abs(p['lat']) > 90 or abs(p['lon']) > 180 for p in (a, b)):
        return None
    lat1, lat2 = map(math.radians, (a['lat'], b['lat']))
    dlat, dlon = lat2-lat1, math.radians(b['lon']-a['lon'])
    h = math.sin(dlat/2)**2 + math.cos(lat1)*math.cos(lat2)*math.sin(dlon/2)**2
    return 6371000 * 2 * math.atan2(math.sqrt(h), math.sqrt(max(0, 1-h)))


def boarding_pickup(journey, rows, records, provider_id):
    """A between-sample GPS observation, tied to the selected pickup card.

    Only verified original response bytes can supply it. An earlier sampled
    opportunity is handled by analyze first and can never be overridden here.
    """
    try:
        observation = journey.get('boardingObservation')
        if (not isinstance(observation, dict) or type(observation.get('v')) is not int or observation['v'] != 1
                or observation.get('outcome') != 'boarded'
                or observation.get('busName') != journey['busName']
                or observation.get('routeIds') != journey['line']['busRouteIds']
                or observation.get('stopId') != journey['boardStopId']):
            return None
        boarded, attempted = timestamp(journey['boardedAt']), timestamp(observation.get('attemptedAt'))
        outcome = timestamp(observation.get('outcomeAt'))
        screen = observation.get('sample') or {}
        sampled = timestamp(screen.get('sampledAt'))
        if (None in (boarded, attempted, outcome, sampled)
                or not 0 <= attempted-sampled <= 5 or not 0 <= boarded-attempted <= 15
                or not 0 <= outcome-boarded <= 1 or screen.get('feedStableDuringTextRead') is not True):
            return None
        selected = [s for s in rows if s.get('phase') == 'waiting' and s.get('at') == screen.get('sampledAt')]
        if len(selected) != 1:
            return None
        selected = selected[0]
        if ((selected.get('mapPauseAudit') or {}).get('feedStableDuringRead') is not True
                or screen.get('feedResponse') != selected.get('feedResponse')):
            return None
        stored = json.loads(journey['boardedStorage']['shuttle-boarded-ride'])
        if (stored.get('routeLabel') != journey['line']['label']
                or bus_name(stored.get('busName')) != bus_name(journey['busName'])
                or stored.get('boardStopId') != journey['boardStopId']
                or stored.get('alightStopId') != journey['exitStopId']):
            return None
        point = journey['trip']['origin']
        if any(distance(point, observation.get(k) or {}) != 0 for k in ('stopCoords', 'riderCoords')):
            return None
        checks = observation.get('checks')
        if not isinstance(checks, list) or not 2 <= len(checks) <= 32:
            return None
        first = checks[0]
        if (first.get('kind') != 'pickup-eligible' or first.get('allowed') is not True
                or first.get('atStop') is not True or first.get('feedStableFromSelection') is not True
                or any(first.get(k) is not False for k in ('past', 'opposite', 'otherOccurrence'))
                or first.get('text') != selected['text']
                or not re.search(r'(?:^|\n)BOARD🚌', first['text'])
                or first.get('feedResponse') != selected.get('feedResponse')):
            return None
        if not isinstance(records, list) or not records or len(records) > 128:
            return None
        originals = {}
        for record in records:
            raw = verify_feed_response(record)
            if record['id'] in originals:
                return None
            originals[record['id']] = (record, json.loads(raw))
        candidate, previous_at = None, sampled
        for index, check in enumerate(checks):
            if (not isinstance(check, dict) or check.get('allowed') is not True
                    or check.get('kind') != ('pickup-eligible' if index == 0 else 'observation-ready')):
                return None
            at = timestamp(check.get('checkedAt'))
            if at is None or not previous_at <= at <= outcome or (index > 0 and at < attempted):
                return None
            previous_at = at
            ref = check.get('feedResponse') or {}
            if ref.get('state') != 'captured' or ref.get('runId') != journey['id'] or ref.get('file') != 'feed-responses/'+journey['id']+'.jsonl':
                return None
            original, feed = originals[ref['id']]
            keys = ('v', 'runId', 'route', 'sourceKind', 'receivedAt', 'status', 'headers', 'decodedBytes', 'decodedSHA256', 'gzipBytes', 'gzipSHA256')
            if any(ref.get(k) != original[k] for k in keys) or not -5 <= at-original['receivedAt']/1000 <= 30:
                return None
            matches = [b for b in feed.get('buses', []) if bus_name(b.get('bus_name')) == bus_name(journey['busName'])
                       and b.get('route_id') == journey['line']['busRouteIds'][0]]
            if len(matches) != 1:
                return None
            bus = matches[0]
            if (bus != check.get('bus') or bus.get('bus_id') != provider_id
                    or not number(bus.get('observed_at')) or not -5 <= at-bus['observed_at']/1000 <= 30):
                return None
            metres = distance(bus, point)
            if metres is None or not number(check.get('distanceM')) or abs(metres-check['distanceM']) > 1e-6:
                return None
            qualifies = metres <= 45 or (metres <= 60 and bus.get('stationary') is True and bus.get('at_stop_id') == journey['boardStopId'])
            if index > 0 and at <= boarded and qualifies and candidate is None:
                candidate = {'at': check['checkedAt'], 'distanceM': metres, 'bus': bus,
                             'feedAgeMs': at*1000-original['receivedAt'], 'screenFeedStable': True,
                             'cardAtPickup': True, 'source': 'verified-boarding-check',
                             'feedResponse': ref, 'pickupScreenAt': selected['at']}
        return candidate
    except (KeyError, TypeError, ValueError, AttributeError, OverflowError):
        return None


def analyze(journey, samples, coverage, boarding_records=None):
    def unknown(reason):
        return {'state': 'unknown', 'reason': reason}
    if not isinstance(journey, dict) or journey.get('result') != 'completed':
        return unknown('not-completed')
    if (journey.get('excludeAccuracy') or journey.get('instrumentHandoverAt')
            or journey.get('harnessErrors') or journey.get('transfer')
            or journey.get('instrumentVersion') != 'inputs-v2'):
        return unknown('excluded-or-resumed-instrument')
    if (not isinstance(samples, list) or not isinstance(coverage, dict) or coverage.get('complete') is not True
            or type(journey.get('samples')) is not int or len(samples) != journey['samples'] or len(samples) > 4096):
        return unknown('incomplete-sample-coverage')
    if not isinstance(journey.get('id'), str) or not all(isinstance(s, dict) and s.get('runId') == journey['id'] for s in samples):
        return unknown('mixed-journey-records')
    rows = sorted(samples, key=lambda s: str(s.get('at', '')))
    times = [timestamp(s.get('at')) for s in rows]
    if any(t is None for t in times) or any(b <= a for a, b in zip(times, times[1:])):
        return unknown('invalid-sample-clocks')
    waiting = [s for s in rows if s.get('phase') == 'waiting']
    if not waiting:
        return unknown('no-waiting-screen')
    first, started, boarded = waiting[0], timestamp(journey.get('startedAt')), timestamp(journey.get('boardedAt'))
    first_at = timestamp(first.get('at'))
    if started is None or boarded is None or not 0 <= first_at-started <= 15 or boarded < first_at:
        return unknown('missing-initial-screen-or-boarding-clock')
    trip = journey.get('trip')
    point = trip.get('origin') if isinstance(trip, dict) else None
    if not isinstance(point, dict):
        return unknown('pickup-coordinate-or-vehicle-unbound')
    target, name = journey.get('boardStopId'), bus_name(journey.get('busName'))
    if type(target) is not int or point.get('stopId') != target or distance(point, point) is None or name is None:
        return unknown('pickup-coordinate-or-vehicle-unbound')
    if any(not isinstance(s.get('text'), str) or len(s['text']) > 65536 for s in waiting):
        return unknown('invalid-screen-text')
    quote = re.findall(r'(?:^|\n)(Arrival: About (<1|\d{1,4}) min · Likely (~1|<1|\d{1,4})(?:[–-](\d{1,4}))? min)(?=\n|$)', str(first.get('text', '')))
    if len(quote) != 1:
        return unknown('initial-window-unavailable')
    raw, _, low, high = quote[0]
    lo = 0 if low in ('<1', '~1') else int(low)*60
    hi = int(high)*60 if high else 60 if low in ('<1', '~1') else int(low)*60
    if not 0 <= lo <= hi <= 24*3600:
        return unknown('invalid-initial-window')
    named = re.findall(r'(?:^|\n)🚌 #([A-Za-z0-9-]{1,24}) · \d+ stops? away(?=\n|$)', str(first.get('text', '')))
    if named != [name]:
        return unknown('initial-vehicle-differs-or-unbound')
    first_audit = first.get('mapPauseAudit') or {}
    if first_audit.get('feedStableDuringRead') is not True:
        return unknown('initial-screen-feed-race')
    line = journey.get('line')
    route_ids = line.get('busRouteIds') if isinstance(line, dict) else None
    if not isinstance(route_ids, list) or len(route_ids) != 1 or type(route_ids[0]) is not int:
        return unknown('route-identity-unbound')
    label = point.get('label')
    if not isinstance(label, str) or not label or len(label) > 200:
        return unknown('pickup-label-unbound')
    canonical_label = ''.join(label.split()).casefold()
    provider_id, arrival, previous = None, None, None
    for sample in waiting:
        at = timestamp(sample['at'])
        if at > boarded or not number(sample.get('feedAgeMs')) or not 0 <= sample['feedAgeMs'] <= 30000:
            return unknown('stale-or-invalid-waiting-receipt')
        if previous is not None and at-previous > 30:
            return unknown('waiting-observation-gap')
        previous = at
        labels = re.findall(r'(?:^|\n)BOARD([^\n]+)', sample['text'])
        if len(labels) != 1 or ''.join(labels[0].removeprefix('🚌').split('⏸')[0].split()).casefold() != canonical_label:
            return unknown('pickup-label-changed-or-unbound')
        screen_names = re.findall(r'(?:^|\n)🚌 #([A-Za-z0-9-]{1,24}) · \d+ stops? away(?=\n|$)', str(sample.get('text', '')))
        if screen_names and screen_names != [name]:
            return unknown('watched-vehicle-changed')
        buses = sample.get('buses')
        if not isinstance(buses, list):
            return unknown('missing-fleet-observation')
        matches = [b for b in buses if isinstance(b, dict) and bus_name(b.get('bus_name')) == name and type(b.get('route_id')) is int and b['route_id'] == route_ids[0]]
        if len(matches) != 1:
            return unknown('watched-vehicle-missing-or-ambiguous')
        bus = matches[0]
        if type(bus.get('bus_id')) is not int:
            return unknown('provider-identity-missing')
        if provider_id is None:
            provider_id = bus['bus_id']
        if bus['bus_id'] != provider_id:
            return unknown('provider-identity-changed')
        observed = bus.get('observed_at')
        if not number(observed) or not -5 <= at-observed/1000 <= 30:
            return unknown('stale-or-invalid-gps-clock')
        metres = distance(bus, point)
        if metres is None:
            return unknown('invalid-gps-coordinates')
        if metres <= 45 or (metres <= 60 and bus.get('stationary') is True and bus.get('at_stop_id') == target):
            if arrival is None:
                arrival = {'at': sample['at'], 'distanceM': metres, 'bus': bus,
                           'feedAgeMs': sample['feedAgeMs'],
                           'screenFeedStable': (sample.get('mapPauseAudit') or {}).get('feedStableDuringRead') is True,
                           'cardAtPickup': re.search(r'(?:^|\n)BOARD🚌', sample['text']) is not None}
    if arrival is None and boarding_records is not None:
        arrival = boarding_pickup(journey, rows, boarding_records, provider_id)
    if arrival is None:
        return unknown('no-qualifying-pickup-observation')
    arrival_at = timestamp(arrival['at'])
    if (not 0 <= boarded-arrival_at <= 15 or not arrival['screenFeedStable']
            or not arrival['cardAtPickup']):
        return unknown('earlier-or-unbound-pickup-opportunity')
    late = arrival_at-first_at-hi
    early = lo-(arrival_at-first_at)
    result = {'state': 'early-window' if early > MISS_SECONDS else 'late-window' if late > MISS_SECONDS else 'within-diagnostic-tolerance',
            'runId': journey['id'], 'busName': name, 'routeId': route_ids[0], 'boardStopId': target,
            'firstQuote': {'at': first['at'], 'text': raw, 'loSec': lo, 'hiSec': hi},
            'pickupObservation': arrival, 'observedWaitSec': arrival_at-first_at,
            'lateBeyondWindowSec': late, 'toleranceSec': MISS_SECONDS,
            'scope': 'Same-feed GPS-correlated virtual pickup diagnostic, not physical boarding, independent ETA accuracy or model promotion.'}
    # Preserve existing late/within receipts. New early incidents carry their
    # positive lower-bound miss separately from the signed upper-bound value.
    if early > MISS_SECONDS:
        result['earlyBeforeWindowSec'] = early
    return result


def updated_window_audit(journey, samples, first, records):
    """Later literal windows, separate from the unchanged first-window metric.

    Samples can nominate a pair. Original quote and pickup response bytes are
    required before confirming it; a missing source never becomes a pass.
    """
    scope = ('Shared-feed virtual pickup-window update diagnostic; not physical '
             'boarding, independent ETA accuracy or model promotion.')
    def outcome(state, **detail):
        return {'v': 1, 'state': state, **detail, 'scope': scope}
    if first.get('state') not in ('early-window', 'late-window', 'within-diagnostic-tolerance'):
        return outcome('unknown', reason='pickup-observation-unqualified')
    pickup = first['pickupObservation']
    pickup_at, first_at = timestamp(pickup['at']), timestamp(first['firstQuote']['at'])
    route_id, name = first['routeId'], first['busName']
    provider_id = pickup['bus']['bus_id']
    pending, pair, reviewed = None, None, 0
    gaps = {}
    def unassessed(reason):
        gaps[reason] = gaps.get(reason, 0)+1
    for sample in sorted(samples, key=lambda row: str(row.get('at', ''))):
        at = timestamp(sample.get('at'))
        if at is None or not first_at < at < pickup_at:
            continue
        if sample.get('phase') != 'waiting':
            pending = None; unassessed('phase-change'); continue
        if (sample.get('mapPauseAudit') or {}).get('feedStableDuringRead') is not True:
            pending = None; unassessed('screen-feed-race'); continue
        quotes = re.findall(r'(?:^|\n)(Arrival: About (<1|\d{1,4}) min · Likely (~1|<1|\d{1,4})(?:[–-](\d{1,4}))? min)(?=\n|$)', sample.get('text', ''))
        if len(quotes) != 1:
            pending = None; unassessed('unique-window-unavailable'); continue
        displayed = re.findall(r'(?:^|\n)#([A-Za-z0-9-]{1,24}) · Recent speed[^\n]*(?=\n|$)', sample['text'])
        if displayed != [name]:
            pending = None; unassessed('displayed-vehicle-unbound'); continue
        raw, _, low, high = quotes[0]
        lo = 0 if low in ('<1', '~1') else int(low)*60
        hi = int(high)*60 if high else 60 if low in ('<1', '~1') else int(low)*60
        if not 0 <= lo <= hi <= 24*3600:
            pending = None; unassessed('invalid-window'); continue
        ref, wire = sample.get('feedResponse') or {}, sample.get('server_eta') or {}
        buses = [b for b in sample.get('buses', []) if bus_name(b.get('bus_name')) == name and b.get('route_id') == route_id]
        if (len(buses) != 1 or buses[0].get('bus_id') != provider_id
                or not number(buses[0].get('observed_at'))
                or not -5 <= at-buses[0]['observed_at']/1000 <= 30
                or not number(sample.get('feedAgeMs')) or not 0 <= sample['feedAgeMs'] <= 30000
                or ref.get('state') != 'captured' or ref.get('runId') != journey['id']
                or ref.get('file') != 'feed-responses/'+journey['id']+'.jsonl'
                or not re.fullmatch(r'[a-f0-9]{64}', str(ref.get('id', '')))
                or not number(ref.get('receivedAt')) or not 0 <= at-ref['receivedAt']/1000 <= 30
                or abs(at*1000-ref['receivedAt']-sample['feedAgeMs']) > 1
                or wire.get('v') != 2 or not number(wire.get('at')) or not number(wire.get('servedAt'))
                or not 0 <= wire['servedAt']-wire['at'] < 30000
                or not -5 <= at-wire['at']/1000 <= 30):
            pending = None; unassessed('fresh-source-identity-unavailable'); continue
        reviewed += 1
        wait = pickup_at-at
        late, early = wait-hi, lo-wait
        tail = 'late-window' if late > MISS_SECONDS else 'early-window' if early > MISS_SECONDS else None
        if tail is None:
            pending = None
            continue
        quote = {'at': sample['at'], 'text': raw, 'loSec': lo, 'hiSec': hi,
                 'remainingToGPSPickupSec': wait, 'lateBeyondWindowSec': late,
                 'earlyBeforeWindowSec': early, 'sourceModelAt': wire['at'],
                 'observedAt': buses[0]['observed_at'], 'feedResponse': ref}
        if pending is not None:
            previous_tail, previous, previous_sample = pending
            gap = at-timestamp(previous['at'])
            same = previous_tail == tail and 0 <= gap <= 30
            advances = (ref['receivedAt']-previous['feedResponse']['receivedAt'],
                        wire['at']-previous['sourceModelAt'],
                        buses[0]['observed_at']-previous['observedAt'])
            if any(delta < 0 for delta in advances):
                pending = None; unassessed('source-clock-regression'); continue
            continuous = all(delta <= 30000 for delta in advances)
            fresh = (gap >= 5 and continuous and ref['id'] != previous['feedResponse']['id']
                     and all(delta >= 5000 for delta in advances))
            if same and fresh and pair is None:
                pair = (tail, [(previous, previous_sample), (quote, sample)])
            if same and continuous and not fresh:
                continue  # Cached/repeated views cannot confirm or move the first witness.
        pending = (tail, quote, sample)
    coverage = {'candidateScanQuotes': reviewed, 'unassessedQuotes': gaps,
                'allUpdatedForecastAccuracyAssessed': False}
    if pair is None:
        return outcome('no-confirmed-miss' if reviewed else 'unknown', **coverage,
                       reason='no-confirmed-pair-in-recorded-quotes' if reviewed else 'no-eligible-updated-window')
    tail, witnesses = pair
    pickup_rows = [s for s in samples if s.get('at') == pickup['at']]
    pickup_sample = pickup_rows[0] if len(pickup_rows) == 1 else None
    pickup_ref = pickup.get('feedResponse') or (pickup_sample or {}).get('feedResponse')
    if (not isinstance(pickup_ref, dict) or pickup_ref.get('state') != 'captured'
            or pickup_ref.get('runId') != journey['id']
            or pickup_ref.get('file') != 'feed-responses/'+journey['id']+'.jsonl'
            or not re.fullmatch(r'[a-f0-9]{64}', str(pickup_ref.get('id', '')))):
        return outcome('unknown', **coverage, reason='pickup-original-source-unavailable')
    bindings = [(q['feedResponse'], s, None) for q, s in witnesses]+[(pickup_ref, pickup_sample, pickup['bus'])]
    references = list({ref['id']: ref for ref, _, _ in bindings}.values())
    detail = {**coverage, 'runId': journey['id'], 'busName': name, 'routeId': route_id,
              'boardStopId': first['boardStopId'], 'tail': tail,
              'confirmationQuotes': [q for q, _ in witnesses],
              'pickupObservation': {**pickup, 'feedResponse': pickup_ref},
              'contextReferences': references}
    originals = {}
    for record in records or []:
        if not isinstance(record, dict):
            return outcome('unknown', **detail, reason='malformed-original-source-record')
        if record.get('id') in originals:
            return outcome('unknown', **detail, reason='duplicate-original-source')
        originals[record.get('id')] = record
    if any(ref['id'] not in originals for ref in references):
        return outcome('needs-source-evidence', **detail, reason='quote-or-pickup-bodies-not-retained')
    try:
        for ref, sample, expected_bus in bindings:
            original = originals[ref['id']]
            raw = verify_feed_response(original)
            keys = ('v', 'runId', 'route', 'sourceKind', 'receivedAt', 'status', 'headers', 'decodedBytes', 'decodedSHA256', 'gzipBytes', 'gzipSHA256')
            if (any(ref.get(k) != original[k] for k in keys) or ref.get('runId') != journey['id']
                    or ref.get('file') != 'feed-responses/'+journey['id']+'.jsonl'):
                raise ValueError('Original response reference differs')
            feed = json.loads(raw)
            at = timestamp(sample['at']) if sample is not None else pickup_at
            age = sample.get('feedAgeMs') if sample is not None else pickup.get('feedAgeMs')
            if (at is None or not number(age) or not 0 <= at-original['receivedAt']/1000 <= 30
                    or abs(at*1000-original['receivedAt']-age) > 1):
                raise ValueError('Original response clock differs')
            if sample is not None:
                if (sample.get('buses') != feed.get('buses')
                        or not all(v == (feed.get('server_eta') or {}).get(k) for k, v in sample.get('server_eta', {}).items())):
                    raise ValueError('Saved source fleet or model differs')
            matches = [b for b in feed.get('buses', []) if bus_name(b.get('bus_name')) == name and b.get('route_id') == route_id]
            if len(matches) != 1 or matches[0].get('bus_id') != provider_id or (expected_bus is not None and matches[0] != expected_bus):
                raise ValueError('Pickup vehicle source differs')
    except (ValueError, TypeError, KeyError, AttributeError, OverflowError, zlib.error):
        return outcome('unknown', **detail, reason='original-updated-window-source-mismatch')
    detail['sourceVerifiedConfirmationQuotes'] = 2
    detail['sourceVerifiedPickupObservation'] = True
    return outcome(tail, **detail)


def audit_bundle(receipt):
    verified = verify_bundle(receipt['directory'])
    if verified['manifestSha256'] != receipt['manifestSha256']:
        raise ValueError('Pickup audit manifest checksum differs')
    directory = Path(receipt['directory'])
    def rows(name):
        with gzip.open(directory/name, 'rt') as file:
            return [json.loads(raw) for raw in file if raw.strip()]
    journeys = rows('journeys.jsonl.gz')
    if len(journeys) != 1:
        return {'state': 'unknown', 'reason': 'missing-or-duplicate-journey'}
    originals = rows('feed-responses.jsonl.gz') if (directory/'feed-responses.jsonl.gz').is_file() else None
    samples = rows('samples.jsonl.gz')
    result = analyze(journeys[0], samples, verified['sampleCoverage'], originals)
    result['updatedWindowAudit'] = updated_window_audit(journeys[0], samples, result, originals)
    return result
