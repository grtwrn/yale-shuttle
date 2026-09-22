"""Hosted orchestration; no fit command is reachable by metadata publishers."""
import argparse
import gzip
import hashlib
import importlib.util
import os
import shutil
import subprocess
import sys
from contract import *
from inputs import append_packages,iter_rows,verify_package
from generate import write_sources

ROLLING=ROOT/'research/brown-rolling-seal'

def module(path,name):
    spec=importlib.util.spec_from_file_location(name,path);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m

def verify_implementation():
    lock=strict_json((HERE/'IMPLEMENTATION.json').read_bytes())
    for name,digest in lock['files'].items():require(file_sha(safe_file(ROOT,name))==digest,'changed implementation: '+name)
    require(lock['protocolSha256']==PROTOCOL_SHA,'changed implementation protocol')
    return lock

def validate_request(path,digest,at_ms):
    raw=Path(path).read_bytes();require(sha(raw)==digest,'request hash mismatch');r=strict_json(raw)
    require(set(r)=={'schema','requestId','day','createdAt','implementation','implementationManifestSha256','inputs'},'request schema')
    require(r['schema']==1 and type(r['requestId']) is str and r['requestId'],'request identity')
    require(type(r['createdAt']) is int and r['createdAt']<=at_ms,'future request')
    c=schedule(r['day']);require(c['trainBefore']<=r['createdAt'] and at_ms<c['validUntil'],'request outside allowed time')
    require(r['implementationManifestSha256']==file_sha(HERE/'IMPLEMENTATION.json'),'request implementation mismatch')
    require(type(r['implementation']) is str and len(r['implementation'])==40,'unfixed implementation commit')
    lock=verify_implementation()
    for file in [*lock['files'],'research/brown-daily-seals/IMPLEMENTATION.json']:
        expected=subprocess.check_output(['git','show',r['implementation']+':'+file],cwd=ROOT)
        require(sha(expected)==file_sha(ROOT/file),'request implementation commit changed')
    require([x['day'] for x in r['inputs']]==c['rawDays'],'missing/reordered input day')
    for entry in r['inputs']:
        require(set(entry)=={'day','directory','packageSha256'},'input selection schema')
        require(entry['directory']=='research/brown-daily-seals/data/'+entry['day'],'foreign input directory')
        p=verify_package(ROOT/entry['directory'],entry['packageSha256'],r['createdAt'])
        require(p['day']==entry['day'],'package date mismatch')
    return r,c,lock

def stage_base():
    (ROLLING/'input').mkdir(exist_ok=True)
    # Original transport parser prepares the unchanged Sep3–21 prefix.
    module(ROLLING/'prepare.py','original_daily_prepare').main()
    return ROLLING/'input/merged-raw.jsonl.gz'

def invoke(command,stage):
    rc=subprocess.call(command,cwd=ROOT)
    if rc:raise ScientificHalt(f'{stage} stopped; retain gate failure before any publication (exit {rc})')

def run_request(path,digest):
    require(os.environ.get('GITHUB_ACTIONS')=='true','hosted only')
    r,c,lock=validate_request(path,digest,now_ms())
    base=stage_base();old=base.with_name('sep3-21-original.jsonl.gz');base.rename(old)
    entries=[dict(x,directory=str(ROOT/x['directory'])) for x in r['inputs']]
    counts=append_packages(old,base,entries,r['createdAt'])
    audit=strict_json((ROLLING/'input/raw-audit.json').read_bytes())
    audit.update(mergedSha256=file_sha(base),dailyRawRows=counts,requestSha256=digest,trainingRawDays=c['rawDays'])
    write_json(ROLLING/'input/raw-audit.json',audit)
    write_json(ROLLING/'input/daily-raw-provenance.json',dict(request=r,baseOriginalAudit=audit,
        packages=[strict_json((Path(x['directory'])/'package.json').read_bytes()) for x in entries]))
    replay,builder=write_sources(c,lock['files'])
    invoke(['services/shuttle-v2/node_modules/.bin/tsx',str(replay)],'daily physical/source/prefix gate')
    require(now_ms()<c['validUntil'],'expired before model build')
    invoke([sys.executable,str(builder)],'daily physical/path/fit gate')
    m=strict_json((ROLLING/'results/manifest.json').read_bytes())
    require(m['builtAt']>=r['createdAt'] and m['builtAt']<c['validUntil'],'invalid actual model build time')
    require(all(m[k]==c[k] for k in ('trainBefore','validFrom','validUntil')),'sealed schedule mismatch')
    return dict(status='sealed_pending_publish',requestId=r['requestId'],requestSha256=digest,day=c['day'],
        modelId=m['artifactId'],builtAt=m['builtAt'],validFrom=c['validFrom'],validUntil=c['validUntil'],contextOnly=c['contextOnly'])

