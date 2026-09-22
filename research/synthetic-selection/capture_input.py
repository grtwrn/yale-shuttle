"""Read-only, bounded verifier for sealed public-fleet timeline prefixes.

No network calls, ETA computation, outcome joining, or candidate activation.
The caller must consume verification-complete before publishing derived rows.
"""
from collections import OrderedDict
import datetime as dt
import hashlib
from html.parser import HTMLParser
import json
import math
from pathlib import Path
import re
import shutil
import urllib.parse
import zlib

BASE = 'https://yale-shuttle.fly.dev'
RECORDER = 'bae23b33211c73589ede784bf32d3485124874d1'
SCRIPT_SHA256 = '4f494f132da14bd369b768605190a77319ef1586e326f062289ec6f1274115b3'
BODY_LIMIT = 8 * 1024 * 1024
LINE_LIMIT = 2 * BODY_LIMIT + 65536
HEX = re.compile(r'^[0-9a-f]{64}$')
HEADERS = {'Date', 'Content-Type', 'Content-Encoding', 'Content-Length', 'ETag', 'Cache-Control'}
UTC = dt.timezone.utc


class IntegrityError(ValueError):
    pass


def require(value, message):
    if not value:
        raise IntegrityError(message)


def digest(value):
    return hashlib.sha256(value).hexdigest()


def finite(value):
    try:
        return type(value) in (int, float) and math.isfinite(value)
    except OverflowError:
        return False


def integer(value, minimum=0):
    return type(value) is int and value >= minimum


def utc_ms(value):
    require(isinstance(value, str), 'UTC timestamp must be a string')
    try:
        parsed = dt.datetime.fromisoformat(value.replace('Z', '+00:00'))
    except ValueError as error:
        raise IntegrityError('Invalid UTC timestamp') from error
    require(parsed.utcoffset() == dt.timedelta(0), 'Timestamp must explicitly use UTC')
    return parsed.timestamp() * 1000


def parse_json(raw, reject_duplicates=True):
    duplicates = []
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                duplicates.append(key)
            result[key] = value
        return result
    def number(value):
        value = float(value)
        if not math.isfinite(value):
            raise ValueError('Nonfinite number')
        return value
    parsed = json.loads(raw, object_pairs_hook=pairs, parse_float=number,
                        parse_constant=lambda value: (_ for _ in ()).throw(ValueError(value)))
    require(not reject_duplicates or not duplicates, 'Duplicate JSON key')
    return parsed, duplicates


def json_record(raw):
    try:
        parsed, _ = parse_json(raw)
    except (ValueError, UnicodeError, RecursionError) as error:
        raise IntegrityError('Invalid strict JSON record') from error
    require(isinstance(parsed, dict), 'Expected JSON object')
    return parsed


def regular(root, relative):
    path = root / relative
    require(not Path(relative).is_absolute() and '..' not in Path(relative).parts, 'Path escape')
    for part in [path, *path.parents]:
        if part == root.parent:
            break
        require(not part.is_symlink(), 'Symlink input forbidden')
    require(path.is_file() and path.resolve().is_relative_to(root.resolve()), 'Missing/nonregular input file')
    return path


def bounded_bytes(path, limit):
    require(path.stat().st_size <= limit, 'Input exceeds bounded size')
    with path.open('rb') as handle:
        value = handle.read(limit + 1)
    require(len(value) <= limit, 'Input grew beyond bounded size')
    return value


def file_hash(path, length=None):
    hashed = hashlib.sha256()
    count = 0
    with path.open('rb') as handle:
        while chunk := handle.read(65536):
            hashed.update(chunk)
            count += len(chunk)
            require(length is None or count <= length, 'File exceeds sealed length')
    require(length is None or count == length, 'File shorter than sealed length')
    return hashed.hexdigest(), count


def blob_path(entry):
    body_hash = entry.get('bodySha256')
    require(isinstance(body_hash, str) and HEX.fullmatch(body_hash), 'Invalid body hash')
    expected = 'blobs/' + body_hash + '.gz'
    require(entry.get('blob') == expected, 'Invalid content-addressed blob path')
    return expected


