"""Reconcile every scheduled key, including shards whose artifact is missing."""
import json
from pathlib import Path
import sys
from benchmark import expected

stage, root, output = sys.argv[1:]
root, output = Path(root), Path(output)
routes = [1,2,3,4,8,9,10,13,14,15,16,17,18,19] if stage == 'full' else [0]
output.mkdir(parents=True,exist_ok=False)
counts = dict(expected=0,completed=0,missingArtifactKeys=0,terminalKeys=0,rawBytes=0,compressedBytes=0,rows=0)
strata, shards, statuses = {}, [], {}
seen = set()
with (output/'all-denominators.jsonl').open('w') as combined:
    for route in routes:
        directory=root/f'selection-scale-{stage}-{route}'
        summaries=list(directory.glob('**/summary.json')) if directory.exists() else []
        summary=json.loads(summaries[0].read_text()) if len(summaries)==1 else {'success':False,'error':'missing or ambiguous shard summary'}
        records=list(directory.glob('**/denominators.jsonl')) if directory.exists() else []
        observed={}
        if len(records)==1:
            for line in records[0].read_text().splitlines():
                record=json.loads(line)
                if record['id'] in observed:raise RuntimeError('Duplicate shard key')
                observed[record['id']]=record
        planned=expected(stage,route)
        if not set(observed)<={row['id'] for row in planned}:raise RuntimeError('Unexpected shard keys')
        for row in planned:
            if row['id'] in seen:raise RuntimeError('Duplicate global key')
            seen.add(row['id']);counts['expected']+=1
            record=observed.get(row['id'],{**row,'executionStatus':'shard_artifact_unavailable','reason':summary.get('error')})
            counts['terminalKeys']+=int(row['id'] in observed)
            counts['missingArtifactKeys']+=int(row['id'] not in observed)
            counts['completed']+=int(record.get('executionStatus')=='completed')
            for key in ('rawBytes','compressedBytes','rows'):counts[key]+=record.get('output',{}).get(key,0)
            status='/'.join(str(record.get(k,'unknown')) for k in ('initialStatus','versionStatus','coverageStatus','executionStatus'))
            statuses[status]=statuses.get(status,0)+1
            group=f"{row['date']}/{row['generatingRouteId']}/{row['profile']}"
            strata.setdefault(group,{})[status]=strata.setdefault(group,{}).get(status,0)+1
            combined.write(json.dumps(record,separators=(',',':'))+'\n')
        resources=[]
        for path in directory.glob('**/*-resources.json') if directory.exists() else []:
            resources.append(json.loads(path.read_text()))
        shards.append(dict(route=route,summary=summary,resources=resources))
success=all(s['summary'].get('success') for s in shards) and counts['completed']==counts['expected'] and not counts['missingArtifactKeys']
report=dict(stage=stage,success=success,counts=counts,statuses=statuses,strata=strata,shards=shards,
            strictIdentityKnownEpisodes=0,assumptionQualifiedEpisodes=sum(n for k,n in statuses.items() if '/assumption_qualified/' in k),
            syntheticOnly=True,outcomesEvaluated=False)
(output/'REPORT.json').write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps(dict(stage=stage,success=success,counts=counts,statuses=statuses)))
if not success:raise SystemExit(1)
