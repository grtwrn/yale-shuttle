"""Small pure provenance contract; no capture bodies or network access."""
import datetime as dt
import hashlib
import json
import math
from pathlib import Path
import re

GIB=1024**3
RECORDER='4f494f132da14bd369b768605190a77319ef1586e326f062289ec6f1274115b3'
UTC=dt.timezone.utc
def require(value,message):
    if not value:raise ValueError(message)
def digest(raw):return hashlib.sha256(raw).hexdigest()
def encoded(value):return (json.dumps(value,sort_keys=True,separators=(',',':'),allow_nan=False)+'\n').encode()
def parse_json(raw):
    def pairs(items):
        out={}
        for k,v in items:require(k not in out,'duplicate metadata key');out[k]=v
        return out
    def floating(value):
        number=float(value);require(math.isfinite(number),'nonfinite metadata');return number
    return json.loads(raw,object_pairs_hook=pairs,parse_float=floating,parse_constant=lambda _:(_ for _ in ()).throw(ValueError('nonfinite metadata')))
def read_json(path,limit=1024*1024):
    path=Path(path);require(not path.is_symlink() and path.is_file(),'nonregular/symlink metadata')
    with path.open('rb') as f:raw=f.read(limit+1)
    require(len(raw)<=limit,'metadata size bound')
    return parse_json(raw),raw
def utc_us(value):
    require(isinstance(value,str),'UTC string required')
    require(not re.search(r'\.\d{7,}',value),'sub-microsecond recorder timestamp unsupported')
    at=dt.datetime.fromisoformat(value.replace('Z','+00:00'));require(at.utcoffset()==dt.timedelta(0),'explicit UTC required')
    delta=at-dt.datetime(1970,1,1,tzinfo=UTC)
    return (delta.days*86400+delta.seconds)*1000000+delta.microseconds
def now_us():return utc_us(dt.datetime.now(UTC).isoformat())
def part_map(plan):return {p['id']:p for p in plan['parts']}
def validate_plan(plan):
    require(plan['schema']==1 and plan['base']=='https://yale-shuttle.fly.dev','unsupported plan')
    require(plan['maximumParts']==3 and plan['maximumAggregateBytes']==9*GIB and plan['maximumPartBytes']==3*GIB and plan['minimumFreeBytes']==4*GIB,'changed approved storage limits')
    require(plan['bodyLimitBytes']==8*1024**2 and plan['intervalSeconds']==15 and plan['healthIntervalSeconds']==60,'changed recorder bounds/cadence')
    require(plan['overlapPreludeSeconds']==60 and plan['handoffDeadlineSeconds']==120,'changed overlap/deadline')
    require(plan['recorderSha256']==RECORDER and plan['deadline']=='2026-09-30T04:30:00Z','changed recorder/deadline')
    require([p['id'] for p in plan['parts']]==['A','B','C'],'part addition/reordering')
    require([p['primaryUntil'] for p in plan['parts']]==['2026-09-25T04:00:00Z','2026-09-28T04:00:00Z',plan['deadline']],'changed fixed boundaries')
    for i,p in enumerate(plan['parts']):
        require(re.fullmatch(r'shuttle-public-fleet-\d{8}\.service',p['unit']),'unexpected unit')
        require(Path(p['directory']).name==p['directory'] and p['directory'] not in ('.','..'),'part path escape')
        require(utc_us(p['primaryFrom'])<utc_us(p['primaryUntil']),'empty primary interval')
        if i:
            require(p['existing'] is False and p['previousPart']==plan['parts'][i-1]['id'],'invalid predecessor')
            require(p['primaryFrom']==plan['parts'][i-1]['primaryUntil'],'gap/overlap in ownership')
            require(utc_us(p['launchAt'])==utc_us(p['primaryFrom'])-60000000,'changed prelude')
        else:require(p['existing'] is True and p['preservedPrefix']['records']>0,'missing original prefix anchor')
    require(len({p['unit'] for p in plan['parts']})==3 and len({p['directory'] for p in plan['parts']})==3,'duplicate part identity')
    return plan
def load_deployment(path,expected_sha):
    manifest,raw=read_json(path);require(digest(raw)==expected_sha,'deployment manifest hash mismatch');validate_plan(manifest['plan'])
    root=Path(path).parent
    for name,sha in manifest['toolHashes'].items():
        require(not Path(name).is_absolute() and '..' not in Path(name).parts,'tool path escape')
        p=root/name;require(not p.is_symlink() and p.is_file() and digest(p.read_bytes())==sha,'tool hash mismatch: '+name)
    return manifest
