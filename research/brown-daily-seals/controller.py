"""Lightweight root-owned publisher. No gzip parsing, fitting, endpoint tokens or delivery."""
import argparse
import contextlib
import datetime as dt
import os
from pathlib import Path
import subprocess
import uuid
from contract import *
from inputs import package,verify_package
from publish import validate_catalog
from sealing import verify_implementation

REPO='grtwrn/yale-shuttle'
BRANCH='research/brown-daily-seals-2026-09-22'
WORKFLOW='research-brown-daily-seal'

def command(*args):return subprocess.check_output(args,cwd=ROOT,text=True).strip()
def api(path):return strict_json(command('gh','api','repos/'+REPO+'/'+path))

@contextlib.contextmanager
def locked(root):
    root=Path(root);root.mkdir(parents=True,exist_ok=True);lock=root/'controller.lock'
    try:lock.mkdir()
    except FileExistsError:raise InputError('Controller lock exists: inspect/reconcile crash; never steal a live lock')
    write_json(lock/'owner.json',dict(pid=os.getpid(),at=now_ms(),id=str(uuid.uuid4())),True)
    try:yield
    finally:(lock/'owner.json').unlink();lock.rmdir()

def load_state(root):
    p=Path(root)/'state.json'
    return strict_json(p.read_bytes()) if p.exists() else dict(schema=1,days={},selections={})

def save_state(root,state):write_json(Path(root)/'state.json',state)

def may_attempt(state,day):
    existing=state['days'].get(day)
    if existing and existing['status'] in ('available','available_late','expired'):return 'already_sealed'
    if existing and existing['status']=='scientific_halt':raise InputError('Scientific halt requires review; no automatic retry')
    require(not any(x['status'] in ('queued','running','sealed_pending_publish') for x in state['days'].values()),'another request is pending/running')
    return 'attempt'

def due_day(at_ms):
    local=dt.datetime.fromtimestamp(at_ms/1000,TZ)
    if not (dt.date(2026,9,23)<=local.date()<=dt.date(2026,9,29)):return None
    # Persistent catch-up is allowed after 04:10, never assigned a historical time.
    if (local.hour,local.minute)<(4,10):return None
    return (local.date()+dt.timedelta(days=1)).isoformat()

def verify_code(implementation,branch):
    require(branch==BRANCH,'unapproved request branch')
    require(command('git','branch','--show-current')==branch,'wrong publisher checkout')
    require(len(implementation)==40 and all(c in '0123456789abcdef' for c in implementation),'full reviewed implementation SHA required')
    lock=verify_implementation()
    for name in [*lock['files'],'research/brown-daily-seals/IMPLEMENTATION.json']:
        require(sha(subprocess.check_output(['git','show',implementation+':'+name],cwd=ROOT))==file_sha(ROOT/name),'reviewed implementation changed')
    require(not command('git','diff','--name-only') and not command('git','diff','--cached','--name-only'),'publisher has tracked edits')

def inspect_day(day,archive_root,at_ms):
    c=schedule(day);rows=[]
    for raw_day in c['rawDays']:
        try:
            x=selected_archive(archive_root,raw_day,at_ms)
            rows.append(dict(day=raw_day,status='metadata_ready',table=x['table']))
        except (OSError,ValueError,KeyError) as e:rows.append(dict(day=raw_day,status='waiting_archive' if isinstance(e,FileNotFoundError) or not (Path(archive_root)/raw_day/'manifest.json').exists() else 'provenance_invalid',reason=str(e)))
    return dict(schedule=c,at=at_ms,raw=rows,bodyDecoded=False)

def publish_day(args,state,at_ms):
    c=schedule(args.forecast_day)
    result=may_attempt(state,c['day'])
    if result!='attempt':return dict(status=result,day=c['day'])
    require(c['trainBefore']<=at_ms<c['validUntil'],'forecast day not ready or expired')
    verify_code(args.implementation,args.request_branch)
    selections=[]
    for day in c['rawDays']:
        directory='research/brown-daily-seals/data/'+day;dest=ROOT/directory
        old=state['selections'].get(day)
        if old:
            verify_package(dest,old['packageSha256'],at_ms)
            selected=old
        else:
            # A package copied before a publisher crash is immutable and can be
            # adopted only after all copied descriptors/hash checks pass.
            if dest.exists():
                digest=file_sha(dest/'package.json');verify_package(dest,digest,at_ms)
                selected=dict(day=day,packageSha256=digest)
            else:selected=package(args.archive_root,day,dest,at_ms)
            state['selections'][day]=selected;save_state(args.state_root,state)
        selections.append(dict(selected,directory=directory))
    created=now_ms();require(created>=at_ms and created<c['validUntil'],'publisher clock regressed or request expired')
    for selection in selections:verify_package(ROOT/selection['directory'],selection['packageSha256'],created)
    identity=c['day']+'-'+str(created)+'-'+uuid.uuid4().hex
    request=dict(schema=1,requestId=identity,day=c['day'],createdAt=created,implementation=args.implementation,
        implementationManifestSha256=file_sha(HERE/'IMPLEMENTATION.json'),inputs=selections)
    relative='research/brown-daily-seals/requests/'+identity+'.json';path=ROOT/relative
    write_json(path,request,True);digest=file_sha(path)
    previous=state['days'].get(c['day'])
    entry=dict(status='queued',requestId=identity,requestPath=relative,requestSha256=digest,requestCommit=None,
        createdAt=created,day=c['day'],previousAttempt=previous)
    state['days'][c['day']]=entry;save_state(args.state_root,state)
    paths=[relative,*[x['directory'] for x in selections]]
    subprocess.run(['git','add','--',*paths],cwd=ROOT,check=True)
    subprocess.run(['git','commit','-m','Request fixed Brown daily seal '+c['day']],cwd=ROOT,check=True)
    entry['requestCommit']=command('git','rev-parse','HEAD');save_state(args.state_root,state)
    subprocess.run(['git','push','origin','HEAD:refs/heads/'+BRANCH],cwd=ROOT,check=True)
    return entry

