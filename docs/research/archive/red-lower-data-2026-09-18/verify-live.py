import datetime
import json
import math
import pathlib
import sys
import urllib.request

root = pathlib.Path(__file__).resolve().parent
expected = sys.argv[1]
def get(path):
    with urllib.request.urlopen('https://yale-shuttle.fly.dev' + path, timeout=25) as response:
        return json.load(response)

health = get('/healthz')
payload = get('/api/buses')
wire = payload['server_eta']
assert health['ok'] is True
assert health['build'] == expected[:12], health['build']
assert health['pollStalenessMs'] < 30_000, health
assert health['serverEta']['failures'] == 0, health
assert wire['servedAt'] - wire['at'] < 30_000
assert len(wire['rows']) == len(wire['distributions'])
for row, distribution in zip(wire['rows'], wire['distributions']):
    assert 0 <= row[0] < len(wire['buses']), row
    assert all(math.isfinite(v) for v in row), row
    assert row[3] <= row[2] <= row[4], row
    assert len(distribution) in (0, 50), len(distribution)
    assert all(math.isfinite(v) and v >= 0 for v in distribution)
    assert distribution == sorted(distribution)

red = []
for index, bus in enumerate(wire['buses']):
    if bus[1] != 'Red':
        continue
    red.append({'bus': bus, 'targets': [r[1:7] for r in wire['rows']
        if r[0] == index and r[1] in (48, 4)]})
result = {
    'checkedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'expectedCommit': expected,
    'health': health,
    'forecastRows': len(wire['rows']),
    'red': red,
    'passed': True,
}
(root / 'live-postdeploy.json').write_text(json.dumps(payload))
(root / 'deployment-verification.json').write_text(json.dumps(result, indent=2))
print(json.dumps(result, indent=2))
