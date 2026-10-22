"""Review completed virtual pickups against their first literal displayed window.

This uses the rider's shared GPS feed, not independent physical arrival truth.
Unusable or changed identities are unknown, never a passing estimate.
"""
import gzip
import json
import math
import re
from datetime import datetime
from pathlib import Path
from evidence import verify_bundle

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


def analyze(journey, samples, coverage):
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
    return analyze(journeys[0], rows('samples.jsonl.gz'), verified['sampleCoverage'])
