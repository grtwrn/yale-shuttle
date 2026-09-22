"""Reconcile every scheduled key, including missing generation and worker artifacts."""
import json
import hashlib
from pathlib import Path
import sys
from benchmark import expected, DATES, ROUTES
from capture_input import file_hash


def input_checks(root):
    reports=[]; previous=None
    for date in DATES:
        directory=root/('selection-input-metadata-'+date)
        resource=None
        try:
            resource=json.loads((directory/'generation-resources.json').read_text())
            shared=json.loads((directory/'shared.json').read_text())
            ready=json.loads((directory/'spool-ready.json').read_text())
            if shared['date']!=date or shared['syntheticOnly'] is not True or shared['outcomes'] is not False:
                raise ValueError('Wrong shared metadata assignment')
            if file_hash(directory/'spool-ready.json')[0]!=shared['readySha256'] or shared['generator']!=ready['syntheticGenerator']:
                raise ValueError('Shared readiness metadata differs')
            if any(shared[key]!=ready[key] for key in ('captureId','prefixSha256','databaseSha256','databaseBytes')):
                raise ValueError('Shared identity differs from sealed input')
            if file_hash(directory/'fleet-index.jsonl')[0]!=shared['fleetIndexSha256']:
                raise ValueError('Changed shared fleet index')
            if resource['exitCode']!=0 or resource['limitViolation'] is not None:
                raise ValueError('Generation resource failure')
            observed={}
            for line in (directory/'fleet-index.jsonl').read_text().splitlines():
                row=json.loads(line)
                if row['atUs'] in observed:raise ValueError('Duplicate original fleet receipt clock')
                observed[row['atUs']]=(row['receivedAtUtc'],row['bodySha256'])
            if len(observed)!=shared['fleetReceipts']:raise ValueError('Changed fleet index count')
            overlaps=0
            if previous is not None:
                overlap=observed.keys() & previous.keys();overlaps=len(overlap)
                if not overlap or any(observed[at]!=previous[at] for at in overlap):
                    raise ValueError('Adjacent synthetic daily inputs disagree')
            previous=observed
            reports.append(dict(date=date,success=True,shared=shared,resources=resource,adjacentOverlapReceipts=overlaps))
        except (OSError,KeyError,ValueError,TypeError) as error:
            previous=None
            reports.append(dict(date=date,success=False,error=str(error),resources=resource))
    return reports


