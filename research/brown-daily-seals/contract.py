"""Small metadata contract. Safe to import on the publisher; never decodes GPS."""
import datetime as dt
import hashlib
import json
import math
from pathlib import Path
from zoneinfo import ZoneInfo

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
TZ = ZoneInfo('America/New_York')
PROTOCOL_SHA = '4d1e09bd3cb41762a11e19a7de49bcfb8d8c479b44b3354a845df1b6c8f82742'
COLS = ['bus_id','bus_name','route_id','lat','lon','heading','last_stop_id','collected_at']
ARCHIVER_SHA = '59a7860f488d513ada3d4b65d17d64540581e41771d70f826a2dcb0b8f2cc198'
ARCHIVER = Path('/home/gwarren/yale-shuttle-wt/loop/services/shuttle-v2/scripts/archive-day.mjs')
STATES = {'waiting_archive','provenance_invalid','queued','running','operational_failure','scientific_halt',
          'sealed_pending_publish','available','available_late','expired'}

class InputError(ValueError): pass
class ScientificHalt(RuntimeError): pass

def require(value, message):
    if not value: raise InputError(message)

def canonical(value):
    return json.dumps(value,sort_keys=True,separators=(',',':'),allow_nan=False).encode()

def sha(raw): return hashlib.sha256(raw).hexdigest()

def file_sha(path):
    h=hashlib.sha256()
    with Path(path).open('rb') as stream:
        for data in iter(lambda:stream.read(1024*1024),b''):h.update(data)
    return h.hexdigest()

def strict_json(raw):
    def pairs(items):
        result={}
        for k,v in items:
            require(k not in result,'duplicate JSON key');result[k]=v
        return result
    def number(value):
        n=float(value);require(math.isfinite(n),'nonfinite JSON number');return n
    return json.loads(raw,object_pairs_hook=pairs,parse_float=number,
        parse_constant=lambda x: (_ for _ in ()).throw(InputError('nonfinite JSON number')))

def now_ms(): return int(dt.datetime.now(dt.timezone.utc).timestamp()*1000)
def utc(ms): return dt.datetime.fromtimestamp(ms/1000,dt.timezone.utc).isoformat()
def time_ms(value):
    parsed=dt.datetime.fromisoformat(value.replace('Z','+00:00'))
    require(parsed.tzinfo is not None,'timestamp needs timezone');return int(parsed.timestamp()*1000)
def day_start(day): return int(dt.datetime.combine(dt.date.fromisoformat(day),dt.time(),TZ).timestamp()*1000)

def schedule(day, fixture=False):
    require(day in [f'2026-09-{d:02}' for d in range(23 if fixture else 24,31)],'unapproved forecast day')
    raw=(ROOT/'research/brown-directed/PROSPECTIVE-FOUR-ARM.json').read_bytes()
    require(sha(raw)==PROTOCOL_SHA,'changed four-arm lock')
    row=next(x for x in strict_json(raw)['rolling'] if x['dayET']==day)
    start,end,cutoff=map(time_ms,(row['validFrom'],row['validUntil'],row['trainBefore']))
    require(cutoff==day_start(day)-86400000 and start==day_start(day),'changed embargo')
    require(end==start+(1800000 if day=='2026-09-30' else 86400000),'changed validity')
    last=(dt.date.fromisoformat(day)-dt.timedelta(days=2)).isoformat()
    return dict(day=day,trainBefore=cutoff,validFrom=start,validUntil=end,contextOnly=row['contextOnly'],
                lastRawDay=last,rawDays=[f'2026-09-{d:02}' for d in range(22,int(last[-2:])+1)])

def safe_file(root, relative):
    root=Path(root).resolve();p=Path(relative)
    require(not p.is_absolute() and '..' not in p.parts,'path escape')
    target=root/p
    require(all(not x.is_symlink() for x in [target,*target.parents] if x!=root.parent),'symlink input')
    require(target.is_file() and target.resolve().is_relative_to(root),'missing archive file')
    return target

def selected_archive(archive_root,day,at_ms):
    root=Path(archive_root)/day
    manifest=safe_file(root,'manifest.json');raw=manifest.read_bytes();m=strict_json(raw)
    require(m.get('version')==2 and m.get('day')==day,'archive format/day mismatch')
    start=day_start(day);require(m.get('from')==start and m.get('to')==start+86400000,'archive day bounds')
    require(at_ms>=start+86400000,'raw day is not closed')
    t=m.get('tables',{}).get('raw_positions',{})
    require(t.get('complete') is True and not any(t.get(k) for k in ('error','integrityError','replacementError')),'raw transport/integrity unavailable')
    require(t.get('columns')==COLS,'unsupported archive columns')
    require(start+86400000<=time_ms(t['capturedAt'])<=at_ms,'archive capture time invalid/future')
    require(time_ms(t['capturedAt'])<start+36*3600000,'archive capture after raw retention deadline')
    pos=m.get('positions') or {}
    require(t.get('source') in ('server','server+capture') and pos.get('server')==pos.get('merged')==t.get('rows'),
            'capture-only rows lack original poll provenance')
    require(type(t.get('rows')) is int and t['rows']>=0,'invalid declared rows')
    require(type(t.get('bytes')) is int and 0<t['bytes']<=32*1024**2,'compressed raw size bound')
    require(type(t.get('rawBytes')) is int and 0<=t['rawBytes']<=512*1024**2,'uncompressed raw size bound')
    f=safe_file(root,t['file']);require(f.stat().st_size==t['bytes'],'raw file size mismatch')
    # The selected snapshot can predate lastAttempt after a retained retry.
    snap=safe_file(root,str(Path(t['file']).parent/'manifest.json'));s=strict_json(snap.read_bytes())
    require(s.get('day')==day and s.get('tables',{}).get('raw_positions')==t,'selected snapshot metadata mismatch')
    return dict(day=day,manifest=m,manifestBytes=raw,snapshotBytes=snap.read_bytes(),table=t,file=f)

def publication_eligible(entry,forecast_at):
    return (entry.get('status') in ('available','available_late') and
            entry['builtAt']<=forecast_at and entry['acceptedAt']<=forecast_at and
            entry['validFrom']<=forecast_at<entry['validUntil'])

def write_json(path,value,exclusive=False):
    path=Path(path);path.parent.mkdir(parents=True,exist_ok=True)
    if exclusive:
        with path.open('xb') as f:f.write(canonical(value)+b'\n')
    else:
        temp=path.with_name(path.name+'.tmp')
        temp.write_bytes(canonical(value)+b'\n');temp.replace(path)
