"""Hosted report-only reuse: preserve every fitted/forecast byte and provenance."""
import argparse
import hashlib
import json
from pathlib import Path

HERE=Path(__file__).resolve().parent;ROOT=HERE/'results'
SOURCE_RUN=35741682149
SOURCE_SHA='323ce80f95f254f29a713abc5b176628eaa507e2'
def sha(path):
    h=hashlib.sha256()
    with path.open('rb') as f:
        for block in iter(lambda:f.read(1048576),b''):h.update(block)
    return h.hexdigest()
def inputs(directory):
    names={'unscored.jsonl.gz','enriched.jsonl.gz','forecasts.jsonl.gz','verification.json'}
    return {str(p.relative_to(directory)):sha(p) for p in sorted(directory.rglob('*'))
        if p.is_file() and (p.name in names or p.name.startswith(('training-paths-','vector-queries-')))}
def main(policy,freeze):
    directory=ROOT/policy;path=directory/'reuse-audit.json'
    if freeze:
        run=json.loads((ROOT/'study-run-metadata.json').read_text())
        assert run['id']==SOURCE_RUN and run['head_sha']==SOURCE_SHA
        artifacts=json.loads((ROOT/'study-artifact-metadata.json').read_text())['artifacts']
        matches=[a for a in artifacts if a['name']=='checkpoint-ensemble-complete-'+policy]
        assert len(matches)==1 and matches[0]['digest'].startswith('sha256:')
        controls=json.loads((directory/'verification.json').read_text())
        assert controls['policy']==policy and controls['exactOldSingleControls']==152188
        assert controls['labelsExact']>0 and len(controls['prefixChecks'])==2
        before=inputs(directory)
        assert all(n in before for n in ('unscored.jsonl.gz','enriched.jsonl.gz','forecasts.jsonl.gz',
            'original-cohort/forecasts.jsonl.gz','point-only/forecasts.jsonl.gz','original-cohort/point-only/forecasts.jsonl.gz'))
        for part in ('','original-cohort','point-only','original-cohort/point-only'):
            link=directory/part/'raw_positions.jsonl.gz'
            if not link.exists():link.symlink_to((HERE.parent/'k-sweep/results/raw_positions.jsonl.gz').resolve())
        value=dict(sourceRun=run['id'],fittingCode=run['head_sha'],sourceArtifact=matches[0],before=before,
            noRefitting=True,noLabelRegeneration=True,afterExact=None)
    else:
        value=json.loads(path.read_text());after=inputs(directory)
        assert after==value['before'],'Report/action stage changed a frozen fitted/forecast stream'
        value['afterExact']=True
    path.write_text(json.dumps(value,indent=2)+'\n')
    print(json.dumps(dict(policy=policy,files=len(value['before']),afterExact=value['afterExact'],noRefitting=True)))
if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--policy',required=True);g=p.add_mutually_exclusive_group(required=True)
    g.add_argument('--freeze',action='store_true');g.add_argument('--verify',action='store_true');a=p.parse_args();main(a.policy,a.freeze)
