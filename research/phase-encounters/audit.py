"""Fixed-cohort physical ambiguity ledger, not model evaluation or new labels."""
import collections
import datetime as dt
import gzip
import json
from pathlib import Path
HERE=Path(__file__).resolve().parent;OUT=HERE/'results';PHASE=HERE.parent/'phase-frozen';OLD=HERE.parent/'directed-leg-diagnostics/results'
def read(path):
    with gzip.open(path,'rt') as f:return [json.loads(line) for line in f if line.strip()]
def write(name,rows):
    with gzip.open(OUT/(name+'.jsonl.gz'),'wt') as f:
        for row in rows:f.write(json.dumps(row,separators=(',',':'))+'\n')
def key(r):return (r['at'],r['bus'],r['route'],r['target'])
episodes=read(OUT/'episodes.jsonl.gz');by_marker=collections.defaultdict(list)
for e in episodes:by_marker[(e['bus'],e['marker'])].append(e)
for group in by_marker.values():group.sort(key=lambda e:e['enteredAt'])
labels=read(PHASE/'label-comparison.jsonl.gz');forecasts=read(HERE.parent/'canonical-windows/results/unscored.jsonl.gz')
assert len(labels)==len(forecasts)==38047
asofs={key(r):r['asof'] for r in forecasts};assert len(asofs)==len(forecasts)
proposed={v['id']:v for v in read(PHASE/'protected-visits.jsonl.gz')}
old_barriers=read(OLD/'earlier-pickup-barriers.jsonl.gz');old_keys={key(r) for r in old_barriers};assert len(old_keys)==32
def same_identity(e,v):return e['provider']==v['bus_id'] and e['route']==v['route_id']
def matched(v,strict=True):
    if v['arrived_at'] is None:return []
    return [e for e in by_marker[(v['bus_name'],v['stop_id'])] if same_identity(e,v) and (
        e['enteredAt']<=v['arrived_at']<=e['lastObservedAt'] if strict else
        max(e['enteredAt'],v['anchored_at'])<=min(e['lastObservedAt'],v['known_at']))]
def end(e):return e['exitAt'] if e['exitAt'] is not None else e['absenceWitnessAt'] if e['absenceWitnessAt'] is not None else float('inf')
def barrier(e,asof):return dict(episodeId=e['episodeId'],reason=('censored_without_exit' if e['censorKnownAt'] is not None and e['censorKnownAt']<=asof else 'open_at_asof') if e['enteredAt']<=asof else 'earlier_encounter',entryKnownByAsOf=e['enteredAt']<=asof,
    stationaryKnownByAsOf=e['stationaryNearKnownAt'] is not None and e['stationaryNearKnownAt']<=asof)
rows=[];counts=collections.Counter();route_counts=collections.defaultdict(collections.Counter);known_pairs={}
for r in labels:
    asof=asofs[key(r)];v=proposed.get(r['protected']['id']) if r['protected'] else None
    targets=matched(v) if v else [];target_ids=[e['episodeId'] for e in targets]
    reason='no_proposed_label' if v is None else 'unique_target_encounter' if len(targets)==1 else 'missing_target_encounter' if not targets else 'ambiguous_target_encounter'
    arrival=v['arrived_at'] if v else None
    barriers=[barrier(e,asof) for e in by_marker[(r['bus'],r['target'])] if e['enteredAt']<=(arrival if arrival is not None else asof) and end(e)>asof and
        (e['enteredAt']<=asof or e['episodeId'] not in target_ids)]
    known=key(r) in old_keys
    if known:
        old=r['earlierBaselinePhysicalPickup'];old_matches=matched(old,False)
        assert old_matches,(key(r),'Earlier physical pickup absent from independent ledger')
        retained={b['episodeId'] for b in barriers}&{e['episodeId'] for e in old_matches}
        assert retained,(key(r),'Earlier physical encounter incorrectly cleared')
        known_pairs[old['id']]=dict(baseline=old,episodes=[e for e in old_matches],retainedEpisodeIds=sorted(retained))
    row=dict(forecastKey=list(key(r)),asof=asof,originalLabel=r['baseline'],proposedLabel=r['protected'],originalStatus=r['status'],targetEpisodeIds=target_ids,
        barriers=barriers,associationReason=reason,knownBarrierPreserved=known,
        sensitivityStatus='no_proposed_label' if v is None else 'unresolved_physical_barrier' if barriers or known else 'unresolved_target_association' if len(targets)!=1 else 'no_earlier_encounter_identified')
    # A sensitivity status never overwrites or promotes the frozen label.
    rows.append(row)
    for c in [counts,route_counts[r['route']]]:
        c['rows']+=1;c['association/'+reason]+=1;c['status/'+row['sensitivityStatus']]+=1;c['original/'+r['status']]+=1
        if barriers:c['with_any_barrier']+=1;c['with_barrier/original_'+r['status']]+=1
        if known:c['known_barriers_preserved']+=1
        for reason_code in {b['reason'] for b in barriers}:c['rows_with_reason/'+reason_code]+=1
