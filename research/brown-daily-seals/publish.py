"""After Actions upload/download, verify publication without replay or refitting."""
import argparse
import os
import sys
from contract import *

def validate_catalog(catalog,request,artifact,at_ms):
    c=schedule(request['day'])
    require(catalog.get('status')=='sealed_pending_publish','no completed seal')
    require(catalog.get('requestId')==request['requestId'],'foreign publication')
    require(catalog.get('requestSha256')==sha(canonical(request)+b'\n'),'request/publication mismatch')
    require(catalog['builtAt']>=request['createdAt'] and catalog['builtAt']<=catalog['publishedAt']<=at_ms,'publication clock order')
    require(all(catalog[k]==c[k] for k in ('validFrom','validUntil','contextOnly')),'publication schedule')
    require(catalog['artifactId']==artifact['id'] and catalog['artifactDigest']==artifact['digest'],'publication artifact mismatch')
    require(not artifact.get('expired') and catalog['runId']==artifact['workflow_run']['id'],'expired/foreign artifact')
    require(time_ms(artifact['created_at'])<=catalog['publishedAt'],'publication predates artifact')
    # Publication discovered after expiry remains evidence, never an active model.
    return dict(catalog,acceptedAt=at_ms,status='expired' if at_ms>=c['validUntil'] else
        'available_late' if at_ms>c['validFrom'] else 'available')

def main():
    p=argparse.ArgumentParser();p.add_argument('--directory',required=True);p.add_argument('--status',required=True);p.add_argument('--artifact-id',type=int,required=True);p.add_argument('--artifact-digest',required=True);args=p.parse_args()
    require(os.environ.get('GITHUB_ACTIONS')=='true','hosted only')
    directory=Path(args.directory);status=strict_json(Path(args.status).read_bytes())
    require(status['status']=='sealed_pending_publish','unsealed output')
    sys.path.insert(0,str(ROOT/'research/brown-model-seal'))
    import runtime
    _,manifest=runtime.load(directory,status['modelId'])
    require(manifest['builtAt']==status['builtAt'],'published model clock mismatch')
    require(manifest['creatingRun']==os.environ['GITHUB_RUN_ID'],'foreign model run')
    require(now_ms()>=status['builtAt'],'future model')
    catalog=dict(status,artifactId=args.artifact_id,artifactDigest=args.artifact_digest,
        publishedAt=now_ms(),runId=int(os.environ['GITHUB_RUN_ID']),runAttempt=int(os.environ['GITHUB_RUN_ATTEMPT']),
        requestCommit=os.environ['GITHUB_SHA'])
    write_json(HERE/'results/publication.json',catalog)
    from sealing import annotation
    annotation(catalog)

if __name__=='__main__':main()
