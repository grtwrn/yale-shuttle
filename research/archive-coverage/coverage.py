"""Audit archived fleet evidence. Run complete scans on a hosted runner only."""
import argparse
import bisect
import collections
import datetime as dt
import gzip
import hashlib
import json
from pathlib import Path
from zoneinfo import ZoneInfo

ET = ZoneInfo('America/New_York')
BUCKET_MS = 15 * 60_000
TABLE_TIME = {'raw_positions': 'collected_at', 'arrivals': 'arrived_at',
              'stop_visits': 'anchored_at', 'legs': 'departed_at',
              'predictions_log': 'predicted_at', 'upstream_etas': 'sampled_at'}
REQUIRED = {'raw_positions', 'stop_visits', 'arrivals', 'predictions_log'}


def bounds(day):
    date = dt.date.fromisoformat(day)
    return tuple(int(dt.datetime.combine(d, dt.time(), ET).timestamp() * 1000)
                 for d in (date, date + dt.timedelta(days=1)))


def parse_time(value):
    if isinstance(value, (int, float)):
        return value
    if value:
        return dt.datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp() * 1000
    return None


def finality(day, exported_at=None, frozen_at=None):
    end = bounds(day)[1]
    if exported_at is not None:
        return 'closed' if parse_time(exported_at) >= end else 'partial'
    if frozen_at is not None and parse_time(frozen_at) < end:
        return 'partial'
    return 'unknown_export_finality'


def norm_bus(value):
    return str(value or '').strip().removeprefix('#').strip()


def interval_supported(times, start, end):
    """Coverage only: not proof of correct detector truth or route occurrence."""
    if not times or end < start:
        return False
    a = bisect.bisect_left(times, start)
    b = bisect.bisect_left(times, end)
    near = lambda i, t: min((abs(times[j] - t) for j in (i - 1, i)
                             if 0 <= j < len(times)), default=float('inf'))
    if near(a, start) > 30_000 or near(b, end) > 30_000:
        return False
    # Include the samples bracketing each edge, but no extra sample beyond them.
    segment = times[max(0, a - 1):min(len(times), b + 1)]
    return all(y - x <= 60_000 for x, y in zip(segment, segment[1:]))


def inspect_file(file, entry, table, day):
    """Return rows plus independent byte/stream/row/schema evidence."""
    problems = []
    info = {'table': table, 'day': day, 'path': entry['path'],
            'stream': 'not_preserved', 'originalDeclaredRows': entry.get('rows'),
            'originalCompleteFlag': entry.get('complete'), 'errors': problems}
    if not file.is_file():
        problems.append('missing_file')
        return [], info
    payload = file.read_bytes()
    info.update(bytes=len(payload), sha256=hashlib.sha256(payload).hexdigest())
    if entry.get('sha256') is None:
        problems.append('missing_sha256')
    elif info['sha256'] != entry['sha256']:
        problems.append('sha256_mismatch')
    if entry.get('bytes') is not None and entry['bytes'] != len(payload):
        problems.append('byte_count_mismatch')
    try:
        text = gzip.decompress(payload).decode() if file.suffix == '.gz' else payload.decode()
        objects = [json.loads(line) for line in text.splitlines() if line.strip()]
    except (OSError, UnicodeError, ValueError) as exc:
        problems.append('unreadable_' + type(exc).__name__)
        return [], info
    header = objects.pop(0) if objects and 'table' in objects[0] and 'day' in objects[0] else None
    trailers = [i for i, row in enumerate(objects) if row.get('end') is True]
    if header is not None:
        info['stream'] = 'verified'
        if header.get('table') != table or header.get('day') != day:
            problems.append('stream_header_mismatch')
        if (header.get('from'), header.get('to')) != bounds(day):
            problems.append('stream_bounds_mismatch')
        if trailers != [len(objects) - 1]:
            problems.append('missing_or_misplaced_trailer')
        elif objects[-1].get('rows') != len(objects) - 1:
            problems.append('stream_row_count_mismatch')
        if problems:
            info['stream'] = 'invalid'
    elif trailers:
        problems.append('trailer_without_header')
        info['stream'] = 'invalid'
    rows = [row for row in objects if row.get('end') is not True]
    info['rows'] = len(rows)
    if entry.get('rows') is not None and entry['rows'] != len(rows):
        problems.append('manifest_row_count_mismatch')
    if entry.get('complete') is False:
        problems.append('original_manifest_incomplete')
    lo, hi = bounds(day)
    expected_columns = entry.get('columns') or (header or {}).get('columns')
    seen = {}
    duplicates = conflicts = 0
    for row in rows:
        if table in TABLE_TIME:
            at = row.get(TABLE_TIME[table])
            if not isinstance(at, (int, float)) or not lo <= at < hi:
                problems.append('invalid_or_out_of_day_timestamp')
        if expected_columns and set(row) != set(expected_columns):
            problems.append('schema_columns_mismatch')
        key = (row.get('bus_id'), row.get('collected_at')) if table == 'raw_positions' else row.get('id')
        if key is not None:
            digest = hashlib.sha256(json.dumps(row, sort_keys=True).encode()).digest()
            if key in seen:
                duplicates += 1
                conflicts += digest != seen[key]
            seen[key] = digest
    info.update(duplicateRows=duplicates, conflictingRows=conflicts)
    if conflicts:
        problems.append('conflicting_duplicate_identity')
    info['errors'] = sorted(set(problems))
    return rows, info


