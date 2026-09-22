"""Shared daily synthetic input preparation and verification; never real capture IO."""
import gzip
import json
import os
from pathlib import Path
import shutil
import sqlite3
import sys

from benchmark import DATES, ROUTES, HERE, ROOT, expected, reconcile
from capture_input import file_hash
from resource_guard import run, SECONDS_LIMIT


def write_json(path, value):
    path.write_text(json.dumps(value,indent=2)+'\n')


def describe_spool(spool, metadata, date):
    ready = json.loads((spool/'ready.json').read_text())
    sha = file_hash(spool/'ready.json')[0]
    if (spool/'ready.sha256').read_text().strip() != sha:
        raise ValueError('Shared readiness hash mismatch')
    index = metadata/'fleet-index.jsonl'
    count = 0
    with sqlite3.connect(f'file:{spool}/events.sqlite?mode=ro',uri=True) as database, index.open('x') as handle:
        for at, raw in database.execute("SELECT at_us,event_json FROM events WHERE kind='fleet-receipt' ORDER BY ordinal"):
            event = json.loads(raw)
            handle.write(json.dumps(dict(atUs=at,receivedAtUtc=event['receivedAtUtc'],bodySha256=event['bodySha256']),separators=(',',':'))+'\n')
            count += 1
    result = dict(schema=1,date=date,syntheticOnly=True,outcomes=False,readySha256=sha,
                  captureId=ready['captureId'],prefixSha256=ready['prefixSha256'],
                  databaseSha256=ready['databaseSha256'],databaseBytes=ready['databaseBytes'],
                  generator=ready['syntheticGenerator'],fleetIndexSha256=file_hash(index)[0],fleetReceipts=count)
    write_json(metadata/'shared.json',result)
    shutil.copyfile(spool/'ready.json',metadata/'spool-ready.json')
    return result


def validate_shared(directory, date):
    directory=Path(directory); metadata=directory/'metadata'; spool=directory/'spool'
    shared=json.loads((metadata/'shared.json').read_text())
    ready=json.loads((spool/'ready.json').read_text())
    epoch=date+'T04:00:00+00:00'
    if not (shared['date']==date and date in DATES and shared['syntheticOnly'] is True and shared['outcomes'] is False):
        raise ValueError('Wrong shared input assignment')
    if file_hash(spool/'ready.json')[0] != shared['readySha256'] or (spool/'ready.sha256').read_text().strip()!=shared['readySha256']:
        raise ValueError('Shared input readiness changed')
    if ready != json.loads((metadata/'spool-ready.json').read_text()) or shared['generator']!=ready['syntheticGenerator']:
        raise ValueError('Shared metadata differs from sealed input')
    if any(shared[key]!=ready[key] for key in ('captureId','prefixSha256','databaseSha256','databaseBytes')):
        raise ValueError('Shared identity differs from sealed input')
    generator=shared['generator']
    if generator['start'] != epoch or generator['seconds']!=87300 or generator['generatorSha256']!=file_hash(HERE/'make_synthetic_capture.py')[0]:
        raise ValueError('Changed fixed synthetic workload')
    if file_hash(spool/'events.sqlite') != (shared['databaseSha256'],shared['databaseBytes']):
        raise ValueError('Shared database changed')
    if file_hash(metadata/'fleet-index.jsonl')[0]!=shared['fleetIndexSha256']:
        raise ValueError('Shared fleet index changed')
    return shared


def generate(date, output):
    # Invoked only inside the process-tree watchdog. This function imports the
    # pinned recorder and processes only its just-created synthetic output.
    from make_synthetic_capture import make
    output=Path(output); metadata=output/'metadata'; metadata.mkdir(parents=True)
    scratch=output/'producer'
    make(scratch,HERE/'results'/'baseline-assets',date+'T04:00:00+00:00',87300)
    shutil.copyfile(scratch/'generation.json',metadata/'generation.json')
    shutil.copyfile(scratch/'prefix'/'prefix.json',metadata/'prefix.json')
    shutil.copyfile(scratch/'prefix'/'manifest.json',metadata/'capture-manifest.json')
    with (scratch/'prefix'/'records.jsonl').open('rb') as source, (metadata/'journal.jsonl.gz').open('wb') as target:
        with gzip.GzipFile(fileobj=target,mode='wb',mtime=0) as compressed:
            shutil.copyfileobj(source,compressed)
    (scratch/'spool').rename(output/'spool')
    shutil.rmtree(scratch)
    describe_spool(output/'spool',metadata,date)
    validate_shared(output,date)


def prepare(date):
    if date not in DATES: raise ValueError('Date outside schedule')
    output=HERE/'results'/('shared-'+date)
    output.mkdir(parents=True,exist_ok=False)
    try:
        run([sys.executable,str(Path(__file__)),'generate',date,str(output)],ROOT,ROOT,
            output/'generation-resources.json',seconds=SECONDS_LIMIT-300)
    finally:
        (output/'metadata').mkdir(exist_ok=True)
        if (output/'generation-resources.json').exists():
            shutil.copyfile(output/'generation-resources.json',output/'metadata'/'generation-resources.json')


def shard_output(route,date):
    if route not in ROUTES or date not in DATES:raise ValueError('Unknown fixed shard')
    return HERE/'results'/f'benchmark-full-{route}-{date}'


def declare(route,date):
    output=shard_output(route,date);output.mkdir(parents=True,exist_ok=False)
    assigned=expected('full',route,date)
    if len(assigned)!=288:raise ValueError('Changed daily denominator')
    write_json(output/'expected.json',assigned)


def worker(route,date,shared_directory):
    output=shard_output(route,date);assigned=expected('full',route,date)
    if set(p.name for p in output.iterdir()) != {'expected.json'} or json.loads((output/'expected.json').read_text())!=assigned:
        raise ValueError('Missing clean predeclared shard')
    error=None;day=output/('day-'+date);day.mkdir()
    try:
        shared=validate_shared(shared_directory,date)
        write_json(day/'shared-input.json',shared)
        env={**os.environ,'BENCH_STAGE':'full','BENCH_ROUTE':str(route),'BENCH_DATE':date,
             'BENCH_OUTPUT':str(day),'BENCH_SPOOL':str(Path(shared_directory).resolve()/'spool'),
             'BENCH_READY_SHA':shared['readySha256'],'TZ':'America/New_York'}
        run(['npx','vitest','run','--config','../../research/synthetic-selection/benchmark.config.ts'],
            ROOT/'services'/'shuttle-v2',ROOT,day/'worker-resources.json',env=env,seconds=SECONDS_LIMIT-300)
    except BaseException as failure:
        error=f'{type(failure).__name__}: {failure}'
    result=reconcile(output,assigned,error);print(json.dumps(result))
    if not result['success']:raise SystemExit(1)


if __name__=='__main__':
    action=sys.argv[1]
    if action=='generate':generate(sys.argv[2],sys.argv[3])
    elif action=='prepare':prepare(sys.argv[2])
    elif action=='declare':declare(int(sys.argv[2]),sys.argv[3])
    elif action=='worker':worker(int(sys.argv[2]),sys.argv[3],sys.argv[4])
    elif action=='reconcile':
        route,date=int(sys.argv[2]),sys.argv[3];output=shard_output(route,date)
        if not (output/'summary.json').exists():
            output.mkdir(parents=True,exist_ok=True)
            reconcile(output,expected('full',route,date),'hosted shard did not finish; setup/input/execution may have failed')
    else:raise ValueError('Unknown action')
