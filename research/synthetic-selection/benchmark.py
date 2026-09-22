"""Bounded synthetic benchmark coordinator. Daily Node workers are sequential."""
import datetime as dt
import gzip
import hashlib
import json
import os
from pathlib import Path
import shutil
import sys
import time

from resource_guard import run, SECONDS_LIMIT

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent


ROUTES = [1,2,3,4,8,9,10,13,14,15,16,17,18,19]
DATES = [f'2026-09-{day}' for day in range(23,30)]


def expected(stage, route, date=None):
    scenarios = json.loads((HERE/'PROSPECTIVE-SCENARIOS.json').read_text())['scenarios']
    rows = []
    for day in range(23,30) if stage == 'full' else [23]:
        for slot in range(48) if stage == 'full' else [24]:
            for scenario in scenarios:
                if stage == 'full' and scenario['generatingRouteId'] != route:
                    continue
                for profile in ('A','B'):
                    rows.append(dict(id=f"{scenario['id']}:2026-09-{day}:{slot:02}:{profile}",
                                     date=f'2026-09-{day}',slot=slot,scenarioId=scenario['id'],
                                     profile=profile,generatingRouteId=scenario['generatingRouteId']))
    if date is not None:
        if date not in DATES:
            raise ValueError('Date outside fixed schedule')
        rows = [row for row in rows if row['date'] == date]
    return rows[:2] if stage == 'integration' else rows


def reconcile(output, assigned, error):
    found, partial = {}, []
    for path in output.glob('day-*/episodes.jsonl'):
        for line in path.read_bytes().splitlines(keepends=True):
            try:
                if not line.endswith(b'\n'):
                    raise ValueError('unfinished row')
                row = json.loads(line)
                if row['id'] in found:
                    raise RuntimeError('Duplicate terminal episode key')
                found[row['id']] = row
            except (ValueError, KeyError):
                partial.append(dict(path=str(path.relative_to(output)),bytes=len(line),sha256=hashlib.sha256(line).hexdigest()))
    valid = {row['id'] for row in assigned}
    if not set(found) <= valid:
        raise RuntimeError('Worker emitted an unassigned episode')
    with (output/'denominators.jsonl').open('x') as handle:
        for row in assigned:
            record = found.get(row['id'],dict(**row,executionStatus='not_executed_after_shard_failure',reason=error))
            handle.write(json.dumps(record,separators=(',',':'))+'\n')
    completed = sum(row.get('executionStatus') in ('completed','known_prefix_only') for row in found.values())
    result = dict(expected=len(assigned),observedTerminalKeys=len(found),completed=completed,
                  missingKeys=len(assigned)-len(found),partialManifestLines=partial,error=error,
                  success=error is None and not partial and completed==len(assigned))
    (output/'summary.json').write_text(json.dumps(result,indent=2)+'\n')
    return result


def main(stage, route):
    if stage not in ('integration','pilot','full'):
        raise ValueError('Unsupported synthetic benchmark stage')
    assigned = expected(stage,route)
    if len(assigned) != {'integration':2,'pilot':84,'full':2016}[stage]:
        raise ValueError('Changed benchmark denominator')
    output = HERE/'results'/f'benchmark-{stage}-{route}'
    if output.exists():
        if set(path.name for path in output.iterdir()) != {'expected.json'} or json.loads((output/'expected.json').read_text()) != assigned:
            raise ValueError('Refusing to overwrite an existing benchmark')
    else:
        output.mkdir()
        (output/'expected.json').write_text(json.dumps(assigned,indent=2)+'\n')
    began = time.monotonic()
    error = None
    try:
        for date in dict.fromkeys(row['date'] for row in assigned):
            # Only this day's worker and input live at once. No React process
            # overlaps another day or shares module globals with another page.
            day = output/('day-'+date)
            day.mkdir()
            scratch = output/('capture-'+date)
            hour = '00' if stage == 'full' else '12'
            epoch = dt.datetime.fromisoformat(date+'T'+hour+':00:00-04:00').astimezone(dt.timezone.utc).isoformat()
            seconds = 87300 if stage == 'full' else 2700 if stage == 'pilot' else 60
            run([sys.executable,str(HERE/'make_synthetic_capture.py'),str(scratch),str(HERE/'results'/'baseline-assets'),epoch,str(seconds)],
                ROOT,ROOT,day/'generation-resources.json',seconds=max(1,SECONDS_LIMIT-300-(time.monotonic()-began)))
            shutil.copyfile(scratch/'generation.json',day/'input-provenance.json')
            shutil.copyfile(scratch/'prefix'/'prefix.json',day/'prefix.json')
            shutil.copyfile(scratch/'prefix'/'manifest.json',day/'capture-manifest.json')
            # Raw synthetic input bodies remain in the verified spool during
            # execution. Their duplicate producer/copy storage can be removed.
            with (scratch/'prefix'/'records.jsonl').open('rb') as source, (day/'journal.jsonl.gz').open('wb') as target:
                with gzip.GzipFile(fileobj=target,mode='wb',mtime=0) as compressed:
                    shutil.copyfileobj(source,compressed)
            shutil.rmtree(scratch/'source');shutil.rmtree(scratch/'prefix')
            ready = (scratch/'spool'/'ready.sha256').read_text().strip()
            (day/'spool-ready.sha256').write_text(ready+'\n')
            env = {**os.environ,'BENCH_STAGE':stage,'BENCH_ROUTE':str(route),'BENCH_DATE':date,
                   'BENCH_OUTPUT':str(day),'BENCH_SPOOL':str(scratch/'spool'),'BENCH_READY_SHA':ready,
                   'TZ':'America/New_York'}
            run(['npx','vitest','run','--config','../../research/synthetic-selection/benchmark.config.ts'],
                ROOT/'services'/'shuttle-v2',ROOT,day/'worker-resources.json',env=env,
                seconds=max(1,SECONDS_LIMIT-300-(time.monotonic()-began)))
            shutil.rmtree(scratch)
    except BaseException as failure:
        error = f'{type(failure).__name__}: {failure}'
    result = reconcile(output,assigned,error)
    print(json.dumps(result))
    if not result['success']:
        raise SystemExit(1)


if __name__ == '__main__':
    if sys.argv[1] in ('declare','reconcile'):
        action,stage,route=sys.argv[1:];route=int(route)
        output=HERE/'results'/f'benchmark-{stage}-{route}'
        assigned=expected(stage,route)
        if action=='declare':
            output.mkdir(parents=True,exist_ok=False)
            (output/'expected.json').write_text(json.dumps(assigned,indent=2)+'\n')
        elif not (output/'summary.json').exists():
            reconcile(output,assigned,'hosted job did not complete the assigned workload')
    else:
        main(sys.argv[1],int(sys.argv[2]))
