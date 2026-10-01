from pathlib import Path
import collections, hashlib, json, subprocess

O = Path(__file__).resolve().parent
A = O.parent
repo = Path('/home/gwarren/projects/yale-shuttle-watcher/overnight-eta-2026-09-17')
sha = 'd5a392f533e8684320259ff0d323a3b0da75cc50'
def git(*args):
    return subprocess.check_output(['git', *args], cwd=repo, text=True)
assert git('rev-parse', 'HEAD').strip() == sha
assert git('rev-parse', sha).strip() == sha
assert git('diff', sha, 'HEAD') == ''
assert git('diff', sha) == ''
assert git('diff', '--cached', sha) == ''
assert git('status', '--porcelain') == ''
subprocess.run(['git', 'diff', '--check'], cwd=repo, check=True)
entry = json.loads((O/'builder-entry-hashes.json').read_text())
for name, wanted in entry.items():
    assert hashlib.sha256(Path(name).read_bytes()).hexdigest() == wanted, name
identical = ['shell-current.generated.mts', 'pickup-census.jsonl', 'summary.json', 'boundaries.json', 'built-source-provenance.json']
for name in identical:
    assert (O/name).read_bytes() == (A/'cycle-10'/name).read_bytes(), name

records = [json.loads(x) for x in (O/'pickup-census.jsonl').read_text().splitlines()]
historical = {(r['session'], r['at']): r for r in records if r['arm'] == 'historical'}
assert len(records) == 9376 and len(historical) == 4688
counts = collections.Counter(r['contract']['relation'] for r in historical.values())
assert counts == {'same-visit': 2490, 'different-bus': 742, 'raw-current': 1456}
distinct = [r for r in historical.values() if r['contract']['relation'] == 'different-bus']
assert len({r['sourceId'] for r in distinct}) == 9
assert len({r['session'] for r in distinct}) == 18
assert len({r['sourceId'] for r in historical.values()}) == 10
assert len({r['session'] for r in historical.values()}) == 40
outcomes = json.loads((A/'cycle-6/paired-outcomes.json').read_text())
assert len(outcomes) == 1400
for r in outcomes:
    current = historical[r['session'], r['at']]
    assert current['totalSec'] == r['ordered']['totalSec']
    assert current['contract']['destinationAvailable'] == r['ordered']['journeyAvailable']
worst = max((r for r in outcomes if r['changed']), key=lambda r: r['absErrorIncreaseSec'])
assert worst['sourceId'] == 63523
assert worst['absErrorIncreaseSec'] == 442.82701916224846

browser = []
for name in ['browser-contract', 'browser-extra-mobile', 'browser-extra-desktop']:
    r = json.loads((O/(name+'.json')).read_text())
    assert r['completed'] and r['resourcesClosed'] and not r['errors']
    assert len(r['states']) == 8
    if name != 'browser-contract':
        assert r['manualFocusReturned'] and r['renderedWaitAssertions'] == 7
    browser.append({'name': name, 'states': 8, 'resourcesClosed': True})
build = json.loads((O/'built-source-provenance.json').read_text())
for name, wanted in build['assets'].items():
    assert hashlib.sha256((repo/'services/shuttle-v2/web/dist'/name).read_bytes()).hexdigest() == wanted
for name, wanted in build['sources'].items():
    assert hashlib.sha256((repo/'services/shuttle-v2/web'/name).read_bytes()).hexdigest() == wanted
images = [p for team in ['eta', 'ux'] for p in (A.parent/team).rglob('*') if p.is_file() and p.suffix.lower() in {'.png', '.jpg', '.jpeg', '.webp'}]
image_bytes = sum(p.stat().st_size for p in images)
assert image_bytes < 100*1024*1024
report = {'head': sha, 'base': sha, 'candidateDiff': False, 'cleanWorktreeAndIndex': True,
          'builderFilesUnchanged': len(entry), 'byteIdenticalReproductions': identical,
          'historicalDecisions': len(historical), 'relationCounts': dict(counts),
          'connectedOutcomesRetained': 1400, 'worstOldRegressionRetainedSec': worst['absErrorIncreaseSec'],
          'sourceModules': len(build['sources']), 'assetHashes': len(build['assets']),
          'browserRuns': browser, 'reviewScreenshotsAdded': 0,
          'combinedScreenshots': {'count': len(images), 'bytes': image_bytes}}
(O/'final-integrity.json').write_text(json.dumps(report, indent=2)+'\n')
print(json.dumps(report, indent=2))