def freeze_prefix(source, output, records):
    """Copy a caller-chosen completed prefix; never discovers/opens future rows.

    Not invoked on an actual running capture by this research task. An incomplete
    destination has no prefix.json seal and must never be consumed.
    """
    source, output = Path(source), Path(output)
    require(integer(records, 1), 'Positive fixed record count required')
    require(not output.exists(), 'Prefix destination already exists')
    journal = regular(source, 'records.jsonl')
    output.mkdir(parents=True, exist_ok=False)
    (output / 'blobs').mkdir()
    copied = set()
    hashed = hashlib.sha256()
    count = 0
    last_hash = None
    with journal.open('rb') as src, (output / 'records.jsonl').open('xb') as dest:
        for _ in range(records):
            line = src.readline(LINE_LIMIT + 1)
            require(line.endswith(b'\n') and len(line) <= LINE_LIMIT, 'Selected prefix lacks complete final record')
            entry = json_record(line)
            if entry.get('kind') != 'schedule-gap':
                relative = blob_path(entry)
                if relative not in copied:
                    origin_blob = regular(source, relative)
                    require(origin_blob.stat().st_size <= BODY_LIMIT + 65536, 'Source blob exceeds recorder bound')
                    shutil.copyfile(origin_blob, output / relative)
                    copied.add(relative)
            dest.write(line)
            hashed.update(line)
            count += len(line)
            last_hash = digest(line)
    manifest = bounded_bytes(regular(source, 'manifest.json'), 1024 * 1024)
    (output / 'manifest.json').write_bytes(manifest)
    seal = dict(schema=1, recorderCommit=RECORDER, recorderScriptSha256=SCRIPT_SHA256,
                records=records, journalBytes=count, journalSha256=hashed.hexdigest(),
                lastRecordSha256=last_hash, manifestBytes=len(manifest), manifestSha256=digest(manifest))
    raw = (json.dumps(seal, sort_keys=True, separators=(',', ':')) + '\n').encode()
    (output / 'prefix.json').write_bytes(raw)
    return digest(raw)


def request_url(entry):
    kind, url = entry.get('kind'), entry.get('url')
    allowed = {'fleet': BASE + '/api/buses', 'health': BASE + '/healthz', 'html': BASE + '/'}
    if kind in allowed:
        require(url == allowed[kind], 'Unexpected fixed public endpoint')
    else:
        require(kind == 'module' and isinstance(url, str), 'Unexpected record kind')
        split = urllib.parse.urlsplit(url)
        require((split.scheme, split.netloc) == ('https', 'yale-shuttle.fly.dev')
                and not split.fragment and split.path.startswith('/assets/') and split.path.endswith('.js'),
                'Unexpected module endpoint')


def decode_body(entry, raw):
    """Recorder metadata is recomputed even for a failed or partial response."""
    kind = entry['kind']
    parsed, duplicates = None, []
    expected = {}
    if kind in ('health', 'fleet'):
        try:
            if entry['headers'].get('Content-Encoding') not in (None, '', 'identity'):
                raise ValueError('Unexpected encoding')
            parsed, duplicates = parse_json(raw, reject_duplicates=False)
            if not isinstance(parsed, dict):
                raise ValueError('Expected object')
            expected['jsonObject'] = True
            if kind == 'fleet':
                expected['fleetSchema'] = isinstance(parsed.get('buses'), list)
                expected['busCount'] = len(parsed['buses']) if expected['fleetSchema'] else None
                eta = parsed.get('server_eta')
                expected['hasServerEta'] = isinstance(eta, dict)
                if isinstance(eta, dict):
                    expected.update(forecastAt=eta.get('at'), servedAt=eta.get('servedAt'))
            elif isinstance(parsed.get('build'), str):
                expected['build'] = parsed['build']
        except (ValueError, UnicodeError, TypeError, RecursionError):
            parsed = None
            expected = {'jsonObject': False}
    fields = {'jsonObject', 'fleetSchema', 'busCount', 'hasServerEta', 'forecastAt', 'servedAt', 'build'}
    require({k: entry[k] for k in fields if k in entry} == expected, 'Recorder JSON/schema/clock metadata mismatch')
    ready = (kind == 'fleet' and entry['transportComplete'] and expected.get('fleetSchema') is True and not duplicates)
    reason = ('transport_incomplete' if not entry['transportComplete'] else
              'ambiguous_duplicate_json_keys' if duplicates else
              'invalid_json_or_fleet_schema' if kind == 'fleet' and not expected.get('fleetSchema') else None)
    return parsed, duplicates, bool(ready), reason


