"""Validate the raw-only Sep21 capture and append it to frozen raw history."""
import gzip
import hashlib
import json
import math
import os
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
DAY_START, CUTOFF = 1789963200000, 1790049600000
RAW_SHA = '3990d06ebdab596cfebdd7f03c528f7efcbb46fd3f6af68a9d64ede648e220b9'
EXPORT_SHA = '250494e8bbc09794da6df73b772ba1f78addf83c4511e186e34ffee1c4c05381'
COLS = ['id','bus_id','bus_name','route_id','lat','lon','heading','last_stop_id','collected_at']


def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as f:
        for chunk in iter(lambda: f.read(1048576), b''):
            h.update(chunk)
    return h.hexdigest()


def decode_capture(path, meta):
    assert digest(path) == meta['sha256']
    rows, seen, raw_hash, raw_bytes = [], set(), hashlib.sha256(), 0
    with gzip.open(path, 'rb') as stream:
        def next_row():
            nonlocal raw_bytes
            line = stream.readline()
            assert line.endswith(b'\n'), 'Truncated or missing transport line'
            raw_hash.update(line)
            raw_bytes += len(line)
            return json.loads(line)
        header = next_row()
        assert header == meta['header'] and header['columns'] == COLS
        assert header['table'] == 'raw_positions' and header['day'] == '2026-09-21'
        assert header['from'] == DAY_START and header['to'] == CUTOFF
        while True:
            row = next_row()
            if row.get('end') is True:
                assert row == meta['trailer'] and row['rows'] == len(rows)
                assert stream.read() == b'', 'Data after trailer'
                break
            assert set(row) == set(COLS)
            assert isinstance(row['id'], int) and not isinstance(row['id'], bool) and row['id'] not in seen
            seen.add(row['id'])
            for field in ('bus_id', 'route_id', 'lat', 'lon', 'collected_at'):
                assert isinstance(row[field], (int, float)) and not isinstance(row[field], bool) and math.isfinite(row[field])
            assert isinstance(row['bus_id'], int) and isinstance(row['route_id'], int)
            assert isinstance(row['bus_name'], str) and row['bus_name']
            assert -90 <= row['lat'] <= 90 and -180 <= row['lon'] <= 180
            assert DAY_START <= row['collected_at'] < CUTOFF
            for field in ('heading', 'last_stop_id'):
                assert row[field] is None or (isinstance(row[field], (int, float)) and not isinstance(row[field], bool) and math.isfinite(row[field]))
            rows.append(row)
    assert raw_hash.hexdigest() == meta['rawSha256'] and raw_bytes == meta['rawBytes']
    assert len(rows) == meta['observedRows'] and meta['transportComplete'] is True
    return rows


def main():
    assert os.environ.get('GITHUB_ACTIONS') == 'true', 'Hosted only'
    old = ROOT / 'research/k-sweep/results/raw_positions.jsonl.gz'
    export = HERE / 'data/raw_positions.original.jsonl.gz'
    provenance = json.loads((HERE / 'data/raw-provenance.json').read_text())
    assert digest(old) == RAW_SHA and digest(export) == EXPORT_SHA
    rows = decode_capture(export, provenance['table'])
    assert len(rows) == 179751
    out = HERE / 'input/merged-raw.jsonl.gz'
    assert not out.exists()
    count, last = 0, 0
    with out.open('wb') as target:
        with gzip.GzipFile(filename='', mode='wb', fileobj=target, mtime=0) as dest:
            with gzip.open(old, 'rb') as previous:
                for line in previous:
                    row = json.loads(line)
                    assert row['collected_at'] < DAY_START
                    last = max(last, row['collected_at'])
                    count += 1
                    dest.write(line if line.endswith(b'\n') else line+b'\n')
            for row in rows:
                dest.write(json.dumps(row, separators=(',', ':'), allow_nan=False).encode()+b'\n')
    assert count == 1487970
    audit = dict(rawOldRows=count, rawAppendedRows=len(rows), oldLastObservedAt=last,
                 appendedFirstObservedAt=min(r['collected_at'] for r in rows),
                 appendedLastObservedAt=max(r['collected_at'] for r in rows),
                 inputHashes=dict(original=RAW_SHA, sep21=EXPORT_SHA),
                 mergedSha256=digest(out), transportValidated=True,
                 serviceCoverage='not inferred from complete export',
                 performanceLabelsRead=0, prospectiveObservationsRead=0)
    (HERE / 'input/raw-audit.json').write_text(json.dumps(audit, indent=2)+'\n')
    print(json.dumps(audit))


if __name__ == '__main__':
    main()
