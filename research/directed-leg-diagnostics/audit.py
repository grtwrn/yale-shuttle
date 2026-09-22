"""Hosted artifact diagnostics only; no model or reconstruction changes."""
import bisect
import collections
import datetime as dt
import gzip
import hashlib
import json
import math
from pathlib import Path

HERE=Path(__file__).resolve().parent;OUT=HERE/'results';OUT.mkdir(exist_ok=True)
FROZEN=HERE.parent/'directed-leg-protection/results'
def read(path):
    with gzip.open(path,'rt') as f:return [json.loads(x) for x in f if x.strip()]
def write(name,rows):
    with gzip.open(OUT/(name+'.jsonl.gz'),'wt') as f:
        for row in rows:f.write(json.dumps(row,separators=(',',':'))+'\n')
def utc(t):return dt.datetime.fromtimestamp(t/1000,dt.timezone.utc).isoformat()
def metres(a,b):
    la1,la2=math.radians(a['lat']),math.radians(b['lat']);dl=la2-la1;dn=math.radians(b['lon']-a['lon'])
    return 6371000*2*math.asin(math.sqrt(math.sin(dl/2)**2+math.cos(la1)*math.cos(la2)*math.sin(dn/2)**2))
summary=json.loads((FROZEN/'summary.json').read_text())
rawfile=HERE.parent/'k-sweep/results/raw_positions.jsonl.gz'
assert hashlib.sha256(rawfile.read_bytes()).hexdigest()==summary['inputSha256']
top=json.loads((HERE.parent/'k-sweep/data/topology.json').read_text())
stops={s['id']:s for s in top['stops']};routes={r['id']:r for r in top['routes']}
base=read(FROZEN/'baseline-visits.jsonl.gz');new=read(FROZEN/'protected-visits.jsonl.gz')
baseid={r['id']:r for r in base};newid={r['id']:r for r in new}
labels=read(FROZEN/'label-comparison.jsonl.gz')
flagged=[r for r in labels if r['earlierBaselinePhysicalPickup']]
pairs={}
for r in flagged:
    a=r['earlierBaselinePhysicalPickup'];b=newid[r['protected']['id']];key=(a['id'],b['id'])
    item=pairs.setdefault(key,dict(baseline=a,protected=b,rows=[],raw=[]))
    item['rows'].append({k:r[k] for k in ('at','bus','route','target','targetIndex','loggedAnchorIndex','status')})
with gzip.open(rawfile,'rt') as f:
    for line in f:
        if not line.strip():continue
        r=json.loads(line)
        for pair in pairs.values():
            a,b=pair['baseline'],pair['protected']
            if r['bus_name']==a['bus_name'] and a['anchored_at']-120000<=r['collected_at']<=b['known_at']+120000:
                pair['raw'].append(r)
audits=[]
for pair in pairs.values():
    a,b=pair['baseline'],pair['protected'];rs=sorted(pair.pop('raw'),key=lambda r:(r['collected_at'],r['bus_id']))
    marker=stops[a['stop_id']];plateaus=[];run=[]
    def plateau(chunk):
        if not chunk:return None
        return dict(start=chunk[0]['collected_at'],end=chunk[-1]['collected_at'],startUtc=utc(chunk[0]['collected_at']),
            durationSec=(chunk[-1]['collected_at']-chunk[0]['collected_at'])/1000,polls=len(chunk),
            markerMetres=metres(chunk[0],marker),provider=chunk[0]['bus_id'],route=chunk[0]['route_id'],
            lastStopIds=sorted({r['last_stop_id'] for r in chunk if r.get('last_stop_id') is not None}))
    for r in rs:
        if run and ((r['lat'],r['lon'],r['bus_id'],r['route_id'])!=(run[-1]['lat'],run[-1]['lon'],run[-1]['bus_id'],run[-1]['route_id'])
                    or r['collected_at']-run[-1]['collected_at']>60000):
            plateaus.append(plateau(run));run=[]
        run.append(r)
    if run:plateaus.append(plateau(run))
    def span(start,end):
        chunk=[r for r in rs if start<=r['collected_at']<=end]
        near=[r for r in chunk if metres(r,marker)<=75]
        repeated=[p for p in plateaus if p['durationSec']>0 and p['end']>=start and p['start']<=end]
        return dict(rows=len(chunk),routes=sorted({r['route_id'] for r in chunk}),providers=sorted({r['bus_id'] for r in chunk}),
            minimumMarkerMetres=min((metres(r,marker) for r in chunk),default=None),pollsWithin75m=len(near),
            repeatedFixPlateaus=repeated,
            lastStopChanges=[dict(at=r['collected_at'],utc=utc(r['collected_at']),stop=r.get('last_stop_id')) for i,r in enumerate(chunk)
                if i==0 or r.get('last_stop_id')!=chunk[i-1].get('last_stop_id')],
            maxGapSec=max(((y['collected_at']-x['collected_at'])/1000 for x,y in zip(chunk,chunk[1:])),default=0),
            maxSpeedMps=max((metres(x,y)/max(.001,(y['collected_at']-x['collected_at'])/1000) for x,y in zip(chunk,chunk[1:])),default=0))
    audits.append(dict(baseline=a,protected=b,forecastRows=pair['rows'],marker=marker['name'],
        baselineArrivalUtc=utc(a['arrived_at']),protectedArrivalUtc=utc(b['arrived_at']),
        arrivalShiftSec=(b['arrived_at']-a['arrived_at'])/1000,
        baselineWindow=span(a['anchored_at'],a['known_at']),protectedWindow=span(b['anchored_at'],b['known_at']),
        wholeWindow=span(rs[0]['collected_at'],rs[-1]['collected_at']),
        evaluationBarrier='Retain the earlier baseline physical pickup; unresolved boarding interpretation.'))
