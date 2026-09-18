"""Score frozen selected current-code traces against isolated exact labels."""
import bisect
import collections
import hashlib
import json
import math
import statistics
from pathlib import Path

OUT = Path('/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/cycle-2')
outcomes = json.loads((OUT/'trace-outcomes.json').read_text())
manifest = json.loads((OUT/'case-manifest.json').read_text())
traces = [json.loads(line) for line in (OUT/'current-trace.jsonl').open()]
by_bus = collections.defaultdict(list)
by_exact = {}
for r in traces:
    assert (r['bus'], r['at']) not in by_exact
    by_bus[r['bus']].append(r)
    by_exact[r['bus'], r['at']] = r
    for f in r['forecasts']:
        assert all(math.isfinite(f[k]) for k in ['eta', 'low', 'high'])
        assert 0 <= f['low'] <= f['eta'] <= f['high']
        assert len(f['distribution']) == 50
        assert all(a <= b for a,b in zip(f['distribution'],f['distribution'][1:]))
times = {bus:[r['at'] for r in rs] for bus,rs in by_bus.items()}

def frame(bus, at):
    i = bisect.bisect_left(times[bus], at)
    if i == len(times[bus]) or times[bus][i] > at+15000: return None, 'no observed frame within 15 sec'
    r = by_bus[bus][i]
    if r['warmMs'] < 600000: return None, 'less than 600 sec observed warmup'
    if r['observedAt'] is None or r['at']-r['observedAt'] >= 45000: return None, 'missing/stale observation'
    return r, None

def forecast(r, target, occurrence):
    fs = [f for f in r['forecasts'] if f['target'] == target and
          (0 < f['stopsAhead'] < 29 if occurrence == 0 else 29 < f['stopsAhead'] < 58)]
    assert len(fs) <= 1
    return fs[0] if fs else None

checks, missing, evolution = [], [], []
for c in outcomes['cases']:
    s = c['source']
    clocks = [('standing', e, s['pinned_at']+1000*e) for e in [0,60,180,300] if s['pinned_at']+1000*e<s['departed_at']]
    clocks += [('departure',e,s['departed_at']+1000*e) for e in [0,15,60]]
    for ep in c['endpoints']:
        first = next(e for e in c['endpoints'] if e['target']==ep['target'] and e['occurrence']==0)
        meta = dict(sourceId=c['sourceId'],sourceStop=c['sourceStop'],target=ep['target'],occurrence=ep['occurrence'],targetVisitId=ep['outcome']['id'],targetOutcome=ep['outcome']['outcome'])
        for phase, elapsed, at in clocks:
            if at >= first['outcome']['arrived_at']: continue
            r, error = frame(s['bus_name'], at)
            rec = dict(meta, phase=phase, checkpointSec=elapsed, requestedAt=at)
            if error: missing.append(dict(rec,reason=error));continue
            if r['at'] >= first['outcome']['arrived_at'] or (phase=='standing' and r['at']>=s['departed_at']):
                missing.append(dict(rec,reason='observed frame past phase endpoint'));continue
            f = forecast(r, ep['target'],ep['occurrence'])
            if f is None:
                missing.append(dict(rec,reason='forecast absent or h=29/58 ambiguous',at=r['at']));continue
            truth = (ep['outcome']['arrived_at']-r['at'])/1000
            checks.append(dict(rec,at=r['at'],warmMs=r['warmMs'],truthSec=truth,current=f,
                               errorPredictedMinusActual=f['eta']-truth,state=r['state']))
        if ep['occurrence'] or c['sourceStop']!=121: continue
        # Fixed observed milestones; outcome clocks choose evaluation times only.
        first_path = next(e['path'] for e in c['endpoints'] if e['target']==4 and e['occurrence']==0)
        milestone_list = [('source departure +60',s['departed_at']+60000,121,s['id'])]
        for p in first_path:
            v=p['visit']
            if v['departed_at'] is not None:
                milestone_list.append(('intermediate departure +5',v['departed_at']+5000,v['stop_id'],v['id']))
        for label,at,stop,visit in milestone_list:
            if at>=ep['outcome']['arrived_at']:continue
            r,err=frame(s['bus_name'],at)
            if err or r['at']>=ep['outcome']['arrived_at']:continue
            f=forecast(r,ep['target'],0)
            if f is None:continue
            truth=(ep['outcome']['arrived_at']-r['at'])/1000
            evolution.append(dict(meta,label=label,at=r['at'],milestoneStop=stop,milestoneVisit=visit,
                truthSec=truth,current={k:f[k] for k in ['eta','low','high','departNow','stopsAhead']},
                errorPredictedMinusActual=f['eta']-truth,state=r['state'],observation=r['observation']))

