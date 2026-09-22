"""Immutable compressed packages; only hosted iter_rows decompresses raw GPS."""
import gzip
import json
import math
import os
from pathlib import Path
import shutil
from contract import *

def package(archive_root,day,destination,at_ms,archiver=ARCHIVER):
    selected=selected_archive(archive_root,day,at_ms)
    require(file_sha(archiver)==ARCHIVER_SHA,'unrecognized archive normalization implementation')
    dest=Path(destination);require(not dest.exists(),'input selection already frozen')
    dest.mkdir(parents=True)
    try:
        shutil.copyfile(selected['file'],dest/'raw_positions.jsonl.gz')
        require(file_sha(dest/'raw_positions.jsonl.gz')==selected['table']['sha256'],'copied archive hash mismatch')
        (dest/'selected-manifest.json').write_bytes(selected['manifestBytes'])
        (dest/'snapshot-manifest.json').write_bytes(selected['snapshotBytes'])
        shutil.copyfile(archiver,dest/'archive-day.mjs')
        finished=now_ms();require(finished>=at_ms,'publisher clock regressed during copy')
        record=dict(schema=1,format='archive-v2-normalized-raw-v1',day=day,packagedAt=finished,
            archiveScriptSha256=ARCHIVER_SHA,archiveScriptProvenance='source observed at packaging; manifest metadata attests the selected export',
            files={p.name:file_sha(p) for p in sorted(dest.iterdir())},table=selected['table'])
        write_json(dest/'package.json',record,True)
        return dict(day=day,packageSha256=file_sha(dest/'package.json'))
    except BaseException:
        # Failed candidates stay outside the selected namespace, never reused.
        dest.rename(dest.with_name(dest.name+'.rejected-'+str(at_ms)))
        raise

def verify_package(root,expected,at_ms):
    root=Path(root);require(file_sha(root/'package.json')==expected,'changed input package')
    p=strict_json((root/'package.json').read_bytes())
    require(p.get('schema')==1 and p.get('format')=='archive-v2-normalized-raw-v1','unknown input format')
    require(type(p['packagedAt']) is int and p['packagedAt']<=at_ms and p['archiveScriptSha256']==ARCHIVER_SHA,'future/unrecognized package')
    require(set(p['files'])=={'raw_positions.jsonl.gz','selected-manifest.json','snapshot-manifest.json','archive-day.mjs'},'unexpected package files')
    require(p['files']['archive-day.mjs']==ARCHIVER_SHA,'archive implementation hash mismatch')
    for name,digest in p['files'].items():require(file_sha(safe_file(root,name))==digest,'changed packaged file')
    # Validate metadata without requiring the original absolute archive path.
    m=strict_json((root/'selected-manifest.json').read_bytes());s=strict_json((root/'snapshot-manifest.json').read_bytes())
    t=p['table'];start=day_start(p['day']);pos=m.get('positions') or {}
    require(m.get('version')==2 and m.get('day')==s.get('day')==p['day'],'package day/version mismatch')
    require(m.get('from')==start and m.get('to')==start+86400000,'package day bounds')
    require(m['tables']['raw_positions']==s['tables']['raw_positions']==t,'package selected-table mismatch')
    require(t.get('complete') is True and not any(t.get(k) for k in ('error','integrityError','replacementError')),'raw transport unavailable')
    require(t.get('columns')==COLS and t.get('source') in ('server','server+capture'),'unsupported normalized raw')
    require(type(t.get('rows')) is int and t['rows']>=0 and type(t.get('rawBytes')) is int and 0<=t['rawBytes']<=512*1024**2,'invalid row/byte bound')
    require(type(t.get('bytes')) is int and 0<t['bytes']<=32*1024**2,'invalid gzip byte bound')
    require(pos.get('server')==pos.get('merged')==t.get('rows'),'capture-only provenance')
    require(start+86400000<=time_ms(t['capturedAt'])<start+36*3600000 and time_ms(t['capturedAt'])<=p['packagedAt'],'capture clock/retention')
    require(t['sha256']==p['files']['raw_positions.jsonl.gz'] and (root/'raw_positions.jsonl.gz').stat().st_size==t['bytes'],'raw descriptor mismatch')
    return p

def iter_rows(root,expected,at_ms):
    require(os.environ.get('GITHUB_ACTIONS')=='true','GPS decoding is hosted only')
    p=verify_package(root,expected,at_ms);start=day_start(p['day']);seen=set();count=0;size=0;previous=None
    with gzip.open(Path(root)/'raw_positions.jsonl.gz','rb') as stream:
        for line in stream:
            size+=len(line);require(len(line)<=65536 and size<=p['table']['rawBytes'],'raw byte/line limit')
            require(line.endswith(b'\n'),'incomplete normalized JSONL line')
            row=strict_json(line);require(type(row) is dict and set(row)==set(COLS),'raw schema')
            for k in ('bus_id','route_id','collected_at'):require(type(row[k]) is int,'raw integer identity')
            require(type(row['bus_name']) is str and bool(row['bus_name']),'raw bus name')
            for k in ('lat','lon'):require(type(row[k]) in (int,float) and math.isfinite(row[k]),'raw coordinate')
            require(-90<=row['lat']<=90 and -180<=row['lon']<=180,'raw coordinate range')
            for k in ('heading','last_stop_id'):require(row[k] is None or (type(row[k]) in (int,float) and math.isfinite(row[k])),'raw optional value')
            require(start<=row['collected_at']<start+86400000,'raw day/cutoff')
            key=(row['bus_id'],row['collected_at']);require(key not in seen,'duplicate/conflicting raw key');seen.add(key)
            order=(row['collected_at'],row['bus_id']);require(previous is None or order>=previous,'normalized raw order');previous=order
            count+=1;yield row
    require(count==p['table']['rows'] and size==p['table']['rawBytes'],'raw transport row/byte count')

def append_packages(base,output,selections,at_ms):
    require(os.environ.get('GITHUB_ACTIONS')=='true','hosted only')
    output=Path(output);require(not output.exists(),'merged input exists')
    counts={}
    with output.open('xb') as target,gzip.GzipFile(filename='',mode='wb',fileobj=target,mtime=0) as dest:
        with gzip.open(base,'rb') as old:
            for line in old:dest.write(line)
        for selection in selections:
            count=0
            for row in iter_rows(selection['directory'],selection['packageSha256'],at_ms):
                dest.write(canonical(row)+b'\n');count+=1
            counts[selection['day']]=count
    return counts