def results_for(run_id):
    jobs=api(f'actions/runs/{run_id}/jobs?per_page=100')['jobs'];results=[]
    for job in jobs:
        url=job.get('check_run_url','');prefix='https://api.github.com/repos/'+REPO+'/check-runs/'
        require(url.startswith(prefix),'foreign check run')
        check=url[len(prefix):];require(check.isdigit(),'invalid check ID')
        annotations=api('check-runs/'+check+'/annotations?per_page=100')
        for a in annotations:
            if a.get('title')=='brown-daily-seal-result':results.append(strict_json(a['message']))
    return results

def apply_run(entry,run,results,artifact,at_ms):
    require(run['head_sha']==entry['requestCommit'],'foreign run commit')
    result=dict(entry,runId=run['id'],runAttempt=run['run_attempt'])
    if run['status']!='completed':result['status']='running' if run['status']=='in_progress' else 'queued';return result
    halts=[r for r in results if r.get('status')=='scientific_halt']
    if halts:return dict(result,status='scientific_halt',failure=halts[0])
    invalid=[r for r in results if r.get('status')=='provenance_invalid']
    if invalid:return dict(result,status='provenance_invalid',failure=invalid[0])
    if run['conclusion']!='success':return dict(result,status='operational_failure',conclusion=run['conclusion'],evidence=results)
    publications=[r for r in results if 'publishedAt' in r]
    require(len(publications)==1,'successful run lacks unique verified publication')
    pub=publications[0]
    require(pub['runId']==run['id'] and pub['runAttempt']==run['run_attempt'] and pub['requestCommit']==entry['requestCommit'],'foreign publication run')
    request=strict_json((ROOT/entry['requestPath']).read_bytes())
    accepted=validate_catalog(pub,request,artifact,at_ms)
    return dict(result,status=accepted['status'],publication=accepted)

def reconcile(args,state,at_ms):
    for day,entry in list(state['days'].items()):
        if entry['status'] in ('available','available_late','expired','scientific_halt'):continue
        commit=entry.get('requestCommit')
        if not commit:
            candidate=command('git','log','-1','--format=%H','--',entry['requestPath'])
            if not candidate:continue  # visibly queued; crash needs explicit review
            raw=subprocess.check_output(['git','show',candidate+':'+entry['requestPath']],cwd=ROOT)
            require(sha(raw)==entry['requestSha256'],'recovery request mismatch');entry['requestCommit']=candidate;commit=candidate
        runs=api(f'actions/runs?head_sha={commit}&per_page=100')['workflow_runs']
        runs=[r for r in runs if r['name']==WORKFLOW and r['head_sha']==commit]
        require(len(runs)<=1,'ambiguous duplicate seal runs')
        if not runs:continue  # unknown admission is not evidence a job failed
        run=runs[0];results=results_for(run['id']) if run['status']=='completed' else []
        publications=[r for r in results if 'publishedAt' in r]
        artifact=api('actions/artifacts/'+str(publications[0]['artifactId'])) if len(publications)==1 else None
        receipt_at=now_ms();require(receipt_at>=at_ms,'publisher clock regressed while reading publication')
        updated=apply_run(entry,run,results,artifact,receipt_at)
        state['days'][day]=updated
        if updated['status'] in ('available','available_late','expired'):
            catalog=Path(args.state_root)/'catalog'/f"{day}-{updated['requestId']}.json"
            if catalog.exists():
                saved=strict_json(catalog.read_bytes())
                require(saved['artifactId']==updated['publication']['artifactId'] and saved['requestSha256']==updated['requestSha256'],'catalog conflict')
                updated['publication']=saved;updated['status']=saved['status']
            else:write_json(catalog,updated['publication'],True)
        save_state(args.state_root,state)
    return state

def main():
    p=argparse.ArgumentParser();p.add_argument('mode',choices=['inspect','publish','due','reconcile']);p.add_argument('--forecast-day');p.add_argument('--archive-root',default='/home/gwarren/shuttle-archive');p.add_argument('--implementation');p.add_argument('--state-root');p.add_argument('--request-branch',default=BRANCH);args=p.parse_args();at=now_ms()
    if args.mode=='inspect':print(json.dumps(inspect_day(args.forecast_day,args.archive_root,at)));return
    require(args.state_root,'explicit state root required')
    with locked(args.state_root):
        state=load_state(args.state_root)
        if args.mode in ('due','reconcile'):reconcile(args,state,at)
        if args.mode=='reconcile':print(json.dumps(state));return
        if args.mode=='due':
            args.forecast_day=due_day(at)
            if not args.forecast_day:print(json.dumps(dict(status='outside_fixed_schedule')));return
        try:result=publish_day(args,state,at)
        except (OSError,InputError) as error:
            # Do not replace queued/scientific/accepted state after a metadata or
            # transport exception. A future tick must reconcile the actual run.
            if args.forecast_day not in state['days']:
                state['days'][args.forecast_day]=dict(day=args.forecast_day,status='waiting_archive' if not (Path(args.archive_root)/schedule(args.forecast_day)['lastRawDay']/'manifest.json').exists() else 'provenance_invalid',reason=str(error),at=at)
                save_state(args.state_root,state)
            raise
        print(json.dumps(result))

if __name__=='__main__':main()
