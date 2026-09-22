"""Launch/handoff control. Reads transport metadata only; never capture bodies."""
import argparse
import datetime as dt
import json
import os
from pathlib import Path
import subprocess
import time
from continuation_common import require,read_json,parse_json,digest,encoded,utc_us,now_us,part_map,load_deployment,RECORDER

def recorder_args(plan,part):
    args=['/usr/bin/python3',plan['recorderPath'],str(Path(plan['evidenceRoot'])/part['directory']),'--until',plan['deadline']]
    if not part['existing']:args+=['--max-bytes',str(plan['maximumPartBytes']),'--minimum-free-bytes',str(plan['minimumFreeBytes'])]
    return args

def launch_check(plan,part,at,exists,script_sha):
    require(not part['existing'],'A may not be restarted or overwritten')
    require(utc_us(part['launchAt'])<=at<utc_us(part['primaryFrom'])+plan['handoffDeadlineSeconds']*1000000,'launch outside fixed overlap/handoff window')
    require(not exists,'capture part directory already exists; never resume into it')
    require(script_sha==RECORDER,'frozen recorder bytes changed')
    return recorder_args(plan,part)

def snapshot_metadata(directory,plan):
    """Read only one committed manifest prefix, with bounded live metadata I/O."""
    root=Path(directory);require(not root.is_symlink(),'capture directory symlink')
    m,_=read_json(root/'manifest.json')
    require(m['scriptSha256']==RECORDER and m['base']==plan['base'],'successor recorder identity changed')
    require(m['maxStoredBytes']==plan['maximumPartBytes'] and m['minimumFreeBytes']==plan['minimumFreeBytes'],'successor storage limits changed')
    require(m['until'].replace('+00:00','Z')==plan['deadline'],'successor deadline changed')
    require(m['intervalSeconds']==15 and m['healthIntervalSeconds']==60 and m['bodyLimitBytes']==plan['bodyLimitBytes'],'successor cadence/body limit changed')
    require(type(m['storedDataBytes']) is int and 0<=m['storedDataBytes']<=plan['maximumPartBytes'],'successor byte count exceeds pinned cap')
    require(type(m['records']) is int and 0<=m['records']<=4096,'handoff metadata bound exceeded')
    journal=root/'records.jsonl';rows=[];head=None;last_mono=None;last_wall=None;unsafe=False;total=0
    if m['records']:
        require(journal.is_file() and not journal.is_symlink(),'missing/symlink successor journal')
        with journal.open('rb') as f:
            for sequence in range(m['records']):
                line=f.readline(1024*1024+1);total+=len(line)
                require(line.endswith(b'\n') and len(line)<=1024*1024 and total<=16*1024*1024,'incomplete/oversize handoff metadata')
                r=parse_json(line);require(type(r['sequence']) is int and r['sequence']==sequence and r['previousRecordSha256']==head,'successor journal chain mismatch');head=digest(line)
                if r['kind']=='schedule-gap':
                    wall=utc_us(r['at']);unsafe=unsafe or last_wall is not None and wall<last_wall;last_wall=wall
                else:
                    req,rec=utc_us(r['requestedAt']),utc_us(r['receivedAt'])
                    require(type(r['requestMonotonic']) in (int,float) and type(r['receivedMonotonic']) in (int,float),'invalid monotonic clock')
                    require(0<=r['requestMonotonic']<=r['receivedMonotonic'] and (last_mono is None or r['requestMonotonic']>=last_mono),'noncausal successor monotonic clock')
                    unsafe=unsafe or rec<req or last_wall is not None and req<last_wall
                    last_wall=rec;last_mono=r['receivedMonotonic']
                rows.append(dict(record=r,clockUnsafe=unsafe))
    require(head==m['lastRecordSha256'],'successor manifest head mismatch')
    return m,rows

