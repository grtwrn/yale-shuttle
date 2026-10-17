#!/usr/bin/env python3
"""Daily frozen Red component diagnostics. Never publish or score legacy riders.
Keep two complete successful snapshots. Retain report/promotion evidence separately.
"""
import datetime, fcntl, hashlib, importlib.util, json, os, pathlib, shutil, subprocess, sys, tempfile
os.umask(0o077)
sys.dont_write_bytecode = True
REPO = pathlib.Path(__file__).resolve().parents[3]
DEFAULT_RESEARCH = pathlib.Path.home() / '.openclaw/yale-shuttle-team/red-experiments'
SOURCE = pathlib.Path(os.environ.get('RED_RESEARCH_SOURCE', REPO / 'docs/research/archive/red-winchester-covariates-2026-10-01'))
ROOT = pathlib.Path(os.environ.get('RED_RESEARCH_DIR', DEFAULT_RESEARCH / 'component-watch'))
PYTHON = os.environ.get('RED_EXP_PY', sys.executable)
WEATHER = pathlib.Path(os.environ.get('RED_EXP_WEATHER', ROOT / 'weather'))
LIMIT = 256 * 1024 * 1024  # per complete snapshot, at most current + previous

def now(): return datetime.datetime.now(datetime.timezone.utc).isoformat()
def read(p): return json.loads(pathlib.Path(p).read_text())
def sha(p): return hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest()
def atomic(p, value):
    p = pathlib.Path(p); tmp = p.with_name(p.name + '.partial')
    tmp.write_text(json.dumps(value, indent=2) + '\n'); os.replace(tmp, p)
def size(p): return sum(f.stat().st_size for f in p.rglob('*') if f.is_file())