def iter_verified(prefix, expected_seal_sha256):
    """Yield VerifiedRecord dictionaries then one verification-complete record.

    Raw body bytes are retained alongside parsed metadata. Cache holds at most
    sixteen small bodies; large bodies are bounded and released per iteration.
    """
    root = Path(prefix)
    require(isinstance(expected_seal_sha256, str) and HEX.fullmatch(expected_seal_sha256), 'External seal hash required')
    raw_seal = bounded_bytes(regular(root, 'prefix.json'), 65536)
    require(digest(raw_seal) == expected_seal_sha256, 'Prefix seal hash mismatch')
    seal = json_record(raw_seal)
    require(type(seal.get('schema')) is int and seal.get('schema') == 1 and seal.get('recorderCommit') == RECORDER
            and seal.get('recorderScriptSha256') == SCRIPT_SHA256, 'Unsupported recorder/seal schema')
    require(integer(seal.get('records'), 1) and integer(seal.get('journalBytes'), 1)
            and integer(seal.get('manifestBytes'), 1), 'Invalid sealed count/length')
    journal = regular(root, 'records.jsonl')
    journal_hash, journal_bytes = file_hash(journal, seal['journalBytes'])
    require(journal_hash == seal.get('journalSha256'), 'Sealed journal hash mismatch')
    raw_manifest = bounded_bytes(regular(root, 'manifest.json'), 1024 * 1024)
    require(len(raw_manifest) == seal.get('manifestBytes') and digest(raw_manifest) == seal.get('manifestSha256'), 'Manifest snapshot mismatch')
    manifest = json_record(raw_manifest)
    require(type(manifest.get('schema')) is int and manifest.get('schema') == 1 and manifest.get('base') == BASE
            and manifest.get('scriptSha256') == SCRIPT_SHA256 and manifest.get('bodyLimitBytes') == BODY_LIMIT
            and manifest.get('intervalSeconds') == 15 and manifest.get('healthIntervalSeconds') == 60
            and manifest.get('transportOnly') is True and manifest.get('outcomesEvaluated') is False, 'Unsupported capture manifest')
    utc_ms(manifest.get('startedAt')); utc_ms(manifest.get('until')); utc_ms(manifest.get('updatedAt'))
    mcount = manifest.get('records')
    require(integer(mcount), 'Invalid manifest count')
    require(all(integer(manifest.get(k)) for k in ('completeResponses','incompleteResponses','skippedTicks','storedDataBytes')), 'Invalid manifest counter types')
    previous, last_mono, last_wall, unsafe = None, None, None, False
    complete = incomplete = gaps = referenced_bytes = 0
    count = 0
    blobs = {}
    cache = OrderedDict()
    manifest_at_count = None
    if mcount == 0:
        manifest_at_count = dict(head=None, complete=0, incomplete=0, gaps=0)
    with journal.open('rb') as handle:
        while line := handle.readline(LINE_LIMIT + 1):
            require(line.endswith(b'\n') and len(line) <= LINE_LIMIT, 'Unfinished/oversized journal record')
            entry = json_record(line)
            require(entry.get('sequence') == count and type(entry.get('sequence')) is int, 'Noncontiguous record sequence')
            require(entry.get('previousRecordSha256') == previous, 'Journal chain mismatch')
            previous = digest(line)
            count += 1
            require(count <= seal['records'], 'More records than sealed')
            if entry.get('kind') == 'schedule-gap':
                require(set(entry) == {'sequence', 'previousRecordSha256', 'kind', 'at', 'skippedTicks', 'nextMonotonic'}, 'Invalid gap fields')
                at = utc_ms(entry['at'])
                require(integer(entry.get('skippedTicks'), 1) and finite(entry.get('nextMonotonic'))
                        and (last_mono is None or entry['nextMonotonic'] > last_mono), 'Invalid scheduled gap')
                unsafe = unsafe or (last_wall is not None and at < last_wall)
                last_wall = at
                gaps += entry['skippedTicks']
                result = dict(event='schedule-gap', record=entry, clockUnsafe=unsafe)
            else:
                request_url(entry)
                required_fields = {'sequence','previousRecordSha256','kind','url','requestedAt','requestMonotonic',
                                   'transportComplete','status','headers','readComplete','receivedAt','receivedMonotonic',
                                   'bodyBytes','bodySha256','errorType','blob','blobSha256','blobBytes'}
                metadata_fields = {'jsonObject','fleetSchema','busCount','hasServerEta','forecastAt','servedAt','build'}
                require(required_fields <= set(entry) and set(entry) <= required_fields | metadata_fields, 'Unexpected/missing request fields')
                require(type(entry.get('readComplete')) is bool and type(entry.get('transportComplete')) is bool, 'Invalid transport flags')
                status, error = entry.get('status'), entry.get('errorType')
                require(status is None or type(status) is int and 100 <= status <= 599, 'Invalid HTTP status')
                require(error is None or isinstance(error, str) and bool(error), 'Invalid error type')
                require(entry['transportComplete'] == bool(status == 200 and entry['readComplete'] and not error), 'Inconsistent transport completeness')
                headers = entry.get('headers')
                require(isinstance(headers, dict) and set(headers) <= HEADERS
                        and all(v is None or isinstance(v, str) for v in headers.values()), 'Invalid captured headers')
                req, rec = entry.get('requestMonotonic'), entry.get('receivedMonotonic')
                require(finite(req) and finite(rec) and 0 <= req <= rec
                        and (last_mono is None or req >= last_mono), 'Noncausal/overlapping monotonic request clocks')
                request_at, receipt_at = utc_ms(entry.get('requestedAt')), utc_ms(entry.get('receivedAt'))
                unsafe = unsafe or receipt_at < request_at or last_wall is not None and request_at < last_wall
                last_mono, last_wall = rec, receipt_at
                relative = blob_path(entry)
                require(integer(entry.get('bodyBytes')) and entry['bodyBytes'] <= BODY_LIMIT
                        and integer(entry.get('blobBytes'), 1) and entry['blobBytes'] <= BODY_LIMIT + 65536
                        and isinstance(entry.get('blobSha256'), str) and HEX.fullmatch(entry['blobSha256']), 'Invalid body/blob metadata')
                fingerprint = (entry['bodyBytes'], entry['blobBytes'], entry['blobSha256'])
                require(relative not in blobs or blobs[relative] == fingerprint, 'Conflicting metadata for reused blob')
                if relative not in blobs:
                    referenced_bytes += entry['blobBytes']
                    blobs[relative] = fingerprint
                if relative in cache:
                    raw = cache[relative]
                    cache.move_to_end(relative)
                else:
                    compressed = bounded_bytes(regular(root, relative), BODY_LIMIT + 65536)
                    require(len(compressed) == entry['blobBytes'] and digest(compressed) == entry['blobSha256'], 'Compressed body hash/length mismatch')
                    try:
                        decoder = zlib.decompressobj(31)
                        raw = decoder.decompress(compressed, BODY_LIMIT + 1)
                    except zlib.error as exc:
                        raise IntegrityError('Invalid/truncated gzip') from exc
                    require(len(raw) <= BODY_LIMIT and decoder.eof and not decoder.unused_data and not decoder.unconsumed_tail,
                            'Incomplete/multiple-member/oversized gzip')
                    require(len(raw) == entry['bodyBytes'] and digest(raw) == entry['bodySha256'], 'Raw body hash/length mismatch')
                    if len(raw) <= 65536:
                        cache[relative] = raw
                        if len(cache) > 16:
                            cache.popitem(last=False)
                length = headers.get('Content-Length')
                if entry['readComplete'] and length is not None:
                    require(length.isdecimal() and int(length) == len(raw), 'Completed content-length mismatch')
                if error == 'BodyLimitExceeded':
                    require(len(raw) == BODY_LIMIT and not entry['readComplete'], 'Invalid body-limit prefix metadata')
                parsed, duplicates, ready, reason = decode_body(entry, raw)
                if entry['transportComplete']:
                    complete += 1
                else:
                    incomplete += 1
                result = dict(event='response', record=entry, rawBody=raw, body=parsed,
                              duplicateBodyKeys=duplicates, clockUnsafe=unsafe,
                              fleetUsable=ready and not unsafe,
                              unusableReason='clock_unsafe' if unsafe else reason,
                              receiptMs=receipt_at, requestMs=request_at,
                              requestDurationMs=(rec-req)*1000,
                              wallDurationMs=receipt_at-request_at)
            if count == mcount:
                manifest_at_count = dict(head=previous, complete=complete, incomplete=incomplete, gaps=gaps)
            yield result
    require(count == seal['records'] and previous == seal.get('lastRecordSha256'), 'Sealed record count/head mismatch')
    relationship = 'same-prefix' if mcount == count else 'behind-prefix' if mcount < count else 'ahead-of-prefix'
    unjournaled_gaps = None
    if manifest_at_count:
        m = manifest_at_count
        require(manifest.get('lastRecordSha256') == m['head'] and manifest.get('completeResponses') == m['complete']
                and manifest.get('incompleteResponses') == m['incomplete'], 'Manifest sequence/response counters disagree')
        require(integer(manifest.get('skippedTicks')) and manifest['skippedTicks'] >= m['gaps'], 'Manifest gap count disagrees')
        unjournaled_gaps = manifest['skippedTicks'] - m['gaps']
        require(not unjournaled_gaps or manifest.get('status') in ('stopped', 'failed'), 'Unexplained running-manifest gap count')
    if mcount == count:
        require(integer(manifest.get('storedDataBytes')) and manifest['storedDataBytes'] >= referenced_bytes + journal_bytes,
                'Manifest stored bytes below referenced bytes')
    yield dict(event='verification-complete', records=count, lastRecordSha256=previous,
               prefixSha256=expected_seal_sha256, journalSha256=journal_hash,
               manifestRelationship=relationship, completeResponses=complete, incompleteResponses=incomplete,
               skippedTicks=gaps, unjournaledManifestSkippedTicks=unjournaled_gaps,
               distinctBlobs=len(blobs), referencedStoredBytes=referenced_bytes+journal_bytes,
               clockUnsafe=unsafe, sourceStatus=manifest.get('status'),
               unpersistedResponse=manifest.get('unpersistedResponse'))


