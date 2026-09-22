#!/usr/bin/env python3
"""Read-only evidence capture. No fitting, replay, or outcome scoring.

Keep original archive wrappers; a valid trailer proves transport only.
Every invocation requires a new output directory and preserves failed pulls.
"""
import argparse
import datetime as dt
import gzip
import hashlib
import json
from pathlib import Path
import urllib.request
from zoneinfo import ZoneInfo

BASE = 'https://yale-shuttle.fly.dev'
TABLES = ('raw_positions', 'arrivals', 'stop_visits', 'legs',
          'predictions_log', 'upstream_etas', 'scorecard_days')


def now():
    return dt.datetime.now(dt.timezone.utc).isoformat()


def sha(path):
    h = hashlib.sha256()
    with path.open('rb') as f:
        for chunk in iter(lambda: f.read(65536), b''):
            h.update(chunk)
    return h.hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('day')
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    day = dt.date.fromisoformat(args.day)
    assert args.day == day.isoformat()
    zone = ZoneInfo('America/New_York')
    start = dt.datetime.combine(day, dt.time(), zone)
    end = dt.datetime.combine(day + dt.timedelta(days=1), dt.time(), zone)
    assert dt.datetime.now(zone) >= end, 'Capture only a closed calendar day'
    token = (Path.home() / '.yale-shuttle-admin-token').read_text().strip()
    assert token
    args.output.mkdir(parents=True, exist_ok=False)
    manifest = dict(schema=1, day=args.day, base=BASE, startedAt=now(),
                    fromMs=int(start.timestamp()*1000), toMs=int(end.timestamp()*1000),
                    calendarDayClosed=True, labelsFinal=False,
                    transportComplete=False, serviceCoverage='not evaluated',
                    untouchedHoldout=False,
                    limitations=[
                        'Sep21 Red examples were previously inspected; this day is exploratory.',
                        'Rows may still finalize after export, especially across ET midnight.',
                        'Tables are sequential snapshots, not a single database transaction.',
                        'Header build is export-time server build, not each row creation build.',
                        'GPS retention is 36h; complete transport does not establish service coverage.',
                        'Adjacent-day context and chronological knownAt checks are required in hosted replay.',
                    ], tables={}, snapshots={})

    def save():
        tmp = args.output / 'manifest.json.tmp'
        tmp.write_text(json.dumps(manifest, indent=2)+'\n')
        tmp.replace(args.output / 'manifest.json')

    def snapshot(name, endpoint):
        entry = dict(endpoint=endpoint, startedAt=now())
        manifest['snapshots'][name] = entry
        try:
            with urllib.request.urlopen(BASE+endpoint, timeout=60) as response:
                data = response.read()
                entry['serverDate'] = response.headers.get('Date')
            value = json.loads(data)
            file = args.output / (name+'.json')
            with file.open('xb') as f:
                f.write(data)
            entry.update(file=file.name, sha256=sha(file), bytes=len(data), complete=True)
            if endpoint == '/healthz':
                entry['build'] = value.get('build')
        except Exception as error:
            entry.update(complete=False, errorType=type(error).__name__)
        entry['finishedAt'] = now()
        save()

    save()
    snapshot('health-before', '/healthz')
    snapshot('fleet-before', '/api/buses')
    for table in TABLES:
        entry = dict(startedAt=now(), transportComplete=False)
        manifest['tables'][table] = entry
        file = args.output / (table+'.original.jsonl.gz')
        try:
            req = urllib.request.Request(BASE+'/api/archive/day?day='+args.day+'&table='+table,
                                         headers={'x-admin-token': token})
            count, first, last, raw_bytes = 0, None, None, 0
            raw_hash = hashlib.sha256()
            with urllib.request.urlopen(req, timeout=90) as response, file.open('xb') as target:
                entry['serverDate'] = response.headers.get('Date')
                entry['contentType'] = response.headers.get('Content-Type')
                assert 'ndjson' in (entry['contentType'] or '')
                with gzip.GzipFile(filename='', mode='wb', fileobj=target, compresslevel=1, mtime=0) as zipped:
                    for line in response:
                        zipped.write(line)
                        raw_hash.update(line)
                        raw_bytes += len(line)
                        if not line.strip():
                            continue
                        count += 1
                        if first is None:
                            first = json.loads(line)
                        last = line
            trailer = json.loads(last) if last else None
            entry.update(header=first, trailer=trailer, observedRows=max(0, count-2),
                         rawSha256=raw_hash.hexdigest(), rawBytes=raw_bytes)
            assert first['table'] == table and first['day'] == args.day
            assert first['from'] == manifest['fromMs'] and first['to'] == manifest['toMs']
            assert count >= 2 and trailer.get('end') is True
            assert trailer['rows'] == count-2
            entry['transportComplete'] = True
        except Exception as error:
            entry['errorType'] = type(error).__name__
        if file.exists():
            entry.update(file=file.name, sha256=sha(file), bytes=file.stat().st_size)
        entry['finishedAt'] = now()
        save()
        print(json.dumps(dict(table=table, rows=entry.get('observedRows'),
                              transportComplete=entry['transportComplete'])), flush=True)
    snapshot('fleet-after', '/api/buses')
    snapshot('health-after', '/healthz')
    manifest['finishedAt'] = now()
    manifest['transportComplete'] = all(x['transportComplete'] for x in manifest['tables'].values())
    manifest['captureScriptSha256'] = sha(Path(__file__))
    save()
    print(str(args.output / 'manifest.json'), flush=True)
    if not manifest['transportComplete']:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