def main():
    ROOT.mkdir(parents=True, exist_ok=True)
    for name in ['launchd.log', 'launchd.err.log']:
        log = ROOT / name
        if log.is_file() and not log.is_symlink() and log.stat().st_size > 1024 * 1024:
            os.replace(log, ROOT / (name + '.1'))
    with (ROOT / 'watch.lock').open('a+') as lock:
        try: fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print(json.dumps({'skipped': 'A research check already owns the lock'})); return 0
        started = now()
        scope = 'Offline frozen component diagnostics; not the current full estimator or a model-promotion decision.'
        temporary = None
        try:
            # Refuse drift before importing any frozen analysis module.
            recorded = read(SOURCE / 'FREEZE.json')
            freeze_sha, runner_sha = sha(SOURCE / 'FREEZE.json'), sha(SOURCE / 'runner.py')
            drift = [name for name in ['PLAN.json', 'lib.py', 'model.py', 'screen.py']
                     if sha(SOURCE / name) != recorded['code_sha256'].get(name)]
            if drift: raise RuntimeError('Frozen research source drift: ' + ', '.join(drift))
            os.environ['RED_EXP_WEATHER'] = str(WEATHER)
            os.environ['PYTHONDONTWRITEBYTECODE'] = '1'
            os.environ['OPENBLAS_NUM_THREADS'] = '1'
            sys.path.insert(0, str(SOURCE))
            spec = importlib.util.spec_from_file_location('red_component_runner', SOURCE / 'runner.py')
            runner = importlib.util.module_from_spec(spec); spec.loader.exec_module(runner)
            freeze = runner.freeze_check()
            if freeze['drift']: raise RuntimeError('Frozen research source drift: ' + ', '.join(freeze['drift']))
            # Validate frozen weather before adding today's completed past hours.
            weather, drift, gaps = runner.weather_check()
            if drift: raise RuntimeError('Frozen weather drift: ' + ', '.join(drift))
            fetch_error = runner.weather_fetch(datetime.datetime.now(runner.lib.ET))
            weather, drift, gaps = runner.weather_check()
            if drift or gaps: raise RuntimeError('Weather inputs incomplete: ' + json.dumps({'drift': drift, 'gaps': gaps, 'fetch_error': fetch_error}))
            temporary = pathlib.Path(tempfile.mkdtemp(prefix='staging-', dir=ROOT))
            with (temporary / 'screen.log').open('w') as log:
                completed = subprocess.run([PYTHON, str(SOURCE / 'screen.py'), '--out', str(temporary)], cwd=SOURCE, stdout=log, stderr=subprocess.STDOUT, timeout=600)
            if completed.returncode: raise RuntimeError('Frozen component screen failed: exit ' + str(completed.returncode))
            summary = read(temporary / 'screen-summary.json')
            if summary['headline'] != read(SOURCE / 'screen-summary.json')['headline']:
                raise RuntimeError('Original frozen-test headline changed; retain output for review')
            if summary['plan_sha256'] != freeze['plan_sha256']:
                raise RuntimeError('Scored plan differs from the frozen plan')
            if sha(SOURCE / 'FREEZE.json') != freeze_sha or sha(SOURCE / 'runner.py') != runner_sha or runner.freeze_check() != freeze:
                raise RuntimeError('Research source changed during the check')
            # Preserve the exact code and selected manifests alongside each complete result.
            saved = temporary / 'source'; saved.mkdir()
            for name in ['PLAN.json', 'FREEZE.json', 'WEATHER-INPUTS.json', 'lib.py', 'model.py', 'screen.py', 'runner.py', 'screen-summary.json']:
                shutil.copy2(SOURCE / name, saved / name)
            saved_weather = temporary / 'weather'; saved_weather.mkdir()
            for name, expected in weather['sha256'].items():
                shutil.copy2(WEATHER / name, saved_weather / name)
                if sha(saved_weather / name) != expected:
                    raise RuntimeError('Weather input changed during the check: ' + name)
            manifests = temporary / 'manifests'; manifests.mkdir()
            for day in summary['data']['service_days']:
                shutil.copy2(pathlib.Path(runner.lib.ARCHIVE) / day / 'manifest.json', manifests / (day + '.json'))
            receipt = {'startedAt': started, 'completedAt': now(), 'scope': scope, 'freeze': freeze,
                       'weather': weather, 'weatherFetchError': fetch_error, 'weatherGaps': {},
                       'frozenTestHeadlineUnchanged': True, 'serviceDays': summary['data']['service_days'],
                       'extension': runner.compact(summary), 'legacyRiderAccuracyExcluded': True,
                       'fullResultSha256': sha(temporary / 'screen-full.json'),
                       'summarySha256': sha(temporary / 'screen-summary.json')}
            atomic(temporary / 'receipt.json', receipt)
            if size(temporary) > LIMIT: raise RuntimeError('Component snapshot exceeds the 256 MiB per-slot limit')
            current, previous = ROOT / 'current', ROOT / 'previous'
            # Only rotate directories this wrapper created and whose receipt exists.
            for slot in [current, previous]:
                if slot.exists() and (slot.is_symlink() or not (slot / 'receipt.json').is_file()):
                    raise RuntimeError('Refusing to rotate an unrecognized snapshot: ' + slot.name)
            if previous.exists(): shutil.rmtree(previous)
            if current.exists(): os.replace(current, previous)
            os.replace(temporary, current); temporary = None
            status = {'checkedAt': now(), 'ok': True, 'scope': scope, 'source': str(SOURCE),
                      'frozenPlanSha256': freeze['plan_sha256'], 'legacyRiderAccuracyExcluded': True,
                      'extensionDays': receipt['extension']['days'], 'retainedBytes': size(current) + (size(previous) if previous.exists() else 0),
                      'retention': {'successfulSnapshots': 2, 'bytesPerSnapshotLimit': LIMIT},
                      'currentReceipt': str(current / 'receipt.json')}
            atomic(ROOT / 'status.json', status)
            # A successful run clears a prior bounded failure snapshot.
            if (ROOT / 'failed').exists(): shutil.rmtree(ROOT / 'failed')
            print(json.dumps(status)); return 0
        except Exception as error:
            # Keep one failed attempt, never replace the last good result on failure.
            if temporary and temporary.exists():
                failure = ROOT / 'failed'
                if failure.exists(): shutil.rmtree(failure)
                os.replace(temporary, failure)
            status = {'checkedAt': now(), 'ok': False, 'scope': scope, 'startedAt': started,
                      'error': str(error), 'lastGoodReceipt': str(ROOT / 'current' / 'receipt.json') if (ROOT / 'current' / 'receipt.json').exists() else None}
            atomic(ROOT / 'status.json', status); print(json.dumps(status)); return 1

if __name__ == '__main__': sys.exit(main())
