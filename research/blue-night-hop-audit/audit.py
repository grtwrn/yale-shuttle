"""Hosted-only diagnosis, without changing any canonical outcome or model."""
import bisect
import collections
import datetime as dt
import gzip
import hashlib
import json
import math
from pathlib import Path
import sys

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / 'canonical-diagnostics'))
import diagnose as diag
study, rr, ev = diag.study, diag.rr, diag.ev
OUT = HERE / 'results'
RID = 13


def read(path):
    with gzip.open(path, 'rt') as f:
        for line in f:
            if line.strip():
                yield json.loads(line)


def utc(t):
    return dt.datetime.fromtimestamp(t/1000, dt.timezone.utc).isoformat()


def slim(v):
    return {k: v.get(k) for k in ('id', 'bus_name', 'bus_id', 'anchor_bus_id', 'route_id',
        'stop_index', 'stop_id', 'anchored_at', 'arrived_at', 'departed_at', 'known_at',
        'outcome', 'how', 'closest_m', 'replay_contended_at_emission')}


def write(name, rows):
    with gzip.open(OUT / (name+'.jsonl.gz'), 'wt') as f:
        for r in rows:
            f.write(json.dumps(r, separators=(',', ':'))+'\n')


def first_bad_hop(sequence, previous, n):
    """Exact traversal guard used by the canonical labeler."""
    for v in sequence:
        hop = ev.distance(previous, v['stop_index'], n)
        if hop > 5:
            return previous, v, hop
        previous = v['stop_index']
    return None


