"""Hosted, invariant-preserving diagnosis of existing canonical exclusions."""
import bisect
import collections
import datetime as dt
import gzip
import json
import math
from array import array
from pathlib import Path
import sys

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / 'canonical-windows'))
import study
rr, ev = study.rr, study.ev
OUT = HERE / 'results'
EDGE_NAMES = ('duplicate_timestamp', 'gap_over_60s', 'speed_over_22mps', 'route_change', 'provider_change')


def metres(a, b):
    return math.hypot((b['lat']-a['lat'])*111195,
        (b['lon']-a['lon'])*111195*math.cos(math.radians(a['lat'])))


def edge(a, b):
    sec = (b['collected_at']-a['collected_at'])/1000
    distance = metres(a, b)
    flags = (sec <= 0, sec > 60, distance/max(.001, sec) > 22,
             a['route_id'] != b['route_id'], a['bus_id'] != b['bus_id'])
    return sec, distance, sum(int(flag) << i for i, flag in enumerate(flags))


def distribution(xs):
    if not xs:
        return {'n': 0}
    xs = sorted(xs)
    return dict(n=len(xs), min=xs[0], p50=xs[(len(xs)-1)//2], p90=xs[int((len(xs)-1)*.9)],
                p99=xs[int((len(xs)-1)*.99)], max=xs[-1])


def write_rows(name, rows):
    with gzip.open(OUT / (name+'.jsonl.gz'), 'wt') as f:
        for row in rows:
            f.write(json.dumps(row, separators=(',', ':'))+'\n')


class DiagnosticQuality(rr.TrainingQuality):
    def __init__(self, raw):
        super().__init__(raw)
        groups = collections.defaultdict(list)
        for r in raw:
            groups[r['bus_name']].append(r)
        self.detail = {}
        self.comparisons = 0
        self.last = None
        for bus, rows in groups.items():
            rows.sort(key=lambda r: r['collected_at'])
            # Additional duplicate subtypes are annotations of an existing fail.
            names = EDGE_NAMES + ('duplicate_identical_fix', 'duplicate_conflicting_fix', 'provider_contention_same_timestamp')
            prefix = {name: array('I', [0]) for name in names}
            for a, b in zip(rows, rows[1:]):
                sec, distance, mask = edge(a, b)
                identical = all(a.get(k) == b.get(k) for k in ('bus_id','route_id','lat','lon'))
                flags = [bool(mask & (1 << i)) for i in range(len(EDGE_NAMES))]
                flags += [sec == 0 and identical, sec == 0 and not identical,
                          sec == 0 and a['bus_id'] != b['bus_id']]
                for name, flag in zip(names, flags):
                    prefix[name].append(prefix[name][-1]+int(flag))
            self.detail[bus] = rows, prefix

    def describe(self, bus, rid, start, end):
        reasons = []
        times, ids, _ = self.groups.get(bus, ([],[],[]))
        if not times:
            reasons.append('no_bus_fixes')
        if end <= start:
            reasons.append('nonpositive_window')
        edge_counts = {}
        if times and end > start:
            lo = max(0, bisect.bisect_right(times, start)-1)
            hi = min(len(times)-1, bisect.bisect_left(times, end))
            if times[lo] > start+10000:
                reasons.append('missing_start_boundary_fix')
            if times[hi] < end-10000:
                reasons.append('missing_end_boundary_fix')
            if ids[lo] != rid or ids[hi] != rid:
                reasons.append('boundary_route_mismatch')
            _, prefix = self.detail[bus]
            edge_counts = {name: p[hi]-p[lo] for name, p in prefix.items() if p[hi] != p[lo]}
            reasons += [name for name in EDGE_NAMES if edge_counts.get(name)]
        reasons = sorted(reasons)
        result = dict(ok=not reasons, reasons=reasons, edgeCounts=edge_counts)
        assert result['ok'] == super().ok(bus, rid, start, end), (bus,rid,start,end,result)
        self.comparisons += 1
        return result

    def ok(self, bus, rid, start, end):
        self.last = self.describe(bus,rid,start,end)
        return self.last['ok']


def invalid_visit(v):
    seq = ev.ROUTES[v['route_id']]['stops']; i = v['stop_index']
    reasons = []
    if not 0 <= i < len(seq) or seq[i] != v['stop_id']:
        reasons.append('invalid_occurrence')
    if v['arrived_at'] is None:
        reasons.append('missing_arrival')
    if v['outcome'] not in ('passed','stopped'):
        reasons.append('unresolved_outcome')
    if v['how'] == 'gap':
        reasons.append('visit_gap')
    if v['closest_m'] is None:
        reasons.append('missing_closest_distance')
    elif v['closest_m'] > 75:
        reasons.append('visit_over_75m')
    assert bool(reasons) == (not ev.valid(v))
    return reasons


def count_reason(cell, reason, quality=None):
    cell['status'][reason] += 1
    if quality:
        cell['qualityCombinations'][' + '.join(quality['reasons']) or 'pass'] += 1
        cell['qualityReasons'].update(quality['reasons'])
        cell['qualityEdgeCounts'].update(quality['edgeCounts'])


def path_audit(visits, quality, cutoff, expected):
    grouped = collections.defaultdict(list)
    for v in visits:
        if rr.available(v,cutoff) and v['arrived_at'] < cutoff:
            grouped[v['bus_name'],v['route_id']].append(v)
    cells = collections.defaultdict(lambda: dict(status=collections.Counter(), qualityCombinations=collections.Counter(),
        qualityReasons=collections.Counter(), qualityEdgeCounts=collections.Counter()))
    actual = collections.defaultdict(list)
    for (bus,rid), vs in grouped.items():
        vs.sort(key=lambda v:(v['anchored_at'],v['id']))
        n = len(ev.ROUTES[rid]['stops']); sources = collections.defaultdict(list)
        for w in ev.WAITS[rid]:
            for k in ev.KS:
                if k < n:
                    sources[(w-k)%n].append((k,w))
        for pos,s in enumerate(vs):
            for k,w in sources[s['stop_index']]:
                wanted = {k+ev.distance(w,t,n):t for t in ev.targets(rid,w)}
                invalid = invalid_visit(s)
                if s['departed_at'] is None or s['departed_at'] >= cutoff:
                    invalid += ['source_departure_unavailable']
                if invalid:
                    for ti in wanted.values():
                        count_reason(cells[rid,k,w,ti], 'source: '+' + '.join(invalid))
                    continue
                progress=0; previous=s['stop_index']; reached=set(); stop_reason='source_track_exhausted'
                for v in vs[pos+1:]:
                    if v['arrived_at'] is None or v['arrived_at'] <= s['departed_at']:
                        continue
                    duration=(v['arrived_at']-s['departed_at'])/1000
                    if duration > ev.MODEL_CAP:
                        stop_reason='over_model_duration_cap'; break
                    hop=ev.distance(previous,v['stop_index'],n)
                    if hop>5:
                        stop_reason='forward_occurrence_hop_over_5'; break
                    progress+=hop; previous=v['stop_index']
                    if progress > max(wanted):
                        stop_reason='passed_requested_occurrence'; break
                    if progress not in wanted or progress in reached:
                        continue
                    reached.add(progress); ti=wanted[progress]; cell=cells[rid,k,w,ti]
                    invalid=invalid_visit(v)
                    if invalid:
                        count_reason(cell,'target: '+' + '.join(invalid)); continue
                    q=quality.describe(bus,rid,s['departed_at'],v['arrived_at'])
                    if not q['ok']:
                        count_reason(cell,'quality_rejected',q); continue
                    if rid==3 and duration>2700:
                        count_reason(cell,'over_Red_45min_cap',q); continue
                    count_reason(cell,'accepted',q)
                    actual[rid,k,w,ti].append(dict(start=s['departed_at'],end=v['arrived_at'],day=ev.date(s['departed_at']),
                        duration=duration,weekend=ev.weekend(s['departed_at']),bus=bus,sourceId=s['id'],targetId=v['id']))
                for progress,ti in wanted.items():
                    if progress not in reached:
                        count_reason(cells[rid,k,w,ti],stop_reason)
    clean=lambda paths:{k:v for k,v in paths.items() if v}
    assert clean(actual)==clean(expected), 'diagnostic path enumeration changed accepted paths'
    return cells


def fit_support(model, rid,k,w,ti,departure):
    paths=model.paths.get((rid,k,w,ti),[])
    matching=[p for p in paths if p['weekend']==ev.weekend(departure)]
    weighted=[]
    for p in matching:
        diff=abs(ev.clock(p['start'])-ev.clock(departure)); diff=min(diff,1440-diff)
        weight=math.exp(-.5*(diff/120)**2)
        if weight>=1e-12:
            weighted.append((p,weight))
    total=sum(wt for _,wt in weighted)
    effective=total*total/sum(wt*wt for _,wt in weighted) if total else 0
    dates=collections.defaultdict(float)
    for p,weight in weighted:
        dates[p['day']]+=weight
    material=sum(weight>=.05*total for weight in dates.values())
    reasons=[]
    if effective<12: reasons.append('effective_paths_below_12')
    if material<3: reasons.append('material_dates_below_3')
    accepted=model.fit(rid,k,w,ti,departure) is not None
    assert accepted==(not reasons)
    return dict(route=rid,k=k,wait=w,source=(w-k)%len(ev.ROUTES[rid]['stops']),target=ti,
        targetStop=ev.ROUTES[rid]['stops'][ti],departure=departure,weekend=ev.weekend(departure),
        rawPaths=len(paths),rawSources=len({p['sourceId'] for p in paths}),rawDates=sorted({p['day'] for p in paths}),
        weekdayMatchingPaths=len(matching),weekdayMatchingSources=len({p['sourceId'] for p in matching}),
        weekdayMatchingDates=sorted({p['day'] for p in matching}),weightedPaths=len(weighted),
        weightedSources=len({p['sourceId'] for p,_ in weighted}),effective=effective,materialDates=material,
        dateWeightShares={d:weight/total for d,weight in dates.items()} if total else {},
        accepted=accepted,reasons=reasons)


def speed_edges(raw):
    grouped=collections.defaultdict(list)
    for r in raw: grouped[r['bus_name']].append(r)
    for bus, rows in grouped.items():
        rows.sort(key=lambda r:r['collected_at'])
        for i,(a,b) in enumerate(zip(rows,rows[1:])):
            seconds,distance,mask=edge(a,b)
            if not mask & 4: continue
            previous=edge(rows[i-1],a) if i else None
            following=edge(b,rows[i+2]) if i+2<len(rows) else None
            yield dict(bus=bus,start=a['collected_at'],end=b['collected_at'],
                startUtc=dt.datetime.fromtimestamp(a['collected_at']/1000,dt.timezone.utc).isoformat(),
                endUtc=dt.datetime.fromtimestamp(b['collected_at']/1000,dt.timezone.utc).isoformat(),
                routes=[a['route_id'],b['route_id']],providers=[a['bus_id'],b['bus_id']],
                seconds=seconds,distanceM=distance,speedMps=distance/max(.001,seconds),
                conditions=[name for j,name in enumerate(EDGE_NAMES) if mask & (1<<j)],
                previousSeconds=previous[0] if previous else None,
                previousDistanceM=previous[1] if previous else None,
                previousSpeedMps=previous[1]/max(.001,previous[0]) if previous else None,
                nextSeconds=following[0] if following else None,
                nextDistanceM=following[1] if following else None,
                nextSpeedMps=following[1]/max(.001,following[0]) if following else None,
                nextFixDistanceFromStartM=metres(a,rows[i+2]) if following else None)


def main():
    OUT.mkdir(exist_ok=True); study.configure()
    raw=ev.read(ev.IN/'raw_positions.jsonl.gz')
    visits=ev.read(study.OUT/'training-visits.jsonl.gz')
    rows=ev.read(study.OUT/'unscored.jsonl.gz')
    expected={study.key(r):r['label'] for r in ev.read(study.OUT/'forecasts.jsonl.gz')}
    summary=dict(contract='Diagnostic only; exact prior cohorts, paths, fits and forecasts retained',
        controls={},labels={},training={},supportQueries={},highSpeed={},unsupportedRoutes={})
    quality=DiagnosticQuality(raw); outcomes=study.Outcomes(visits,quality)
    labels=collections.defaultdict(lambda:dict(outcomes=collections.Counter(),qualityReasons=collections.Counter(),
        qualityCombinations=collections.Counter(),qualityEdgeCounts=collections.Counter()))
    for r in rows:
        quality.last=None
        label,reason=outcomes.label(r)
        assert label==expected.get(study.key(r)), (study.key(r),reason,'label cohort changed')
        cell=labels[r['route']]; cell['outcomes'][reason or 'accepted']+=1
        if quality.last:
            q=quality.last
            cell['qualityCombinations'][' + '.join(q['reasons']) or 'pass']+=1
            cell['qualityReasons'].update(q['reasons']); cell['qualityEdgeCounts'].update(q['edgeCounts'])
    summary['labels']=labels
    summary['controls']['labelsIdentical']=len(rows)
    summary['controls']['labelQualityComparisons']=quality.comparisons
    del quality,outcomes
    speeds=list(speed_edges(raw)); write_rows('high-speed-edges',speeds)
    for rid in ev.ROUTES:
        es=[e for e in speeds if rid in e['routes']]
        stable=[e for e in es if e['routes'][0]==e['routes'][1] and e['providers'][0]==e['providers'][1] and e['seconds']>0]
        summary['highSpeed'][rid]=dict(edges=len(es),stableIdentityPositiveTimeEdges=len(stable),
            conditions=dict(collections.Counter(' + '.join(e['conditions']) for e in es)),
            gapSeconds=distribution([e['seconds'] for e in es]),distanceM=distribution([e['distanceM'] for e in es]),
            speedMps=distribution([e['speedMps'] for e in es]),
            stableIdentitySpeedMps=distribution([e['speedMps'] for e in stable]),
            stableIdentityGapSeconds=distribution([e['seconds'] for e in stable]),
            stableIdentityDistanceM=distribution([e['distanceM'] for e in stable]),
            stableByBus=dict(collections.Counter(e['bus'] for e in stable)),
            returnWithin30mNextFix=sum(e['nextFixDistanceFromStartM'] is not None and e['nextFixDistanceFromStartM']<=30 for e in stable),
            adjacentBothOver22=sum((e['previousSpeedMps'] or 0)>22 and (e['nextSpeedMps'] or 0)>22 for e in stable))
    del speeds
    cutoffs=sorted({study.FROZEN}|{rr.cutoff_for(ev.date(r['at'])) for r in rows})
    query_rows=[]; group_rows=[]; prediction_checks=0; quality_checks=0
    for cutoff in cutoffs:
        ev.CUTOFF=cutoff
        admitted=[v for v in visits if rr.available(v,cutoff)]
        quality=DiagnosticQuality([r for r in raw if r['collected_at']<cutoff])
        model=study.Models(admitted,quality)
        for cell,paths in model.paths.items():
            if cell[0]==3: model.paths[cell]=[p for p in paths if p['duration']<=2700]
        cells=path_audit(visits,quality,cutoff,model.paths)
        records=[]
        for rid in ev.ROUTES:
            n=len(ev.ROUTES[rid]['stops'])
            for k in ev.KS:
                for w in ev.WAITS[rid]:
                    if k>=n: continue
                    for ti in ev.targets(rid,w):
                        paths=model.paths.get((rid,k,w,ti),[])
                        records.append(dict(route=rid,k=k,wait=w,source=(w-k)%n,target=ti,
                            targetStop=ev.ROUTES[rid]['stops'][ti],paths=len(paths),
                            sources=len({p['sourceId'] for p in paths}),dates=sorted({p['day'] for p in paths}),
                            **cells[rid,k,w,ti]))
        cutoff_routes={rid:collections.Counter() for rid in ev.ROUTES}
        for v in visits:
            if v['known_at'] is not None and v['known_at']>=cutoff:
                cutoff_routes[v['route_id']]['not_known_before_cutoff']+=1
            elif rr.available(v,cutoff): cutoff_routes[v['route_id']]['admitted']+=1
            else: cutoff_routes[v['route_id']]['invalid_completion_or_known_time']+=1
        summary['training'][str(cutoff)]=dict(cells=records,visitAvailability=cutoff_routes,
            acceptedPaths=sum(len(ps) for ps in model.paths.values()))
        seen_queries={}; seen_groups={}; gates=collections.defaultdict(collections.Counter)
        for r in rows:
            modes=[]
            if cutoff==study.FROZEN: modes.append('frozen')
            if cutoff==rr.cutoff_for(ev.date(r['at'])): modes.append('rolling')
            if not modes: continue
            for mode in modes:
                for k in ev.KS:
                    arm=f'{mode}_K{k}'
                    result=model.predict(dict(r,baseline=r['deployed']),f'K{k}')
                    forecast=result['forecast']
                    if result['changed']: forecast={f:math.floor(v+.5) for f,v in forecast.items()}
                    evidence={key:value for key,value in result.items() if key!='forecast'}
                    assert forecast==r['candidates'][arm] and evidence==r['candidateEvidence'][arm], (study.key(r),arm)
                    prediction_checks+=1; gates[r['route'],arm][result['reason']]+=1
                    if result['reason'] not in ('checkpoint','group lacks historical support','group countdown expired'):
                        continue
                    rid=r['route']; w=ev.previous_wait(rid,r['targetIndex']); source=(w-k)%len(ev.ROUTES[rid]['stops'])
                    departure=r['origins'][str(source)]['departed']
                    gkey=(rid,k,w,departure)
                    if gkey not in seen_groups:
                        blockers=[]; expired=[]
                        for ti in ev.targets(rid,w):
                            qkey=(rid,k,w,ti,departure)
                            q=fit_support(model,rid,k,w,ti,departure); seen_queries[qkey]=q
                            if not q['accepted']: blockers.append(ti)
                            f=model.fit(rid,k,w,ti,departure)
                            if f and f['eta']-(r['at']-departure)/1000<=60: expired.append(ti)
                        seen_groups[gkey]=dict(route=rid,k=k,wait=w,source=source,departure=departure,
                            blockedTargets=blockers,firstObservedExpiredTargets=expired,observedSnapshots=0)
                    seen_groups[gkey]['observedSnapshots']+=1
        query_rows.extend(dict(cutoff=cutoff,**q) for q in seen_queries.values())
        group_rows.extend(dict(cutoff=cutoff,**g) for g in seen_groups.values())
        summary['supportQueries'][str(cutoff)]=dict(contexts=len(seen_queries),groups=len(seen_groups),
            predictionGates={f'{rid}/{arm}':dict(counts) for (rid,arm),counts in gates.items()})
        quality_checks+=quality.comparisons
        del model,quality
    write_rows('fit-support-contexts',query_rows); write_rows('whole-group-contexts',group_rows)
    for rid in (4,9,10,13,18):
        summary['unsupportedRoutes'][rid]=dict(name=ev.ROUTES[rid]['name'],waits=ev.WAITS[rid],
            waitClassification=[s for s in json.loads((study.OUT/'preparation.json').read_text())['waitStats'] if s['route']==rid],
            cells=[dict(cutoff=cutoff,**cell) for cutoff,record in summary['training'].items() for cell in record['cells'] if cell['route']==rid],
            contexts=[q for q in query_rows if q['route']==rid],groups=[g for g in group_rows if g['route']==rid])
    summary['controls'].update(predictionsIdentical=prediction_checks,trainingQualityComparisons=quality_checks,
        exactTrainingPathCutoffs=cutoffs,sourceCanonicalRun=35684356219,thresholdsUnchanged=True)
    (OUT/'summary.json').write_text(json.dumps(summary,indent=2))
    print(json.dumps(summary['controls']))


if __name__=='__main__': main()
