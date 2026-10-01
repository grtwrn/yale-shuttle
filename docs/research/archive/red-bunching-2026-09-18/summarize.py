"""All frozen-arm comparisons and regression provenance; no fitting or selection."""
import collections, json, math, sqlite3
from pathlib import Path
import screen as s

OUT=s.OUT;ROOT=s.ROOT
allrows=[]
for filename,label in [('predictions.jsonl','reused'),('extension-predictions.jsonl','fresh_afternoon')]:
    for line in (OUT/filename).read_text().splitlines():
        r=json.loads(line);r['dataset']=label;allrows.append(r)
rows=[r for r in allrows if r['split']=='development']
runtime=json.loads((OUT/'runtime-comparator.json').read_text())
runtime_index={(r['id'],r['elapsed']):r for r in runtime['forecasts']}
for r in rows:
    rt=runtime_index[r['id'],r['elapsed']]
    r['predictions']['runtime_component']=dict(q=rt['q'],p120=rt['p120'])
arms=[*s.ARMS,'runtime_component']
scores=[]
for dataset in ['reused','fresh_afternoon']:
    for item in s.score([r for r in rows if r['dataset']==dataset],arms):
        scores.append(dict(dataset=dataset,**item))
(OUT/'scores-with-runtime.json').write_text(json.dumps(scores,indent=2)+'\n')

def point(r,arm):
    q=r['predictions'][arm]['q'];y=r['truthRemaining'];lo,med,hi=q[1],q[3],q[5]
    return dict(low=lo,median=med,high=hi,width=hi-lo,absoluteError=abs(med-y),
        wis80=(.5*abs(med-y)+.1*(hi-lo)+max(0,lo-y)+max(0,y-hi))/1.5,
        earlyShortfall=max(0,lo-y),lateShortfall=max(0,y-hi))

crossings=[];visitrows=[]
for r in rows:
    base=point(r,s.ARMS[0])
    for arm in s.ARMS[1:]:
        cand=point(r,arm)
        for direction in ['early','late']:
            key=direction+'Shortfall'
            if (base[key]>0)!=(cand[key]>0):
                crossings.append(dict(dataset=r['dataset'],delay=r['delay'],id=r['id'],bus=r['bus'],day=r['day'],
                    elapsed=r['elapsed'],truthRemaining=r['truthRemaining'],arm=arm,direction=direction,
                    change='added' if cand[key]>0 else 'removed',base=base,candidate=cand,
                    gateActive=r['gateActive'],snapshot=r['snapshot']))
groups=collections.defaultdict(list)
for r in rows:groups[r['dataset'],r['delay'],r['id']].append(r)
for (dataset,delay,id),rr in groups.items():
    for arm in s.ARMS[1:]:
        b=[point(r,s.ARMS[0]) for r in rr];c=[point(r,arm) for r in rr]
        avg=lambda ps,key:sum(p[key] for p in ps)/len(ps)
        visitrows.append(dict(dataset=dataset,delay=delay,id=id,bus=rr[0]['bus'],day=rr[0]['day'],arm=arm,
            origins=len(rr),gatedOrigins=sum(r['gateActive'] for r in rr),
            wisDelta=avg(c,'wis80')-avg(b,'wis80'),maeDelta=avg(c,'absoluteError')-avg(b,'absoluteError'),
            widthDelta=avg(c,'width')-avg(b,'width'),
            checkpoints=[dict(elapsed=r['elapsed'],truthRemaining=r['truthRemaining'],base=bb,candidate=cc,
                gateActive=r['gateActive'],snapshot=r['snapshot']) for r,bb,cc in zip(rr,b,c)]))
visitrows.sort(key=lambda r:r['wisDelta'],reverse=True)
(OUT/'all-bound-crossings.json').write_text(json.dumps(crossings,indent=2)+'\n')
(OUT/'all-visit-comparisons.json').write_text(json.dumps(visitrows,indent=2)+'\n')

# Audit source validity independently of whether a residual is favorable. Include every
# new boundary-miss visit, largest primary WIS regressions per arm, and known early holds.
auditids={r['id'] for r in crossings if r['change']=='added'}|{64318,65347}
for arm in s.ARMS[1:]:
    top=[r for r in visitrows if r['arm']==arm and r['delay']==15 and r['wisDelta']>0][:5]
    auditids.update(r['id'] for r in top)
