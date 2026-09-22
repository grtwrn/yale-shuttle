"""Hosted artifact transport fixture; no real seal, training input or model."""
import os
import subprocess
import sys
from contract import *

def main():
    require(os.environ.get('GITHUB_ACTIONS')=='true','hosted fixture only')
    mode=sys.argv[1];original=HERE/'work/transport-original';published=HERE/'work/transport-published'
    if mode=='prepare':
        write_json(original/'fixture.json',dict(kind='synthetic-not-a-model',runId=int(os.environ['GITHUB_RUN_ID']),
            runAttempt=int(os.environ['GITHUB_RUN_ATTEMPT']),preparedAt=now_ms(),payload=[0,1,None,'two\nlines']))
        return
    require(mode=='verify','unknown fixture operation')
    raw=(original/'fixture.json').read_bytes();received=(published/'fixture.json').read_bytes()
    require(raw==received,'artifact extraction/layout changed fixture bytes')
    fixture=strict_json(raw);identity=int(os.environ['ARTIFACT_ID']);digest='sha256:'+os.environ['ARTIFACT_DIGEST']
    artifact=strict_json(subprocess.check_output(['gh','api',f'repos/grtwrn/yale-shuttle/actions/artifacts/{identity}']))
    at=now_ms()
    require(artifact['id']==identity and artifact['digest']==digest,'artifact API/output identity mismatch')
    require(artifact['workflow_run']['id']==fixture['runId'] and not artifact['expired'],'foreign or expired fixture')
    require(fixture['preparedAt']<=time_ms(artifact['created_at'])<=at,'artifact clock order')
    write_json(HERE/'results/transport.json',dict(status='passed',kind=fixture['kind'],artifactId=identity,
        artifactDigest=digest,bodySha256=sha(raw),runId=fixture['runId'],runAttempt=fixture['runAttempt'],
        preparedAt=fixture['preparedAt'],artifactCreatedAt=artifact['created_at'],verifiedReceiptAt=at,
        modelFitted=False,actualSealPublished=False))

if __name__=='__main__':main()