# Exact old ON -> current-code consistency, not a candidate gain comparison.
parity, mismatches = [], []
for c in manifest['selection']:
    for old in c['allCheckpoints']:
        r=by_exact.get((c['visit']['bus_name'],old['at']))
        f=forecast(r,old['target'],0) if r else None
        if f is None:
            mismatches.append(dict(sourceId=c['sourceId'],at=old['at'],target=old['target'],reason='missing or ambiguous current forecast'));continue
        diff=max(abs(f[k]-old['candidate'][k]) for k in ['eta','low','high'])
        parity.append(diff)
        if diff>1e-7:mismatches.append(dict(sourceId=c['sourceId'],at=old['at'],target=old['target'],maxDiff=diff))
assert not mismatches, mismatches[:3]

def metrics(rs):
    es=[r['errorPredictedMinusActual'] for r in rs]
    ae=sorted(map(abs,es))
    if not rs:return dict(n=0)
    def quant(p):
        x=(len(ae)-1)*p;i=int(x);return ae[i]+(ae[min(i+1,len(ae)-1)]-ae[i])*(x-i)
    return dict(n=len(rs),sources=len({r['sourceId'] for r in rs}),targets=len({r['targetVisitId'] for r in rs}),
        maeSec=statistics.mean(ae),medianAbsSec=statistics.median(ae),p90AbsSec=quant(.9),
        WIS=statistics.mean((.5*abs(r['errorPredictedMinusActual'])+.1*(r['current']['high']-r['current']['low'])+
              max(0,r['current']['low']-r['truthSec'])+max(0,r['truthSec']-r['current']['high']))/1.5 for r in rs),
        widthSec=statistics.mean(r['current']['high']-r['current']['low'] for r in rs),
        early=sum(r['truthSec']<r['current']['low'] for r in rs),late=sum(r['truthSec']>r['current']['high'] for r in rs))

jumps={}
for c in outcomes['cases']:
    for ep in c['endpoints']:
        first=next(e for e in c['endpoints'] if e['target']==ep['target'] and e['occurrence']==0)
        rs=[r for r in by_bus[c['bus']] if c['source']['pinned_at']<=r['at']<first['outcome']['arrived_at'] and r['warmMs']>=600000]
        for a,b in zip(rs,rs[1:]):
            dt=(b['at']-a['at'])/1000
            if not 0<dt<=15 or a['segmentId']!=b['segmentId']:continue
            fa,fb=forecast(a,ep['target'],ep['occurrence']),forecast(b,ep['target'],ep['occurrence'])
            if fa is None or fb is None:continue
            key=(c['bus'],ep['outcome']['id'],b['at'])
            jump=dt+fb['eta']-fa['eta']
            if key in jumps:
                assert abs(jumps[key]['jumpSec']-jump)<1e-8
                jumps[key]['sourceContexts'].append(c['sourceId'])
            else:jumps[key]=dict(bus=c['bus'],targetVisitId=ep['outcome']['id'],target=ep['target'],occurrence=ep['occurrence'],at=b['at'],jumpSec=jump,sourceContexts=[c['sourceId']])

groups={}
for occurrence in [0,1]:
    for target in [48,4]:
        rs=[r for r in checks if r['occurrence']==occurrence and r['target']==target]
        groups[f'{target}/{occurrence}']=dict(all=metrics(rs),stopped=metrics([r for r in rs if r['targetOutcome']=='stopped']))
report=dict(scope='Selected-error diagnostic only, not population performance or a candidate comparison. Forecast errors are predicted minus actual: positive means bus arrived earlier than predicted.',
    counts=dict(traceFrames=len(traces),scoredCheckpoints=len(checks),unavailableCheckpoints=len(missing),unconnectedEndpoints=len(outcomes['missing']),
        archivedOnComparisons=len(parity),maxArchivedOnDifference=max(parity),orderedDistributions=sum(len(r['forecasts']) for r in traces)),
    selectedMetrics=groups,checkpoints=checks,missingForecasts=missing,unconnectedEndpoints=outcomes['missing'],
    evolution=evolution,jumps=list(jumps.values()),
    jumpSummary={str(o):dict(adjacentPairs=sum(j['occurrence']==o and j['target'] in [48,4] for j in jumps.values()),
        positiveGT60=sum(j['occurrence']==o and j['target'] in [48,4] and j['jumpSec']>60 for j in jumps.values()),
        negativeLTMinus60=sum(j['occurrence']==o and j['target'] in [48,4] and j['jumpSec']< -60 for j in jumps.values())) for o in [0,1]},
    inputs={p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in [OUT/'current-trace.jsonl',OUT/'trace-outcomes.json']})
(Path('/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/review-round-2/trace-scores.json')).write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps(dict(counts=report['counts'],selectedMetrics=groups,jumpSummary=report['jumpSummary']),indent=2))
for r in checks:
    if r['sourceStop']==121 and r['phase']=='departure' and r['checkpointSec']==60:
        print(json.dumps({k:r[k] for k in ['sourceId','target','occurrence','targetVisitId','truthSec','errorPredictedMinusActual']}))