db=sqlite3.connect('file:'+str(ROOT/'release-integration-data/outcomes-complete.db')+'?mode=ro',uri=True);db.row_factory=sqlite3.Row
visits={v['id']:dict(v) for v in db.execute('select * from stop_visits')};db.close()
for name in ['red-early-covariates-2026-09-18/recordings-followup.json','red-rest-history-2026-09-18/recordings.json','red-bunching-data-2026-09-18/recordings.json']:
    cap=json.loads((ROOT/name).read_text())
    visits.update({v['id']:v for v in cap['stop_visits']})
raw=cap['raw_positions'];rawbus=collections.defaultdict(list)
for p in raw:rawbus[p['bus_name']].append(p)
for vs in rawbus.values():vs.sort(key=lambda p:p['collected_at'])
audits=[]
for id in sorted(auditids):
    v=visits[id];a=v['pinned_at'];d=v['departed_at']
    points=[p for p in rawbus[v['bus_name']] if a<=p['collected_at']<=d+15000]
    before=[p for p in points if p['collected_at']<=d]
    longest=0;start=previous=None
    for p in before:
        if previous is None or (previous['lat'],previous['lon'])!=(p['lat'],p['lon']):start=p['collected_at']
        longest=max(longest,(p['collected_at']-start)/1000);previous=p
    gaps=[(q['collected_at']-p['collected_at'])/1000 for p,q in zip(before,before[1:])]
    record=dict(id=id,bus=v['bus_name'],day=s.day(a),visit=v,
        focalHoldSec=(d-a)/1000,rawFixes=len(before),maxRawGapSec=max(gaps,default=None),
        longestExactCoordinatePlateauSec=longest if before else None,
        rawProviderBusIds=sorted({p['bus_id'] for p in points}),rawRouteIds=sorted({p['route_id'] for p in points}),
        sourceEligible=v['outcome']=='stopped' and v['how']!='gap' and v['closest_m']<=75 and d>=a,
        interpretation='No demonstrated measurement-error exclusion. Source stopped/non-gap outcome retained. Raw statistics are descriptive only; absent raw cannot establish validity or corruption.')
    assert record['sourceEligible']
    audits.append(record)
(OUT/'regression-source-audit.json').write_text(json.dumps(audits,indent=2)+'\n')

head=[]
for r in scores:
    if r['delay']==15 and r['period'] in ['Sep14_17','Sep18'] and r['group'] in ['all','supported_gate'] and r['weighting'] in ['checkpoint','visit']:
        head.append(r)
summary=dict(verdict='Do not integrate or force narrower forecasts. Close-leader subgroup gain on reused Sep14–17 reverses on reused Sep18; only one fresh gated hold. Compact spacing is inconsistent and timing-sensitive. No supported follower/co-anchor learned correction.',
    headline=head,regressionCrossingCounts=[dict(dataset=dataset,delay=delay,arm=arm,direction=direction,change=change,
        checkpoints=len(rr),visits=len({r['id'] for r in rr}),ids=sorted({r['id'] for r in rr}))
        for (dataset,delay,arm,direction,change),rr in ((k,[r for r in crossings if (r['dataset'],r['delay'],r['arm'],r['direction'],r['change'])==k])
        for k in sorted({(r['dataset'],r['delay'],r['arm'],r['direction'],r['change']) for r in crossings}))],
    topPrimaryRegressions=[{k:v for k,v in r.items() if k!='checkpoints'} for arm in s.ARMS[1:] for r in [v for v in visitrows if v['arm']==arm and v['delay']==15 and v['wisDelta']>0][:5]],
    noOutcomeExclusions=True,validFocalVisitsRetained=138,measurementAuditIds=sorted(auditids))
(OUT/'summary.json').write_text(json.dumps(summary,indent=2)+'\n')
print(json.dumps({k:v for k,v in summary.items() if k!='headline'},indent=2))
for r in head:
    print(json.dumps({**r,'arms':{a:{k:v[k] for k in ['visits','landmarks','mae','wis80','width80','earlyCount','lateCount']} for a,v in r['arms'].items()}}))