assert counts['known_barriers_preserved']==32 and len(known_pairs)==2
for pair in known_pairs.values():
    near=[e for e in pair['episodes'] if e['episodeId'] in pair['retainedEpisodeIds']]
    if pair['baseline']['bus_name']=='#45':assert max(e['maxNearPlateauMs'] for e in near)>=60007
    if pair['baseline']['bus_name']=='#38':assert any(e['movementFixes'] and e['nearPolls']>=3 for e in near)
write('forecast-barriers',rows);write('known-barrier-physical-pairs',list(known_pairs.values()))
physical=read(OLD/'physical-visit-differences.jsonl.gz');audited=[];physical_counts=collections.defaultdict(collections.Counter)
for row in physical:
    visits=[('baseline',row['baseline']),('guarded',row['protected'])] if row['status']=='paired_physical_change' else [(row['status'],row['visit'])]
    details=[]
    for arm,v in visits:
        strict=matched(v);window=matched(v,False)
        details.append(dict(arm=arm,visit=v,arrivalEpisodeIds=[e['episodeId'] for e in strict],windowEpisodeIds=[e['episodeId'] for e in window],
            windowEvidence=dict(collections.Counter(e['evidence'] for e in window)),windowMaximumNearPlateauMs=max((e['maxNearPlateauMs'] for e in window),default=None),
            windowMinimumMetres=min((e['minimumMetres'] for e in window),default=None)))
        if v['arrived_at'] is not None:
            c=physical_counts[str(row['route'])+'/'+row['status']+'/'+arm+'/'+v['outcome']];c['visits']+=1
            c['unique_arrival_match' if len(strict)==1 else 'multiple_arrival_matches' if strict else 'no_arrival_match']+=1
            c['window_match' if window else 'no_window_match']+=1
            for evidence in {e['evidence'] for e in window}:c['with_'+evidence]+=1
    audited.append(dict(originalDifference=row,encounters=details))
assert sum(r['status']=='suppressed' and r['route']==13 and r['visit']['arrived_at'] is not None and r['visit']['outcome']=='stopped' for r in physical)==98
assert sum(r['status']=='suppressed' and r['route']==13 and r['visit']['arrived_at'] is not None and r['visit']['outcome']=='passed' for r in physical)==136
assert sum(r['status']=='paired_physical_change' and r['route']==13 for r in physical)==63
assert sum(r['status']=='paired_physical_change' and r['route']==10 for r in physical)==3
assert sum(r['status']=='new' and r['route']==9 and r['visit']['arrived_at'] is not None for r in physical)==1
write('physical-difference-encounters',audited)
dimensions=collections.defaultdict(lambda:collections.defaultdict(collections.Counter))
from zoneinfo import ZoneInfo
for e in episodes:
    day=dt.datetime.fromtimestamp(e['enteredAt']/1000,ZoneInfo('America/New_York')).date().isoformat()
    for name,value in [('route',e['route']),('marker',e['marker']),('day',day),('bus',e['bus']),('segment',json.dumps([e['bus'],e['provider'],e['route'],e['segmentStartedAt']],separators=(',',':')))]:
        c=dimensions[name][str(value)];c['episodes']+=1;c['status/'+e['status']]+=1;c['evidence/'+e['evidence']]+=1
        if e['censorReason']:c['censor/'+e['censorReason']]+=1
        if e['status']=='censored' and e['absenceWitnessAt'] is None:c['unwitnessed_censor']+=1
        if e['contended']:c['contended']+=1
        if e['polls']==1:c['one_fix']+=1
write('episode-groups',[dict(dimension=d,key=k,counts=dict(v)) for d,groups in dimensions.items() for k,v in groups.items()])
summary=dict(episodes=len(episodes),forecastCounts=dict(counts),forecastByRoute={k:dict(v) for k,v in route_counts.items()},
    physicalDifferenceCounts={k:dict(v) for k,v in physical_counts.items()},episodesByRoute={k:dict(v) for k,v in dimensions['route'].items()},
    knownBarrierRowsPreserved=32,knownPhysicalPairs=2,scoringPerformed=False,labelsModified=False,
    interpretation='Possible physical presence and descriptive raw-coordinate plateaus; neither direction nor geometry establishes boarding or non-service.')
(OUT/'audit-summary.json').write_text(json.dumps(summary,indent=2)+'\n');print(json.dumps(dict(episodes=len(episodes),forecasts=len(rows),knownBarriersPreserved=32,physicalDifferences=len(audited))))