(OUT/'earlier-pickup-audit.json').write_text(json.dumps(audits,indent=2)+'\n')

# Physical accounting does not use arrival error, nearest timestamp, or
# delete any ambiguous observation to obtain a nicer before/after count.
identity_fields=('bus_name','route_id','stop_id','stop_index','bus_id','anchor_bus_id')
physical_fields=identity_fields+('arrived_at','departed_at','outcome')
def ident(v):return tuple(v.get(k) for k in identity_fields)
def physical(v):return tuple(v.get(k) for k in physical_fields)
def classification(v):return 'anchor_only_'+v['outcome'] if v['arrived_at'] is None else 'arrived_'+v['outcome']
byroute={};ledger=[]
for rid in sorted({r['route_id'] for r in base+new}):
    aa=[r for r in base if r['route_id']==rid];bb=[r for r in new if r['route_id']==rid]
    remaining_a=[];remaining_b=[];a_groups=collections.defaultdict(list);b_groups=collections.defaultdict(list)
    for r in aa:a_groups[physical(r)].append(r)
    for r in bb:b_groups[physical(r)].append(r)
    exact=0;bookkeeping=collections.Counter()
    for key in a_groups.keys()|b_groups.keys():
        av=a_groups.get(key,[]);bv=b_groups.get(key,[]);n=min(len(av),len(bv));exact+=n
        for a,b in zip(av[:n],bv[:n]):
            for k in ('anchored_at','known_at','pinned_at','closest_m','how'):
                if a.get(k)!=b.get(k):bookkeeping[k]+=1
        remaining_a.extend(av[n:]);remaining_b.extend(bv[n:])
    cand_a=collections.defaultdict(list);cand_b=collections.defaultdict(list)
    for i,a in enumerate(remaining_a):
        if a['arrived_at'] is None:continue
        for j,b in enumerate(remaining_b):
            if b['arrived_at'] is not None and ident(a)==ident(b) and max(a['anchored_at'],b['anchored_at'])<=min(a['known_at'],b['known_at']):
                cand_a[i].append(j);cand_b[j].append(i)
    paired={i:js[0] for i,js in cand_a.items() if len(js)==1 and len(cand_b[js[0]])==1}
    paired_b=set(paired.values());changes=collections.Counter()
    for i,j in paired.items():
        a,b=remaining_a[i],remaining_b[j]
        fields=[k for k in ('arrived_at','departed_at','outcome') if a[k]!=b[k]]
        changes.update(fields);ledger.append(dict(route=rid,status='paired_physical_change',fields=fields,baseline=a,protected=b))
    suppressed=[a for i,a in enumerate(remaining_a) if i not in paired]
    added=[b for j,b in enumerate(remaining_b) if j not in paired_b]
    for status,vs in [('suppressed',suppressed),('new',added)]:
        for v in vs:ledger.append(dict(route=rid,status=status,classification=classification(v),visit=v))
    byroute[rid]=dict(name=routes[rid]['name'],baseline=len(aa),protected=len(bb),exactPhysicalSignatureMatches=exact,
        exactPhysicalBookkeepingChanges=dict(bookkeeping),pairedPhysicalChanges=len(paired),changedFields=dict(changes),
        suppressed=dict(collections.Counter(classification(v) for v in suppressed)),new=dict(collections.Counter(classification(v) for v in added)),
        ambiguousOldOverlap=sum(len(js)>1 for js in cand_a.values()),ambiguousNewOverlap=sum(len(js)>1 for js in cand_b.values()))
    assert exact+len(paired)+len(suppressed)==len(aa)
    assert exact+len(paired)+len(added)==len(bb)
write('physical-visit-differences',ledger)
barrier_rows=[];statuses=collections.Counter()
for r in labels:
    blocked=bool(r['earlierBaselinePhysicalPickup'] and r['protected'])
    # Preserve all original fields and labels as evidence. The barrier's
    # separate field cannot overwrite the frozen experiment.
    if blocked:barrier_rows.append(dict(r,evaluationLabel=None,evaluationReason='earlier baseline physical pickup retained as barrier'))
    statuses['blocked_new_label' if blocked else r['status']]+=1
write('earlier-pickup-barriers',barrier_rows)
result=dict(sourceRun=35687909547,sourceCommit='c80ab5f',guardAndQualityUnchanged=True,modelScoresComputed=False,
    earlierPickupForecastRows=len(flagged),earlierPickupPhysicalPairs=len(pairs),barrierStatuses=dict(statuses),routes=byroute)
(OUT/'summary.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps({k:v for k,v in result.items() if k!='routes'}))