def aggregate(stage,root,output):
    root,output=Path(root),Path(output);output.mkdir(parents=True,exist_ok=False)
    assignments=[(route,date) for date in DATES for route in ROUTES] if stage=='full' else [(0,None)]
    inputs=input_checks(root) if stage=='full' else []
    by_date={row['date']:row for row in inputs}
    counts=dict(expected=0,completed=0,missingArtifactKeys=0,terminalKeys=0,rawBytes=0,compressedBytes=0,rows=0,retainedStreams=0)
    strata,shards,statuses={},[],{};seen=set();retained_errors=[]
    with (output/'all-denominators.jsonl').open('w') as combined:
        for route,date in assignments:
            suffix=f'{route}-{date}' if date else str(route)
            directory=root/f'selection-scale-{stage}-{suffix}'
            summaries=list(directory.glob('**/summary.json')) if directory.exists() else []
            issues=[]
            try:
                if len(summaries)!=1:raise ValueError('missing or ambiguous shard summary')
                summary=json.loads(summaries[0].read_text())
                if not isinstance(summary,dict):raise ValueError('invalid summary object')
            except (OSError,ValueError) as error:
                summary={'success':False,'error':str(error)}
            records=list(directory.glob('**/denominators.jsonl')) if directory.exists() else []
            observed={};ambiguous=set()
            planned=expected(stage,route,date);valid={row['id'] for row in planned}
            if len(records)==1:
                for line in records[0].read_bytes().splitlines(keepends=True):
                    try:
                        if not line.endswith(b'\n'):raise ValueError('unfinished denominator row')
                        record=json.loads(line);key=record['id']
                        if key not in valid:raise ValueError('unexpected shard key')
                        if key in observed or key in ambiguous:
                            ambiguous.add(key);observed.pop(key,None)
                            raise ValueError('ambiguous duplicate shard key')
                        observed[key]=record
                    except (ValueError,KeyError,TypeError) as error:
                        issues.append(dict(error=str(error),bytes=len(line),sha256=hashlib.sha256(line).hexdigest()))
            else:issues.append(dict(error='missing or ambiguous denominator manifest'))
            if issues:summary={**summary,'success':False,'artifactIssues':issues}
            for row in planned:
                if row['id'] in seen:raise RuntimeError('Duplicate global key')
                seen.add(row['id']);counts['expected']+=1
                record=observed.get(row['id'],{**row,'executionStatus':'shard_artifact_unavailable','reason':summary.get('error')})
                counts['terminalKeys']+=int(row['id'] in observed)
                counts['missingArtifactKeys']+=int(row['id'] not in observed)
                counts['completed']+=int(record.get('executionStatus')=='completed')
                for key in ('rawBytes','compressedBytes','rows'):counts[key]+=record.get('output',{}).get(key,0)
                counts['retainedStreams']+=int(record.get('output',{}).get('retained',False))
                if record.get('output',{}).get('retained'):
                    try:
                        output_record=record['output']; relative=Path(output_record['file'])
                        if relative.is_absolute() or '..' in relative.parts:raise ValueError('Unsafe retained path')
                        stream=records[0].parent/('day-'+row['date'])/relative
                        if file_hash(stream)!=(output_record['compressedSha256'],output_record['compressedBytes']):
                            raise ValueError('Retained stream hash differs')
                    except (OSError,KeyError,ValueError,TypeError) as error:
                        retained_errors.append(dict(id=row['id'],error=str(error)))
                status='/'.join(str(record.get(k,'unknown')) for k in ('initialStatus','versionStatus','coverageStatus','executionStatus'))
                statuses[status]=statuses.get(status,0)+1
                group=f"{row['date']}/{row['generatingRouteId']}/{row['profile']}"
                strata.setdefault(group,{})[status]=strata.setdefault(group,{}).get(status,0)+1
                combined.write(json.dumps(record,separators=(',',':'))+'\n')
            resources=[]
            for path in directory.glob('**/*-resources.json') if directory.exists() else []:
                try:
                    resource=json.loads(path.read_text())
                    if not all(key in resource for key in ('elapsedSeconds','exitCode','limitViolation')):raise ValueError('incomplete resource report')
                    resources.append(resource)
                except (OSError,ValueError,TypeError) as error:
                    summary={**summary,'success':False,'resourceError':str(error)}
            if stage=='full':
                evidence=list(directory.glob('**/shared-input.json')) if directory.exists() else []
                generation=by_date[date]
                try:shared_ok=generation['success'] and len(evidence)==1 and json.loads(evidence[0].read_text())==generation['shared']
                except (OSError,ValueError):shared_ok=False
                summary={**summary,'sharedInputMatchesGeneration':shared_ok,'success':summary.get('success') and shared_ok}
                resources_ok=len(resources)==1 and resources[0]['exitCode']==0 and resources[0]['limitViolation'] is None
                summary.update(resourceReportValid=resources_ok,success=summary['success'] and resources_ok)
            shards.append(dict(route=route,date=date,summary=summary,resources=resources))
    worker_resources=[resource for shard in shards for resource in shard['resources']]
    generation_resources=[row['resources'] for row in inputs if row.get('resources') is not None]
    success=all(s['summary'].get('success') for s in shards) and counts['completed']==counts['expected'] and not counts['missingArtifactKeys'] and not retained_errors
    if stage=='full':
        success=success and counts['expected']==28224 and counts['retainedStreams']==168 and all(row['success'] for row in inputs)
    report=dict(stage=stage,success=success,counts=counts,statuses=statuses,strata=strata,shards=shards,sharedInputs=inputs,retainedStreamErrors=retained_errors,
                resourceTotals=dict(workerElapsedSeconds=sum(r['elapsedSeconds'] for r in worker_resources),
                                    generationElapsedSeconds=sum(r['elapsedSeconds'] for r in generation_resources),
                                    generationReportsCountedOnce=len(generation_resources),
                                    workerResourceReports=len(worker_resources),
                                    setupAndJobTiming='GitHub job timestamps; dependency installation/artifact transfers and baseline asset rebuild are outside workload watchdog'),
                strictIdentityKnownEpisodes=0,assumptionQualifiedEpisodes=sum(n for k,n in statuses.items() if '/assumption_qualified/' in k),
                syntheticOnly=True,outcomesEvaluated=False)
    (output/'REPORT.json').write_text(json.dumps(report,indent=2)+'\n')
    print(json.dumps(dict(stage=stage,success=success,counts=counts,statuses=statuses)))
    return report


if __name__=='__main__':
    if not aggregate(*sys.argv[1:])['success']:raise SystemExit(1)