def audit(data_root, topology, frozen_at=None, days=None):
    """Accept a research manifest.sources or original per-day manifests."""
    data_root = Path(data_root)
    manifest_path = data_root / 'manifest.json'
    catalog = json.loads(manifest_path.read_text()) if manifest_path.exists() else {}
    entries = catalog.get('sources', [])
    day_meta = {}
    if not entries:
        entries = []
        for path in sorted(data_root.glob('????-??-??/manifest.json')):
            meta = json.loads(path.read_text())
            day_meta[meta['day']] = meta
            for table, item in meta['tables'].items():
                entries.append({**item, 'path': f"{meta['day']}/{item['file']}", 'table': table})
    else:
        for day in {Path(e['path']).parts[0] for e in entries}:
            path = data_root / day / 'manifest.json'
            if path.exists():
                day_meta[day] = json.loads(path.read_text())
    route_names = {int(r['id']): r['name'] for r in topology['routes']}
    selected = sorted({Path(e['path']).parts[0] for e in entries} & set(days or [Path(e['path']).parts[0] for e in entries]))
    source_info, bucket_records, summaries, day_results = [], [], [], []
    for day in selected:
        tables = {}
        for entry in entries:
            rel = Path(entry['path'])
            if rel.parts[0] != day:
                continue
            if rel.is_absolute() or '..' in rel.parts:
                raise ValueError('Unsafe source path')
            table = entry.get('table') or rel.name.split('.')[0]
            if table not in TABLE_TIME and table != 'scorecard_days':
                raise ValueError('Unapproved fleet table: ' + table)
            original = day_meta.get(day, {}).get('tables', {}).get(table, {})
            rows, info = inspect_file(data_root / rel, {**original, **entry}, table, day)
            tables[table] = rows
            source_info.append(info)
        buckets = collections.defaultdict(lambda: collections.Counter())
        times = collections.defaultdict(list)
        visit_intervals = collections.defaultdict(list)
        predictions = collections.defaultdict(collections.Counter)
        builds = collections.defaultdict(collections.Counter)
        route_totals = collections.defaultdict(collections.Counter)
        def record(row, at, name):
            route, bus = row.get('route_id'), norm_bus(row.get('bus_name'))
            if not isinstance(route, int) or not isinstance(at, (int, float)):
                return
            lo, hi = bounds(day)
            if lo <= at < hi:
                buckets[route, bus, int(at // BUCKET_MS) * BUCKET_MS][name] += 1
                route_totals[route][name] += 1
        for row in tables.get('raw_positions', []):
            at = row.get('collected_at')
            record(row, at, 'gps')
            if isinstance(at, (int, float)):
                times[row.get('route_id'), norm_bus(row.get('bus_name'))].append(at)
        for ts in times.values():
            ts.sort()
        for table, name in [('stop_visits', 'visit'), ('arrivals', 'arrival')]:
            for row in tables.get(table, []):
                record(row, row.get(TABLE_TIME[table]), name)
                if table == 'stop_visits':
                    start, end = row.get('arrived_at'), row.get('departed_at')
                    if row.get('how') != 'gap' and row.get('outcome') in ('passed', 'stopped') and isinstance(start, (int, float)) and isinstance(end, (int, float)) and end >= start:
                        visit_intervals[row.get('route_id')].append((norm_bus(row.get('bus_name')), start, end))
        for row in tables.get('predictions_log', []):
            surface = row.get('surface', 'unknown')
            record(row, row.get('predicted_at'), 'prediction:' + surface)
            predictions[row.get('route_id')][surface] += 1
            builds[row.get('route_id')][str(row.get('client_build'))] += 1
        for row in tables.get('upstream_etas', []):
            record(row, row.get('sampled_at'), 'upstream_census')
        gps_gaps = collections.Counter()
        evidence_counts = collections.Counter()
        for (route, bus, at), counts in sorted(buckets.items()):
            evidence = bool(counts['visit'] or counts['arrival'])
            evidence_counts[route] += evidence
            gps_gaps[route] += evidence and not counts['gps']
            bucket_records.append(dict(day=day, route=route, bus=bus, bucketAt=at,
                counts=dict(counts), gpsAbsentWithObservedService=evidence and not counts['gps']))
        status = finality(day, day_meta.get(day, {}).get('generatedAt'), frozen_at)
        input_errors = [i for i in source_info if i['day'] == day and i['errors']]
        missing = sorted(REQUIRED - tables.keys())
        day_reasons = []
        if status != 'closed':
            day_reasons.append(status)
        if missing:
            day_reasons.append('required_tables_missing')
        if input_errors:
            day_reasons.append('input_integrity_errors')
        for route in sorted(set(route_names) | set(route_totals)):
            totals = route_totals[route]
            intervals = visit_intervals[route]
            supported = sum(interval_supported(times[route, bus], start, end) for bus, start, end in intervals)
            observed = bool(totals['gps'] or totals['visit'] or totals['arrival'])
            reasons = list(day_reasons)
            if not observed:
                reasons.append('service_status_unknown')
            if gps_gaps[route]:
                reasons.append('gps_absent_with_observed_service')
            if supported < len(intervals):
                reasons.append('visit_intervals_without_continuous_gps')
            if not sum(n for s, n in predictions[route].items() if s in ('trip', 'ride', 'card')):
                reasons.append('no_rider_prediction_rows')
            summaries.append(dict(day=day, route=route, name=route_names.get(route, 'unpublished'),
                status='observed_service' if observed else 'unknown_service', totals=dict(totals),
                serviceBuckets=evidence_counts[route], serviceBucketsWithoutGps=gps_gaps[route],
                completedVisitIntervals=len(intervals), gpsSupportedVisitIntervals=supported,
                predictionSurfaces=dict(predictions[route]), clientBuilds=dict(builds[route]),
                observedEvidenceChecksPass=not reasons,
                serviceDayCompleteness='unproven_without_independent_service_record',
                predictionCoverage='sampled_viewed_stops' if sum(n for s, n in predictions[route].items() if s in ('trip', 'ride', 'card')) else 'no_rider_observations',
                reasons=reasons))
        day_results.append(dict(day=day, finality=status, missingTables=missing,
                                inputErrors=len(input_errors), reasons=day_reasons))
    return dict(version=1, frozenAt=frozen_at, bucketSeconds=900,
                gpsEndpointToleranceSeconds=30, gpsMaximumGapSeconds=60,
                sources=source_info, days=day_results, routes=summaries, buckets=bucket_records,
                caveats=[
                    'No schedule or poll heartbeat archive: all-stream absence is unknown service, not proof of no service.',
                    'Per-route GPS coverage is relative to recorded visit/arrival evidence; jointly missing sources remain undetectable.',
                    'Visit continuity is a coverage screen, not proof of truth, route occurrence, or journey eligibility.',
                    'Cross-midnight visit intervals need adjacent-day GPS; this per-day audit marks them unsupported conservatively.',
                    'Prediction logs sample viewed stops, not the fleet. Never substitute upstream predictions for rider surfaces.',
                    'Manifest build is export-time provenance; client_build does not identify server-only estimator changes.',
                    'Original archived files usually omit transport headers/trailers; their absence remains explicit.',
                ])


def write_report(result, output):
    output = Path(output)
    output.mkdir(parents=True, exist_ok=True)
    rows = result.pop('buckets')
    with gzip.open(output / 'buckets.jsonl.gz', 'wt') as file:
        for row in rows:
            file.write(json.dumps(row, separators=(',', ':')) + '\n')
    (output / 'coverage.json').write_text(json.dumps(result, indent=2) + '\n')
    lines = ['# Archived fleet coverage', '',
        'This is an evidence audit. A successful research workflow does not mean every source/day is complete.', '',
        '| Day | Line | GPS rows | Visits | Service buckets missing GPS | Visit intervals with continuous GPS | Rider prediction rows |',
        '|---|---|---:|---:|---:|---:|---:|']
    for row in result['routes']:
        t = row['totals']
        rider = sum(n for s, n in row['predictionSurfaces'].items() if s in ('trip', 'ride', 'card'))
        lines.append(f"| {row['day']} | {row['name']} | {t.get('gps', 0)} | {t.get('visit', 0)} | {row['serviceBucketsWithoutGps']}/{row['serviceBuckets']} | {row['gpsSupportedVisitIntervals']}/{row['completedVisitIntervals']} | {rider} |")
    lines += ['', '## Day provenance', ''] + [f"- {row['day']}: {row['finality']}; missing tables: {', '.join(row['missingTables']) or 'none'}; input errors: {row['inputErrors']}." for row in result['days']]
    lines += ['', '## Limits', ''] + ['- ' + text for text in result['caveats']]
    (output / 'REPORT.md').write_text('\n'.join(lines) + '\n')


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--data-root', required=True)
    p.add_argument('--topology', required=True)
    p.add_argument('--topology-sha256', required=True)
    p.add_argument('--frozen-at')
    p.add_argument('--days', nargs='+')
    p.add_argument('--output', required=True)
    p.add_argument('--require-observed-coverage', action='store_true')
    args = p.parse_args()
    payload = Path(args.topology).read_bytes()
    if hashlib.sha256(payload).hexdigest() != args.topology_sha256:
        raise ValueError('Topology hash mismatch')
    result = audit(args.data_root, json.loads(payload), args.frozen_at, args.days)
    result['topologySha256'] = args.topology_sha256
    ready = all(r['observedEvidenceChecksPass'] for r in result['routes']) and bool(result['routes'])
    write_report(result, args.output)
    print(json.dumps({'days': len(result['days']), 'routes': len(result['routes']), 'allObservedEvidenceChecksPass': ready,
                      'inputErrors': sum(bool(s['errors']) for s in result['sources'])}))
    if args.require_observed_coverage and not ready:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
