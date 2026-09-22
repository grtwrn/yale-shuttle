"""Classify each fixed arm's matched handoffs with raw continuity evidence."""
import bisect
import collections
import json
from study import HERE, OUT, CANONICAL, ARMS, read, write, key, module, split

audit=module('prior_brown_handoff',HERE.parent/'brown-handoffs/audit.py')


def main():
    labels={key(r):r['label'] for r in read(OUT/'forecasts.jsonl.gz')}
    rows=[dict(r,label=labels.get(key(r))) for r in read(OUT/'unscored.jsonl.gz')]
    groups=collections.defaultdict(list)
    for r in rows:groups[r['bus'],r['target']].append(r)
    visits=collections.defaultdict(list)
    for v in read(CANONICAL/'training-visits.jsonl.gz'):
        if v['route_id']==19:visits[v['bus_name']].append(v)
    for vs in visits.values():vs.sort(key=lambda v:v['known_at'])
    times={b:[v['known_at'] for v in vs] for b,vs in visits.items()}
    connectivity=audit.risk.Connectivity(HERE.parent/'k-sweep/results/raw_positions.jsonl.gz',{r['bus'] for r in rows})
    expected=json.loads((OUT/'summary.json').read_text())
    records=[];summary={}
    for arm in ARMS:
        lead,cell=split(arm);horizon=int(cell.split('_')[0][1:])*60;freshness=int(cell.split('_')[1][1:])
        skipped=collections.Counter();old_records=[]
        for (bus,target),rs in groups.items():
            rs.sort(key=lambda r:r['at'])
            for a,b in zip(rs,rs[1:]):
                ae,be=a['candidateEvidence'][arm],b['candidateEvidence'][arm]
                if not (ae['changed'] or be['changed']):continue
                if ae['changed']!=be['changed']:
                    transition='candidate-to-fallback' if ae['changed'] else 'fallback-to-candidate'
                elif any(ae.get(k)!=be.get(k) for k in ('source','origin','wait')):transition='new-source-or-wait'
                elif arm.startswith('rolling_') and audit.risk.day(a['at'])!=audit.risk.day(b['at']):transition='daily-refit'
                else:continue
                if not a['label'] or not b['label']:skipped['unlabelledTransitions']+=1;continue
                if a['label']['id']!=b['label']['id']:skipped['differentPickupOccurrenceTransitions']+=1;continue
                if not 0<b['at']-a['at']<=30000:skipped['unobservedGapTransitions']+=1;continue
                assert a['label']==b['label']
                # Feed the unchanged classifier the correct arm-local causal fields.
                aa=dict(a,**a['clockFeatures'][cell]);bb=dict(b,**b['clockFeatures'][cell])
                for r in (aa,bb):
                    for field in ('candidates','underlyingCandidates','candidateEvidence'):
                        r[field]=dict(r[field],**{lead:r[field][arm]})
                emitted=visits.get(bus,[])[bisect.bisect_right(times.get(bus,[]),a['asof']):bisect.bisect_right(times.get(bus,[]),b['asof'])]
                cause,detail,flags=audit.classify(aa,bb,lead,9,emitted)
                fallback=bb if not be['changed'] else aa
                reason=fallback['candidateEvidence'][lead]['reason']
                if reason=='not warm/fresh':
                    age=(fallback['asof']-fallback['observedAt'])/1000
                    stale=age>15 if freshness==15 else age>=45
                    if stale:detail=f'actual observation exceeds {freshness}s contract (strict at45s)'
                if reason=='source departure unavailable':
                    origin=(be if be['changed'] else ae)['origin']
                    if (fallback['at']-origin)/1000>horizon:
                        cause='source-age expiry';detail=f'causal origin exceeds fixed{horizon/60:g}-minute horizon'
                clocks=audit.clock_comparison(a,b,arm)
                old_records.append(dict(bus=bus,at=b['at'],target=target,transition=transition,reason=be['reason'],
                    arrivalClockJump={k:v['absoluteJumpSec'] for k,v in clocks.items()},
                    deployedArrivalClockJump={k:v['deployedAbsoluteJumpSec'] for k,v in clocks.items()}))
                records.append(dict(arm=arm,bus=bus,target=target,at=b['at'],atET=audit.local(b['at']),
                    label=b['label'],transition=transition,cause=cause,detail=detail,flags=flags,clocks=clocks,
                    before=audit.snapshot(aa,lead),after=audit.snapshot(bb,lead),causalEmissions=emitted,
                    gpsBetween=audit.gps_audit(connectivity,bus,a['at'],b['at']),
                    gpsThroughDeparture=audit.gps_audit(connectivity,bus,a['at'],b['label']['departure']),
                    maxIntroducedBoundJumpSec=max(abs(clocks[k]['introducedJumpSec']) for k in ('low','high'))))
        prior=expected['armsDetail'][arm]['handoffs']
        assert old_records==prior['records']
        for k in ('unlabelledTransitions','differentPickupOccurrenceTransitions','unobservedGapTransitions'):assert skipped[k]==prior[k]
        own=sorted([r for r in records if r['arm']==arm],key=lambda r:(r['at'],r['bus'],r['target']))
        causes={}
        for cause in sorted({r['cause'] for r in own}):
            rs=[r for r in own if r['cause']==cause]
            causes[cause]=dict(count=len(rs),first=rs[0],largest=min(rs,key=lambda r:(-r['maxIntroducedBoundJumpSec'],r['at'])))
        summary[arm]=dict(observed=len(own),excluded=dict(skipped),causes=causes,
            gpsBetweenContinuous=sum(r['gpsBetween']['continuous'] for r in own),
            gpsThroughDepartureContinuous=sum(r['gpsThroughDeparture']['continuous'] for r in own))
    write('handoff-records',sorted(records,key=lambda r:(r['at'],r['arm'],r['bus'],r['target'])))
    (OUT/'handoff-audit.json').write_text(json.dumps(summary,indent=2)+'\n')
    print(json.dumps({a:{'observed':v['observed'],'causes':{k:x['count'] for k,x in v['causes'].items()}} for a,v in summary.items()}))


if __name__=='__main__':main()