def handoff_decision(plan,part,at,metadata=None):
    begin=utc_us(part['primaryFrom']);end=begin+plan['handoffDeadlineSeconds']*1000000
    if at<begin:return dict(status='waiting',reason='before fixed primary boundary')
    if metadata:
        m,rows=metadata
        if any(item['clockUnsafe'] for item in rows):return dict(status='failed',reason='unsafe successor clock; preserve predecessor for audit')
        for item in rows:
            r=item['record']
            if r['kind']!='fleet':continue
            requested,received=utc_us(r['requestedAt']),utc_us(r['receivedAt'])
            complete=(r.get('transportComplete') is True and r.get('status')==200 and r.get('readComplete') is True and not r.get('errorType')
                      and r.get('jsonObject') is True and r.get('fleetSchema') is True)
            if begin<=requested and requested<=received<=min(at,end) and complete and not item['clockUnsafe']:
                return dict(status='ready',reason='persisted complete primary fleet request',sourceSequence=r['sequence'],receivedAt=r['receivedAt'],
                            successorManifestHead=m['lastRecordSha256'],successorManifestRecords=m['records'])
    if at>=end:return dict(status='failed',reason='no complete primary fleet request within two minutes; preserve predecessor for audit')
    return dict(status='waiting',reason='successor primary transport not yet proved')

def matching_running_unit(unit,args):
    pid=int(subprocess.check_output(['/usr/bin/systemctl','--user','show',unit,'-p','MainPID','--value'],text=True).strip() or 0)
    if pid==0:return False
    observed=[s.decode() for s in (Path('/proc')/str(pid)/'cmdline').read_bytes().split(b'\0') if s]
    require(observed==args,'unit PID does not run the exact pinned recorder/part command')
    return True

def write_audit(path,row):
    # Exclusive creation makes re-execution unable to rewrite a prior result.
    path.parent.mkdir(parents=True,exist_ok=True)
    with path.open('xb') as f:f.write(encoded(row))

def main():
    p=argparse.ArgumentParser();p.add_argument('action',choices=['launch','handoff']);p.add_argument('--part',choices=['B','C'],required=True)
    p.add_argument('--manifest',type=Path,required=True);p.add_argument('--sha256',required=True);a=p.parse_args()
    manifest=load_deployment(a.manifest,a.sha256);plan=manifest['plan'];part=part_map(plan)[a.part]
    require(Path(__file__).resolve().parent==Path(manifest['bundleRoot']),'control not running from frozen bundle root')
    script=Path(plan['recorderPath']);require(not script.is_symlink() and digest(script.read_bytes())==RECORDER,'frozen recorder changed')
    directory=Path(plan['evidenceRoot'])/part['directory']
    if a.action=='launch':
        args=launch_check(plan,part,now_us(),directory.exists(),digest(script.read_bytes()));os.execv(args[0],args)
    output=Path(manifest['auditRoot'])/f'handoff-{a.part}.json'
    require(not output.exists(),'handoff already recorded; no automatic retry or result rewrite')
    predecessor=part_map(plan)[part['previousPart']];errors=[];started=now_us();deadline=utc_us(part['primaryFrom'])+120000000;started_mono=time.monotonic()
    # A delayed service invocation cannot manufacture a timely handoff.
    if started>deadline:
        write_audit(output,dict(status='failed',reason='handoff service started after fixed deadline',startedAtUs=started,part=a.part));return 1
    try:
        while True:
            require(time.monotonic()-started_mono<=130,'monotonic handoff budget expired; clock discontinuity cannot extend it')
            at=now_us();metadata=None
            try:
                if directory.exists():metadata=snapshot_metadata(directory,plan)
            except (ValueError,OSError,KeyError) as error:
                errors.append(dict(atUs=at,errorType=type(error).__name__,message=str(error)))
            result=handoff_decision(plan,part,at,metadata)
            if result['status']=='ready':
                require(matching_running_unit(part['unit'],recorder_args(plan,part)),'successor process no longer active')
                active=matching_running_unit(predecessor['unit'],recorder_args(plan,predecessor))
                if active:subprocess.run(['/usr/bin/systemctl','--user','stop',predecessor['unit']],check=True)
                result.update(status='complete',predecessorWasActive=active,predecessorStopped=active)
            if result['status']!='waiting':
                write_audit(output,dict(**result,part=a.part,manifestSha256=a.sha256,startedAtUs=started,finishedAtUs=now_us(),metadataErrors=errors,
                                       bodyReads=0,ownershipBoundariesChanged=False));return 0 if result['status']=='complete' else 1
            time.sleep(1)
    except BaseException as error:
        if not output.exists():write_audit(output,dict(status='failed',part=a.part,errorType=type(error).__name__,message=str(error),startedAtUs=started,
                                                      finishedAtUs=now_us(),manifestSha256=a.sha256,metadataErrors=errors,bodyReads=0))
        raise

if __name__=='__main__':raise SystemExit(main())