def normalization_fixture():
    require(os.environ.get('GITHUB_ACTIONS')=='true','hosted only')
    verify_implementation();base=stage_base()
    package=HERE/'fixtures-data/2026-09-21';digest=file_sha(package/'package.json')
    provenance=strict_json((ROLLING/'data/raw-provenance.json').read_bytes())
    original=module(ROLLING/'prepare.py','original_fixture_prepare').decode_capture(
        ROLLING/'data/raw_positions.original.jsonl.gz',provenance['table'])
    normalized=list(iter_rows(package,digest,now_ms()))
    projected=sorted(({k:r[k] for k in COLS} for r in original),key=lambda r:(r['collected_at'],r['bus_id']))
    require(projected==normalized,'Sep21 normalization changed reducer inputs')
    old=ROOT/'research/k-sweep/results/raw_positions.jsonl.gz'
    base.unlink()
    append_packages(old,base,[dict(day='2026-09-21',directory=str(package),packageSha256=digest)],now_ms())
    c=schedule('2026-09-23',fixture=True)
    replay,_=write_sources(c,verify_implementation()['files'])
    invoke(['services/shuttle-v2/node_modules/.bin/tsx',str(replay)],'Sep21 normalization reducer parity')
    summary=strict_json((ROLLING/'replay-results/parity-summary.json').read_bytes())
    require(summary['Brown']['discrepancyKeys']==0,'Sep21 physical discrepancy')
    reference=HERE/'work/sep23-reference/replay-results'
    def unpacked_hash(path):
        h=hashlib.sha256()
        with gzip.open(path,'rb') as stream:
            for chunk in iter(lambda:stream.read(1024*1024),b''):h.update(chunk)
        return h.hexdigest()
    equality={}
    for name in ('baseline-visits.jsonl.gz','candidate-visits.jsonl.gz','baseline-events.jsonl.gz','candidate-events.jsonl.gz'):
        current=unpacked_hash(ROLLING/'replay-results'/name);old=unpacked_hash(reference/name)
        require(current==old,'Sep21 normalized replay changed saved original event/visit stream: '+name)
        equality[name]=current
    result=dict(status='passed',normalizationRows=len(normalized),sameReducerInputs=True,
        newModelsFitted=0,newRawDaysRead=[],forecastOutcomeScores=0,gate=summary,
        originalReplayRun=35696391115,originalReplayArtifactId=10680881133,originalStreamEquality=equality)
    write_json(HERE/'results/normalization.json',result)
    return result

def annotation(result):
    text=canonical(result).decode().replace('%','%25').replace('\r','%0D').replace('\n','%0A')
    print('::notice title=brown-daily-seal-result::'+text,flush=True)

def main():
    p=argparse.ArgumentParser();p.add_argument('--request');p.add_argument('--expected-request-sha256');p.add_argument('--normalization-fixture',action='store_true');args=p.parse_args()
    require(os.environ.get('GITHUB_ACTIONS')=='true','hosted only')
    (HERE/'results').mkdir(exist_ok=True)
    try:
        if args.normalization_fixture:
            require(not args.request and not args.expected_request_sha256,'fixture cannot launch a model')
            result=normalization_fixture()
        else:
            require(args.request and args.expected_request_sha256,'fixed request required')
            result=run_request(args.request,args.expected_request_sha256)
        write_json(HERE/'results/status.json',result)
    except BaseException as error:
        status='scientific_halt' if isinstance(error,ScientificHalt) else 'provenance_invalid' if isinstance(error,InputError) else 'operational_failure'
        result=dict(status=status,errorType=type(error).__name__,message=str(error)[:500],at=now_ms())
        write_json(HERE/'results/status.json',result);annotation(result);raise
    annotation(result)

if __name__=='__main__':main()
