#!/usr/bin/env python3
"""Bounded, read-only public response capture; never computes an ETA or outcome."""
import argparse
import datetime as dt
import gzip
import hashlib
from html.parser import HTMLParser
import json
import math
from pathlib import Path
import shutil
import signal
import time
import urllib.error
import urllib.parse
import urllib.request

BASE = 'https://yale-shuttle.fly.dev'
BODY_LIMIT = 8 * 1024 * 1024
RESERVE = 65536
UTC = dt.timezone.utc


def utc():
    return dt.datetime.now(UTC).isoformat()


def digest(data):
    return hashlib.sha256(data).hexdigest()


def utc_end(value):
    result = dt.datetime.fromisoformat(value.replace('Z', '+00:00'))
    if result.utcoffset() != dt.timedelta(0):
        raise ValueError('End time must explicitly use UTC')
    return result


def next_tick(due, finished, interval):
    """Next future monotonic slot; skip overdue slots rather than burst."""
    next_due = due + interval
    skipped = max(0, math.floor((finished - next_due) / interval) + 1)
    return next_due + skipped * interval, skipped


class Assets(HTMLParser):
    def __init__(self):
        super().__init__()
        self.urls = []

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        path = attrs.get('src') if tag == 'script' else (
            attrs.get('href') if tag == 'link' and attrs.get('rel') == 'modulepreload' else None)
        if not path:
            return
        url = urllib.parse.urljoin(BASE + '/', path)
        split = urllib.parse.urlsplit(url)
        if ((split.scheme, split.netloc) == ('https', 'yale-shuttle.fly.dev') and not split.fragment
                and split.path.startswith('/assets/') and split.path.endswith('.js')):
            if url not in self.urls:
                self.urls.append(url)


class StopCapture(Exception):
    pass


class NoRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class Capture:
    def __init__(self, output, until, max_bytes, min_free):
        self.output = Path(output)
        self.output.mkdir(parents=True, exist_ok=False)
        (self.output / 'blobs').mkdir()
        self.until = until
        self.max_bytes, self.min_free = max_bytes, min_free
        self.used = 0
        self.known = set()
        self.sequence = 0
        self.previous = None
        self.last_build = None
        self.release_checks = 0
        self.release_retry = True
        self.stop_requested = False
        self.opener = urllib.request.build_opener(NoRedirects())
        self.manifest = dict(schema=1, base=BASE, startedAt=utc(), until=until.isoformat(),
                             status='running', transportOnly=True, outcomesEvaluated=False,
                             holdoutStatus='not assessed by capture', scriptSha256=digest(Path(__file__).read_bytes()),
                             intervalSeconds=15, healthIntervalSeconds=60, bodyLimitBytes=BODY_LIMIT,
                             maxStoredBytes=max_bytes, minimumFreeBytes=min_free, skippedTicks=0,
                             records=0, completeResponses=0, incompleteResponses=0,
                             buildAttribution='Health brackets only; no assumed intermediate-release identity')
        self.save()

    def save(self):
        self.manifest.update(updatedAt=utc(), records=self.sequence, storedDataBytes=self.used,
                             lastRecordSha256=self.previous)
        tmp = self.output / 'manifest.json.tmp'
        tmp.write_text(json.dumps(self.manifest, indent=2) + '\n')
        tmp.replace(self.output / 'manifest.json')

    def capacity(self, required=0):
        if self.used + required + RESERVE > self.max_bytes:
            raise StopCapture('capture-byte-limit')
        if shutil.disk_usage(self.output).free - required - RESERVE < self.min_free:
            raise StopCapture('filesystem-free-limit')

    def allowed(self):
        if self.stop_requested:
            raise StopCapture('signal')
        if dt.datetime.now(UTC) >= self.until:
            raise StopCapture('deadline')
        self.capacity()

    def record(self, record):
        entry = dict(sequence=self.sequence, previousRecordSha256=self.previous, **record)
        line = (json.dumps(entry, separators=(',', ':'), allow_nan=False) + '\n').encode()
        self.capacity(len(line))
        with (self.output / 'records.jsonl').open('ab') as f:
            f.write(line)
        self.used += len(line)
        self.sequence += 1
        self.previous = digest(line)
        if entry.get('kind') != 'schedule-gap':
            field = 'completeResponses' if entry.get('transportComplete') else 'incompleteResponses'
            self.manifest[field] += 1
        self.save()
        return entry

    def request(self, url, kind):
        self.allowed()
        if not url.startswith(BASE + '/'):
            raise ValueError('Only the fixed public origin is permitted')
        record = dict(kind=kind, url=url, requestedAt=utc(), requestMonotonic=time.monotonic(),
                      transportComplete=False, status=None, headers={}, readComplete=False)
        chunks, count, response, error_type = [], 0, None, None
        try:
            req = urllib.request.Request(url, headers={'Accept-Encoding': 'identity',
                                                       'User-Agent': 'Yale-shuttle-window-research/1'})
            try:
                response = self.opener.open(req, timeout=10)
            except urllib.error.HTTPError as error:
                response = error
            with response:
                record['status'] = response.getcode()
                record['headers'] = {k: response.headers.get(k) for k in
                    ('Date', 'Content-Type', 'Content-Encoding', 'Content-Length', 'ETag', 'Cache-Control')}
                while count <= BODY_LIMIT:
                    chunk = response.read(min(65536, BODY_LIMIT + 1 - count))
                    if not chunk:
                        record['readComplete'] = True
                        break
                    chunks.append(chunk)
                    count += len(chunk)
                if count > BODY_LIMIT:
                    error_type = 'BodyLimitExceeded'
        except Exception as error:
            error_type = type(error).__name__
        finally:
            record.update(receivedAt=utc(), receivedMonotonic=time.monotonic())
        body = b''.join(chunks)[:BODY_LIMIT]
        record.update(bodyBytes=len(body), bodySha256=digest(body), errorType=error_type)
        record['transportComplete'] = bool(record['status'] == 200 and record['readComplete'] and not error_type)
        blob = record['bodySha256'] + '.gz'
        compressed = gzip.compress(body, compresslevel=1, mtime=0)
        record.update(blob='blobs/' + blob, blobSha256=digest(compressed), blobBytes=len(compressed))
        try:
            self.capacity((0 if blob in self.known else len(compressed)) + 8192)
        except StopCapture:
            self.manifest['unpersistedResponse'] = dict(url=url, kind=kind, requestedAt=record['requestedAt'],
                receivedAt=record['receivedAt'], bodySha256=record['bodySha256'], bodyBytes=len(body),
                reason='storage guard; response body was not saved')
            raise
        if blob not in self.known:
            with (self.output / record['blob']).open('xb') as f:
                f.write(compressed)
            self.used += len(compressed)
            self.known.add(blob)
        parsed = None
        if kind in ('fleet', 'health'):
            try:
                if record['headers'].get('Content-Encoding') not in (None, '', 'identity'):
                    raise ValueError('Unexpected body encoding')
                parsed = json.loads(body, parse_constant=lambda x: (_ for _ in ()).throw(ValueError(x)))
                if not isinstance(parsed, dict):
                    raise ValueError('Expected an object')
                record['jsonObject'] = True
                if kind == 'fleet':
                    record['fleetSchema'] = isinstance(parsed.get('buses'), list)
                    record['busCount'] = len(parsed['buses']) if record['fleetSchema'] else None
                    eta = parsed.get('server_eta')
                    record['hasServerEta'] = isinstance(eta, dict)
                    if isinstance(eta, dict):
                        record['forecastAt'] = eta.get('at')
                        record['servedAt'] = eta.get('servedAt')
                elif isinstance(parsed.get('build'), str):
                    record['build'] = parsed['build']
            except (ValueError, UnicodeError, TypeError):
                record['jsonObject'] = False
                parsed = None
        entry = self.record(record)
        return entry, body, parsed

    def release(self):
        health, _, parsed = self.request(BASE + '/healthz', 'health')
        build = parsed.get('build') if parsed and health['transportComplete'] else None
        if not isinstance(build, str):
            build = None
        if self.release_retry or (build is not None and build != self.last_build):
            self.release_retry = True
            html, body, _ = self.request(BASE + '/', 'html')
            if html['transportComplete']:
                parser = Assets()
                parser.feed(body.decode('utf-8', errors='replace'))
                # A bound also prevents malformed HTML causing an unbounded fetch list.
                if len(parser.urls) > 32:
                    self.manifest['assetCaptureError'] = 'TooManyModuleResources'
                elif parser.urls:
                    assets_complete = True
                    for url in parser.urls:
                        asset, _, _ = self.request(url, 'module')
                        assets_complete = assets_complete and asset['transportComplete']
                    self.release_retry = not assets_complete
            if not self.release_retry:
                self.last_build = build
            self.manifest['releaseCaptureNeedsRetry'] = self.release_retry
        self.release_checks += 1

    def run(self):
        due = time.monotonic()
        health_due = due
        try:
            while True:
                self.allowed()
                if time.monotonic() < due:
                    time.sleep(min(due - time.monotonic(), 1))
                    continue
                if time.monotonic() >= health_due:
                    self.release()
                    health_due, _ = next_tick(health_due, time.monotonic(), 60)
                self.request(BASE + '/api/buses', 'fleet')
                due, skipped = next_tick(due, time.monotonic(), 15)
                if skipped:
                    self.manifest['skippedTicks'] += skipped
                    self.record(dict(kind='schedule-gap', at=utc(), skippedTicks=skipped, nextMonotonic=due))
        except StopCapture as stop:
            self.manifest.update(status='stopped', stopReason=str(stop), finishedAt=utc())
        except BaseException as error:
            self.manifest.update(status='failed', errorType=type(error).__name__, finishedAt=utc())
            raise
        finally:
            self.save()
            print(json.dumps(self.manifest), flush=True)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('output', type=Path)
    parser.add_argument('--until', type=utc_end, required=True)
    parser.add_argument('--max-bytes', type=int, default=3 * 1024**3)
    parser.add_argument('--minimum-free-bytes', type=int, default=4 * 1024**3)
    args = parser.parse_args(argv)
    if args.until <= dt.datetime.now(UTC):
        parser.error('End time must be in the future')
    if args.max_bytes <= RESERVE or args.minimum_free_bytes < 0:
        parser.error('Invalid storage bounds')
    capture = Capture(args.output, args.until, args.max_bytes, args.minimum_free_bytes)
    def stop(_signal, _frame):
        capture.stop_requested = True
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    capture.run()


if __name__ == '__main__':
    main()