class Assets(HTMLParser):
    """Recorder-equivalent allowlist; neither follows links nor fetches assets."""
    def __init__(self):
        super().__init__()
        self.urls = []

    def handle_starttag(self, tag, attributes):
        attributes = dict(attributes)
        path = attributes.get('src') if tag == 'script' else (
            attributes.get('href') if tag == 'link' and attributes.get('rel') == 'modulepreload' else None)
        if not path:
            return
        url = urllib.parse.urljoin(BASE+'/', path)
        split = urllib.parse.urlsplit(url)
        if (split.scheme, split.netloc) == ('https', 'yale-shuttle.fly.dev') and not split.fragment \
                and split.path.startswith('/assets/') and split.path.endswith('.js') and url not in self.urls:
            self.urls.append(url)


def resource_name(record):
    if record['kind'] == 'html':
        return 'index.html'
    split = urllib.parse.urlsplit(record['url'])
    return split.path.lstrip('/') + ('?' + split.query if split.query else '')


class ReleaseEvidence:
    """Causal observations and explicitly unproven continuity candidates."""
    def __init__(self, proofs):
        self.proofs = []
        for proof in proofs:
            require(isinstance(proof.get('source'), str) and isinstance(proof.get('webTree'), str)
                    and isinstance(proof.get('files'), dict) and 'index.html' in proof['files'], 'Invalid source proof')
            require(all(isinstance(k, str) and isinstance(v, dict) and isinstance(v.get('sha256'), str)
                        and HEX.fullmatch(v['sha256']) and integer(v.get('bytes')) for k, v in proof['files'].items()), 'Invalid proof files')
            self.proofs.append({**proof, 'proofKnownAtMs': utc_ms(proof.get('proofKnownAt'))})
        self.health = None
        self.pending = None
        self.bundle = None
        self.fleet_range = None
        self.health_failures = 0
        self.last_at = None

    def candidate(self, receipt_ms, unsafe):
        base = dict(strictIdentityKnown=False, assumptionRequired=True, acceptedRelease=False,
                    assumption='No unobserved intermediate frontend change since the recorded bundle; health endpoints cannot prove this.',
                    previousHealth=self.health, lastCompleteBundle=self.bundle,
                    healthFailuresSinceBundle=self.health_failures)
        if unsafe:
            return {**base, 'status':'clock_unsafe', 'source':None}
        if not self.bundle:
            return {**base, 'status':'no_complete_bundle', 'source':None}
        eligible = [p for p in self.proofs if p['files'] == self.bundle['files'] and p['proofKnownAtMs'] <= receipt_ms]
        identities = {(p['source'], p['webTree']) for p in eligible}
        if not identities:
            return {**base, 'status':'unknown_or_not_yet_known_bundle_proof', 'source':None}
        if len(identities) != 1:
            return {**base, 'status':'ambiguous_source_proofs', 'source':None}
        proof = min(eligible, key=lambda p:p['proofKnownAtMs'])
        # A later health recovery is new knowledge; it cannot restore the failed
        # interval using the old bundle/proof's earlier timestamp.
        known = max(proof['proofKnownAtMs'], self.bundle['completedAtMs'],
                    self.health['receivedAtMs'] if self.health else -math.inf)
        if known > receipt_ms:
            return {**base, 'status':'future_bundle_knowledge', 'source':None}
        healthy = self.health and self.health['valid'] and self.health['build'] == self.bundle['precedingHealthBuild']
        return {**base, 'status':'candidate_under_continuity_assumption' if healthy else 'bundle_observed_health_unknown',
                'source':proof['source'], 'webTree':proof['webTree'], 'files':proof['files'],
                'knownAt':known, 'proofKnownAt':proof['proofKnownAtMs'],
                'acceptedRelease':False}

    def state_event(self, sequence, kind, at, unsafe, evidence, body_hash=None):
        candidate = evidence['status'] == 'candidate_under_continuity_assumption'
        return dict(event='release-state', id=f"release:{sequence}:{body_hash or kind}",
                    sequence=sequence, trigger=kind, observedReceiptMs=at,
                    knownAt=None if unsafe else at, clockUnsafe=unsafe,
                    shadowsEarlierReleaseMappings=True, acceptedRelease=False,
                    strictIdentityKnown=False, assumptionRequired=True,
                    status=evidence['status'], source=evidence.get('source') if candidate else None,
                    webTree=evidence.get('webTree') if candidate else None,
                    files=evidence.get('files') if candidate else None,
                    releaseEvidence=evidence)

    def step(self, verified):
        if verified['event'] != 'response':
            return []
        r, body = verified['record'], verified['body']
        kind, at = r['kind'], verified['receiptMs']
        self.last_at = at
        success = r['transportComplete'] and not verified['clockUnsafe']
        events = []
        if kind == 'health':
            valid = bool(success and not verified['duplicateBodyKeys'] and isinstance(body, dict) and isinstance(body.get('build'), str))
            current = dict(sequence=r['sequence'], receivedAtMs=at, build=body.get('build') if valid else None, valid=valid)
            if self.health:
                verdict = ('equal_observed_ends' if self.health['valid'] and valid and self.health['build'] == current['build'] else
                           'changed_observed_ends' if self.health['valid'] and valid else 'failed_endpoint')
                events.append(dict(event='health-bracket-known', knownAt=at, left=self.health, right=current,
                                   verdict=verdict, fleetRange=self.fleet_range,
                                   unobservedIntermediateReleasePossible=True, retroactiveAttribution=False))
            if not valid:
                self.health_failures += 1
            elif self.bundle and current['build'] != self.bundle['precedingHealthBuild']:
                self.bundle = None
            self.health, self.pending, self.fleet_range = current, None, None
        elif kind == 'html':
            self.pending = None
            self.bundle = None
            parser = Assets()
            if success and r['headers'].get('Content-Encoding') in (None, '', 'identity'):
                parser.feed(verified['rawBody'].decode('utf-8', errors='replace'))
            if parser.urls and len(parser.urls) <= 32:
                self.pending = dict(htmlSequence=r['sequence'], urls=parser.urls, index=0, valid=True,
                                    files={'index.html':{'sha256':r['bodySha256'], 'bytes':r['bodyBytes']}},
                                    precedingHealthBuild=self.health['build'] if self.health and self.health['valid'] else None)
            else:
                events.append(dict(event='bundle-observation-incomplete', knownAt=at, htmlSequence=r['sequence'], reason='html_or_resource_set_unavailable'))
        elif kind == 'module':
            pending = self.pending
            if not pending or r['url'] != pending['urls'][pending['index']]:
                self.pending = None
                self.bundle = None
                events.append(dict(event='bundle-observation-incomplete', knownAt=at, reason='unpaired_or_out_of_order_module'))
            else:
                pending['valid'] = pending['valid'] and success and r['headers'].get('Content-Encoding') in (None, '', 'identity')
                pending['files'][resource_name(r)] = {'sha256':r['bodySha256'], 'bytes':r['bodyBytes']}
                pending['index'] += 1
                if pending['index'] == len(pending['urls']):
                    if pending['valid']:
                        self.bundle = dict(htmlSequence=pending['htmlSequence'], completedSequence=r['sequence'],
                                           completedAtMs=at, files=pending['files'], precedingHealthBuild=pending['precedingHealthBuild'])
                        self.health_failures = 0
                        events.append(dict(event='bundle-observation-complete', knownAt=at, bundle=self.bundle))
                    else:
                        events.append(dict(event='bundle-observation-incomplete', knownAt=at, htmlSequence=pending['htmlSequence'], reason='failed_resource'))
                    self.pending = None
        elif kind == 'fleet':
            if self.pending:
                events.append(dict(event='bundle-observation-incomplete', knownAt=at, reason='fleet_before_resource_completion'))
                self.pending = None
            if self.fleet_range is None:
                self.fleet_range = dict(first=r['sequence'], last=r['sequence'], count=1)
            else:
                self.fleet_range = {**self.fleet_range, 'last':r['sequence'], 'count':self.fleet_range['count']+1}
            admissible = not verified['clockUnsafe'] and not verified['duplicateBodyKeys']
            events.append(dict(event='fleet-receipt', id=f"{r['sequence']}:{r['bodySha256']}", sequence=r['sequence'],
                               receivedAt=at, requestStartedAt=verified['requestMs'], requestDurationMs=verified['requestDurationMs'],
                               bodySha256=r['bodySha256'], status=('ok' if verified['fleetUsable'] else 'failure') if admissible else 'unknown',
                               complete=verified['fleetUsable'], transportComplete=r['transportComplete'],
                               replayAdmissible=admissible,
                               body=body if verified['fleetUsable'] else None, reason=verified['unusableReason'],
                               releaseEvidence=self.candidate(at, verified['clockUnsafe'])))
        evidence = self.candidate(at, verified['clockUnsafe'])
        state = self.state_event(r['sequence'], kind, at, verified['clockUnsafe'], evidence, r['bodySha256'])
        # Every observation has an explicit state, even unsupported/unknown ones.
        # Consumers must not filter unknown states and reuse an older candidate.
        for event in events:
            if event['event'] == 'fleet-receipt':
                event.update(releaseStateId=state['id'], releaseStateSequence=state['sequence'])
            else:
                event.update(knownAt=None if verified['clockUnsafe'] else at,
                             observedReceiptMs=at, clockUnsafe=verified['clockUnsafe'])
        fleet = [event for event in events if event['event'] == 'fleet-receipt']
        events = [event for event in events if event['event'] != 'fleet-receipt']
        events.append(state)
        events.extend(fleet)
        return events

    def interrupt(self, record):
        gap = record['event'] == 'schedule-gap'
        at = utc_ms(record['record']['at']) if gap else self.last_at
        unsafe = record['clockUnsafe']
        self.last_at = at
        events = []
        if self.pending:
            pending = self.pending
            self.pending = None
            events.append(dict(event='bundle-observation-incomplete', knownAt=None if unsafe else at,
                               observedReceiptMs=at, clockUnsafe=unsafe,
                               htmlSequence=pending['htmlSequence'], reason='gap_before_resource_completion'
                               if gap else 'prefix_ended_before_resource_completion'))
        if gap:
            events.append(self.state_event(record['record']['sequence'], 'schedule-gap', at, unsafe,
                                           self.candidate(at, unsafe)))
        return events


def iter_capture(prefix, expected_seal_sha256, proofs=()):
    """Reusable ordered event iterator; release candidates are never approvals."""
    release = ReleaseEvidence(proofs)
    for record in iter_verified(prefix, expected_seal_sha256):
        if record['event'] == 'response':
            yield from release.step(record)
        else:
            yield from release.interrupt(record)
            yield record
