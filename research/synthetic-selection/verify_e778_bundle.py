"""Hosted, bounded public build proof. No fleet, geocoder or private requests."""
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import subprocess
import urllib.request

SOURCE = 'e7784c03b8c739eaa603fb231fe5ce80d2d71e82'
TREE = 'c86bcf558a276752ed35b1145bd7c7fc33f7d4cf'
BASE = 'https://yale-shuttle.fly.dev'
PATHS = {'index.html': '/', 'assets/rider-CiwwGOPJ.js': '/assets/rider-CiwwGOPJ.js',
         'assets/geo-BjWFh9tz.js': '/assets/geo-BjWFh9tz.js'}
ROOT = Path(__file__).resolve().parent
OUT = ROOT / 'results'

def now():
    return dt.datetime.now(dt.timezone.utc).isoformat()

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise RuntimeError('Unexpected redirect')

def read(path):
    assert path in {'/healthz', *PATHS.values()}
    started = now()
    request = urllib.request.Request(BASE + path, headers={'Accept-Encoding': 'identity', 'User-Agent': 'shuttle-research-source-proof/1'})
    with urllib.request.build_opener(NoRedirect()).open(request, timeout=15) as response:
        if response.status != 200 or response.headers.get('Content-Encoding', 'identity') != 'identity':
            raise RuntimeError('Unexpected response')
        body = response.read(8 * 1024 * 1024 + 1)
        if len(body) > 8 * 1024 * 1024:
            raise RuntimeError('Response too large')
        length = response.headers.get('Content-Length')
        if length is not None and int(length) != len(body):
            raise RuntimeError('Incomplete response')
    return body, {'path': path, 'requestedAt': started, 'receivedAt': now(), 'bytes': len(body), 'sha256': hashlib.sha256(body).hexdigest()}

def main():
    assert os.environ.get('GITHUB_ACTIONS') == 'true', 'Hosted only'
    tree = subprocess.check_output(['git', 'rev-parse', f'{SOURCE}:services/shuttle-v2/web'], text=True).strip()
    assert tree == TREE
    subprocess.run(['git', 'diff', '--exit-code', SOURCE, '--', 'services/shuttle-v2'], check=True)
    OUT.mkdir(exist_ok=True)
    health, before = read('/healthz')
    assert json.loads(health)['build'] == SOURCE[:12]
    receipts, files = [before], {}
    for path, endpoint in PATHS.items():
        raw, receipt = read(endpoint)
        built = (OUT / 'rebuilt' / path).read_bytes()
        if raw != built:
            raise RuntimeError(f'Served/build mismatch: {path}')
        (OUT / ('served-' + Path(path).name)).write_bytes(raw)
        receipts.append(receipt)
        files[path] = {'bytes': len(raw), 'sha256': receipt['sha256']}
    health, after = read('/healthz')
    assert json.loads(health)['build'] == SOURCE[:12]
    receipts.append(after)
    proof = {'source': SOURCE, 'webTree': TREE, 'proofKnownAt': now(),
             'proofRun': f"https://github.com/{os.environ['GITHUB_REPOSITORY']}/actions/runs/{os.environ['GITHUB_RUN_ID']}",
             'files': files, 'receipts': receipts,
             'scope': 'Fresh served public HTML/JS equal exact-source hosted Docker build; equal health brackets do not prove every intervening release.'}
    (OUT / 'E778-SOURCE-PROOF.json').write_text(json.dumps(proof, indent=2) + '\n')
    print(json.dumps(proof))

if __name__ == '__main__':
    main()