def main():
    OUT.mkdir(exist_ok=True)
    study.configure()
    route = ev.ROUTES[RID]; seq = route['stops']; n = len(seq)
    published = next(r for r in json.loads((HERE.parent/'k-sweep/data/topology.json').read_text())['routes'] if r['id']==RID)
    topology = json.loads((study.OUT/'canonical-topology.json').read_text())
    stops = {s['id']: s for s in topology['stops']}
    visits = [v for v in read(study.OUT/'training-visits.jsonl.gz') if v['route_id']==RID]
    names = {v['bus_name'] for v in visits}
    raw = [r for r in read(ev.IN/'raw_positions.jsonl.gz') if r['bus_name'] in names]
    assert all(ev.date(r['collected_at']) <= '2026-09-20' for r in raw), 'Unexpected later outcome'
    bybus = collections.defaultdict(list)
    for r in raw: bybus[r['bus_name']].append(r)
    for rs in bybus.values(): rs.sort(key=lambda r:(r['collected_at'],r['bus_id']))
    times = {bus:[r['collected_at'] for r in rs] for bus,rs in bybus.items()}
    quality = diag.DiagnosticQuality(raw)
    track = collections.defaultdict(list)
    for v in visits: track[v['bus_name']].append(v)
    for vs in track.values(): vs.sort(key=lambda v:(v['anchored_at'],v['id']))

    def gps(bus, start, end):
        rs, ts = bybus[bus], times[bus]
        lo=max(0,bisect.bisect_right(ts,start)-1); hi=min(len(ts)-1,bisect.bisect_left(ts,end))
        chunk=rs[lo:hi+1]
        edges=[diag.edge(a,b) for a,b in zip(chunk,chunk[1:])]
        mins=[]
        for i,sid in enumerate(seq):
            values=[(diag.metres(r,stops[sid]),r['collected_at']) for r in chunk]
            d,at=min(values) if values else (None,None)
            mins.append(dict(index=i,stop=sid,name=stops[sid]['name'],minDistanceM=d,at=at))
        return dict(rows=len(chunk),start=ts[lo],end=ts[hi],routes=sorted({r['route_id'] for r in chunk}),
            providers=sorted({r['bus_id'] for r in chunk}),quality=quality.describe(bus,RID,start,end),
            maxGapSec=max((e[0] for e in edges),default=0),maxSpeedMps=max((e[1]/max(.001,e[0]) for e in edges),default=0),
            providerLastStopChanges=[dict(at=r['collected_at'],stop=r.get('last_stop_id')) for i,r in enumerate(chunk)
                if i==0 or r.get('last_stop_id')!=chunk[i-1].get('last_stop_id')],nearestEachStop=mins)

    failures=[]; accepted=collections.defaultdict(list)
    ev.CUTOFF=study.FROZEN
    admitted=[v for v in visits if rr.available(v,study.FROZEN)]
    qtrain=diag.DiagnosticQuality([r for r in raw if r['collected_at']<study.FROZEN])
    model=study.Models(admitted,qtrain)
    training_status=collections.defaultdict(collections.Counter)
    for bus, full in track.items():
        vs=[v for v in full if rr.available(v,study.FROZEN) and v['arrived_at']<study.FROZEN]
        for w in ev.WAITS[RID]:
            k=10; source=(w-k)%n; wanted={k+ev.distance(w,t,n):t for t in ev.targets(RID,w)}
            for pos,s in enumerate(vs):
                if s['stop_index']!=source or not ev.valid(s) or s['departed_at']>=study.FROZEN: continue
                progress=0; prev=s; reached=set(); reason='source_track_exhausted'
                for v in vs[pos+1:]:
                    if v['arrived_at']<=s['departed_at']: continue
                    duration=(v['arrived_at']-s['departed_at'])/1000
                    if duration>ev.MODEL_CAP: reason='over_model_duration_cap'; break
                    hop=ev.distance(prev['stop_index'],v['stop_index'],n)
                    if hop>5:
                        reason='forward_occurrence_hop_over_5'
                        failures.append(dict(population='training',bus=bus,at=v['arrived_at'],wait=w,source=slim(s),
                            previous=slim(prev),next=slim(v),previousIndex=prev['stop_index'],nextIndex=v['stop_index'],hop=hop,
                            unreachedTargets=[ti for p,ti in wanted.items() if p not in reached]))
                        break
                    progress+=hop;prev=v
                    if progress>max(wanted): reason='passed_requested_occurrence';break
                    if progress not in wanted or progress in reached: continue
                    reached.add(progress);ti=wanted[progress]
                    if not ev.valid(v):training_status[w,ti]['invalid_target']+=1;continue
                    if not qtrain.ok(bus,RID,s['departed_at'],v['arrived_at']):training_status[w,ti]['quality_rejected']+=1;continue
                    training_status[w,ti]['accepted']+=1
                    accepted[RID,k,w,ti].append(dict(start=s['departed_at'],end=v['arrived_at'],day=ev.date(s['departed_at']),
                        duration=duration,weekend=ev.weekend(s['departed_at']),bus=bus,sourceId=s['id'],targetId=v['id']))
                for p,ti in wanted.items():
                    if p not in reached: training_status[w,ti][reason]+=1
    expected={cell:paths for cell,paths in model.paths.items() if cell[0]==RID and cell[1]==10 and paths}
    assert {cell:paths for cell,paths in accepted.items() if paths}==expected, 'K10 admitted paths changed'
    outcomes=study.Outcomes(visits,quality)
    expected_labels={study.key(r):r['label'] for r in read(study.OUT/'forecasts.jsonl.gz') if r['route']==RID}
    label_status=collections.Counter();checked=0
    for r in read(study.OUT/'unscored.jsonl.gz'):
        if r['route']!=RID:continue
        label,reason=outcomes.label(r);checked+=1;label_status[reason or 'accepted']+=1
        assert label==expected_labels.get(study.key(r)), 'Canonical Blue Night labels changed'
        if reason!='unresolved forward occurrence path':continue
        vs=outcomes.tracks[r['bus'],RID];ts=outcomes.track_times[r['bus'],RID]
        cursor=bisect.bisect_right(ts,r['at']);prev=None;index=r['anchorIndex']
        for v in vs[cursor:]:
            hop=ev.distance(index,v['stop_index'],n)
            if hop>5:
                failures.append(dict(population='labels',bus=r['bus'],at=v['arrived_at'],snapshotAt=r['at'],
                    target=r['target'],targetIndex=r['targetIndex'],stopsAhead=r['stopsAhead'],
                    anchorIndex=r['anchorIndex'],phaseIndex=r['index'],occurrenceReason=r['occurrenceReason'],
                    previous=slim(prev) if prev else None,next=slim(v),previousIndex=index,nextIndex=v['stop_index'],hop=hop))
                break
            prev=v;index=v['stop_index']
        else:raise AssertionError('Could not reproduce rejected path')

    transitions=collections.defaultdict(list)
    for f in failures:transitions[f['population'],f['previousIndex'],f['nextIndex']].append(f)
    summaries=[];examples=[]
    for (population,a,b),fs in sorted(transitions.items()):
        fs.sort(key=lambda f:(f['at'],f['bus'],f.get('snapshotAt',0),f.get('wait',0)))
        summaries.append(dict(population=population,fromIndex=a,toIndex=b,fromStop=seq[a],toStop=seq[b],hop=ev.distance(a,b,n),
            rows=len(fs),events=len({(f['bus'],f['next']['id']) for f in fs}),
            days=sorted({ev.date(f['at']) for f in fs}),buses=sorted({f['bus'] for f in fs})))
        f=dict(fs[0]);prev=f['previous'];nxt=f['next']
        start=(prev['arrived_at'] or prev['anchored_at']) if prev else f['snapshotAt']
        end=max(start+1,nxt['arrived_at'])
        f['start']=start;f['end']=end;f['startUtc']=utc(start);f['endUtc']=utc(end)
        f['gps']=gps(f['bus'],start,end)
        f['visitContext']=[slim(v) for v in track[f['bus']] if start-120000<=v['anchored_at']<=end+120000]
        if population=='training':
            f['sourceToFailureQuality']=quality.describe(f['bus'],RID,f['source']['departed_at'],end)
        examples.append(f)
    examples.sort(key=lambda f:(f['population'],f['at'],f['previousIndex'],f['nextIndex']))
    traces=[f for population in ('training','labels') for f in [x for x in examples if x['population']==population][:12]]
    write('failures',failures)
    (OUT/'examples.json').write_text(json.dumps(examples,indent=2)+'\n')
    (OUT/'trace-windows.json').write_text(json.dumps([dict(id=i,bus=f['bus'],start=f['start']-120000,end=f['end']+120000,
        population=f['population'],transition=[f['previousIndex'],f['nextIndex']]) for i,f in enumerate(traces)],indent=2)+'\n')
    result=dict(controls=dict(blueNightLabelsIdentical=checked,K10PathsIdentical=True,canonicalRun=35684356219,inputRun=35677536788,
        latestInputEtDay=max(ev.date(r['collected_at']) for r in raw),labelsAndThresholdsUnchanged=True),
        topology=dict(published=published['stops'],runtime=seq,equal=published['stops']==seq,repeated=len(set(seq))!=len(seq),
            stops=[dict(index=i,id=sid,name=stops[sid]['name']) for i,sid in enumerate(seq)]),
        waits=ev.WAITS[RID],labelStatus=label_status,transitions=summaries,
        frozenK10Targets=[dict(wait=w,source=(w-10)%n,target=ti,paths=len(expected.get((RID,10,w,ti),[])),
            dates=sorted({p['day'] for p in expected.get((RID,10,w,ti),[])}),status=training_status[w,ti])
            for w in ev.WAITS[RID] for ti in ev.targets(RID,w)],exampleCount=len(examples),traceCount=len(traces))
    (OUT/'summary.json').write_text(json.dumps(result,indent=2)+'\n')
    print(json.dumps(result['controls']))


if __name__=='__main__':main()
