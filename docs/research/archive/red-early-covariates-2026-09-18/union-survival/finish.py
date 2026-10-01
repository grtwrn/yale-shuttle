"""Runtime parity, gate-respecting comparison, and recorded regression audit."""
from pathlib import Path
import collections, datetime, hashlib, json, math, sqlite3
import numpy as np
from screen import ARMS, metrics, summarize

OUT=Path(__file__).resolve().parent
ROOT=OUT.parent.parent
rows=[json.loads(x) for x in (OUT/'predictions.jsonl').read_text().splitlines()]
runtime=json.loads((OUT/'runtime-comparator.json').read_text())
fits=json.loads((OUT/'fits.json').read_text())
by={(r['id'],r['elapsed']):r for r in runtime['forecasts']}
coefficient_delta=max(abs(a-b) for a,b in zip(fits['fits'][ARMS[0]]['coefficients'],runtime['fit']['coefficients']))
assert coefficient_delta<1e-5
delta=[]
for r in rows:
    v=by[r['id'],r['elapsed']]
    assert v['truthRemaining']==r['truthRemaining'] and v['forecastAt']==r['forecastAt']
    r['predictions']['runtime_component']=dict(q=v['q'],p120=v['p120'])
    if r['lapSupported']:
        delta.extend(abs(a-b) for a,b in zip(r['predictions'][ARMS[0]]['q'],v['q']))
        r['predictions']['candidate_with_runtime_gate']=r['predictions'][ARMS[1]]
    else:
        r['predictions']['candidate_with_runtime_gate']=r['predictions']['runtime_component']
        assert r['predictions']['candidate_with_runtime_gate']==r['predictions']['runtime_component']
assert max(delta)<.001
gate_scores=summarize(rows,['runtime_component','candidate_with_runtime_gate'])
(OUT/'runtime-gated-scores.json').write_text(json.dumps(gate_scores,indent=2)+'\n')

score_rows=[r for r in rows if r['split']=='development' and r['lapSupported']]
switches=[]
for r in score_rows:
    y=r['truthRemaining']; b=r['predictions'][ARMS[0]]['q']; c=r['predictions'][ARMS[1]]['q']
    if (y<b[1])!=(y<c[1]) or (y>b[5])!=(y>c[5]):
        switches.append(dict(id=r['id'],bus=r['bus'],day=r['day'],elapsed=r['elapsed'],truthRemaining=y,
            baselineLow=b[1],candidateLow=c[1],baselineHigh=b[5],candidateHigh=c[5],
            newEarly=y<c[1] and y>=b[1],newLate=y>c[5] and y<=b[5],
            earlyShortfall=max(0,c[1]-y),lateShortfall=max(0,y-c[5])))

db=sqlite3.connect('file:'+str(ROOT/'release-integration-data/outcomes-complete.db')+'?mode=ro',uri=True)
db.row_factory=sqlite3.Row
capture=json.loads((OUT.parent/'recordings-followup.json').read_text())
visits={r['id']:dict(r) for r in db.execute('select * from stop_visits')}
legs={r['id']:dict(r) for r in db.execute('select * from legs where route_id=3')}
db.close()
visits.update({r['id']:r for r in capture['stop_visits']})
legs.update({r['id']:r for r in capture['legs']})
episode_rows=collections.defaultdict(list)
for r in score_rows:episode_rows[r['id']].append(r)
worst=[]
for vid,rr in episode_rows.items():
    b,c=[metrics(rr,a,'visit') for a in ARMS]
    worst.append(dict(id=vid,day=rr[0]['day'],deltaWIS=c['wis80']-b['wis80'],deltaMAE=c['mae']-b['mae']))
top=sorted([r for r in worst if r['day']!='2026-09-18'],key=lambda r:-r['deltaWIS'])[:5]
top+=sorted([r for r in worst if r['day']=='2026-09-18'],key=lambda r:-r['deltaWIS'])[:5]
ids={r['id'] for r in top}|{r['id'] for r in switches}|{64318,65347}
audits={}
for vid in sorted(ids):
    v=visits[vid]
    incoming=[r for r in legs.values() if r.get('to_visit_id')==vid]
    outgoing=[r for r in legs.values() if r.get('from_visit_id')==vid]
    audits[vid]=dict(visit=v,incoming=incoming,outgoing=outgoing,rawSamples=[],
        verdict='Retained: completed non-gap stopped visit with pin/rest evidence; no affirmative measurement-error evidence in this bounded record audit.')
raw_paths=[ROOT/'release-integration-data/raw-complete-frames.jsonl',ROOT/'red-lower-data-2026-09-18/raw-today-frames.jsonl']
for path in raw_paths:
    with path.open() as stream:
        for line in stream:
            f=json.loads(line)
            at=int(datetime.datetime.fromisoformat(f['at'].replace('Z','+00:00')).timestamp()*1000)
            candidates=[a for a in audits.values() if a['visit']['pinned_at']-60000<=at<=a['visit']['departed_at']+120000]
            if not candidates:continue
            for a in candidates:
                v=a['visit']
                for bus in f['buses']:
                    if bus['bus_name']==v['bus_name'] and bus['route_id']==3:
                        a['rawSamples'].append(dict(at=at,source=str(path),**bus))
for vid,a in audits.items():
    samples=sorted({(r['at'],r['bus_id']):r for r in a.pop('rawSamples')}.values(),key=lambda r:r['at'])
    v=a['visit']; held=[r for r in samples if v['pinned_at']<=r['at']<=v['departed_at']]
    gaps=[(b['at']-aa['at'])/1000 for aa,b in zip(held,held[1:])]
    pins=sorted({(r.get('at_stop_id'),r.get('at_stop_since')) for r in held if r.get('at_stop_id') is not None},key=str)
    after=[r for r in samples if r['at']>v['departed_at']]
    movement=None; plateau=[]
    if held:
        last=held[-1]
        for r in reversed(held):
            if (r['lat'],r['lon'])!=(last['lat'],last['lon']):break
            plateau.append(r)
        movement=next((r['at']-v['departed_at'] for r in after if (r['lat'],r['lon'])!=(last['lat'],last['lon'])),None)
    a['rawSummary']=dict(samples=len(samples),heldSamples=len(held),maxHeldGapSec=max(gaps) if gaps else None,
        observedPins=pins,finalPlateauSec=(plateau[0]['at']-plateau[-1]['at'])/1000 if plateau else None,
        firstDistinctMovementAfterDepartureSec=movement/1000 if movement is not None else None)
    if not samples:
        a['verdict']='Retained: completed non-gap stopped visit with rest evidence and adjacent leg records. No raw fixes in the two available frame archives; absence is not evidence of error.'
(OUT/'regression-audit.json').write_text(json.dumps(dict(newBoundCrossings=switches,largestSupportedRegressions=top,cases=audits),indent=2)+'\n')

all_scores=json.loads((OUT/'scores.json').read_text())
def get(period,cohort='lap_supported',weight='visit',source=all_scores):
    return next(r for r in source if (r['period'],r['cohort'],r['weighting'])==(period,cohort,weight))
def line(s):
    b,c=s['arms'].values()
    return f"| {s['period']} | {s['cohort']} | {b['visits']}/{b['landmarks']} | {b['mae']:.2f} → {c['mae']:.2f} | {b['wis80']:.2f} → {c['wis80']:.2f} | {b['width80']:.1f} → {c['width80']:.1f} | {b['earlyCount']} → {c['earlyCount']} | {b['lateCount']} → {c['lateCount']} |"
lines=['# Own Union departure age: remaining-wait screen','',
'**Verdict: a small additional predictive signal, but not enough standalone rider benefit to prioritize full ETA integration over the remaining episode-clock and departure-transition issues. Keep it as a possible low-cost feature for a later combined model. No model was deployed or application code changed.**','',
'The matched supported-lap comparison improves WIS by about 0.9% over September 14–17 and 1.9% over nine September 18 holds. It narrows the average current-wait window by only four to six seconds. The larger all-case September 18 gain is concentrated in three unsupported-lap holds; production uses a different marginal fallback there, which this candidate must preserve. The two new early-bound crossings are two valid journeys with only 0.29 and 1.42 seconds of new shortfall. They are not a reason to discard the candidate, but the overall incremental benefit remains small.','',
'## Prespecified model and causality','',
'Two arms use the same 160 training holds on six dates, with outcomes available before September 14 at 00:00 ET. Each hold contributes one ordinary 15-second event-history likelihood. There are no repeated-landmark fitting weights, outcome trimming, hyperparameter search or calibration. The baseline is the existing nine-feature elapsed/lap/15-minute-clock hazard; the added arm includes only time since the bus’s own prior Union departure and a missing indicator, with fixed L2=4. The Union departure is known at least 120 seconds before pin, same-day and within two hours, then latched. Its age advances deterministically. Every source origin matches the parent classifier at all landmarks; none changes. The two parent peer-availability regimes are identical for these own-bus features, so fitting duplicate regimes adds no information.','',
'This is a conditional known-rest component forecast. Historical pin availability is still proxied; there is no live state mixture, 30-second arrival pooling, route endpoint, pickup catchability or class-arrival evaluation. September 14–17 is reused development. September 18 was already inspected in the binary screen and is separate chronological follow-up, not untouched confirmation.','',
'The Union-age coefficient is predictive, not proof of a dispatch rule. Advancing Union age includes elapsed time, which is already in the baseline; ridge can redistribute regularization between these correlated terms. A static bus identifier also does not identify a driver.','',
'## Matched supported-lap results','',
'Seconds; lower MAE/WIS is better. Counts are checkpoints, not independent journeys. Totals weight each visit equally across its eligible landmarks, a descriptive sampled-landmark population rather than calibrated live per-poll risk.','',
'| Period | Cohort | Visits/checkpoints | MAE | WIS80 | Width80 | Early misses | Late misses |',
'|---|---|---:|---:|---:|---:|---:|---:|']
for period in ['Sep14_17','Sep18']:lines.append(line(get(period)))
lines += ['', 'Early means departure before the lower bound; late means departure after the upper bound. Supported-lap lower-quantile pinball loss changes 13.93→13.89 seconds on older dates and 27.87→27.66 today. There is no convincing fix to the problematic early-departure tail, and no reason here to raise a rider’s minimum waiting time.','',
'## Exact runtime component and unchanged fallback','',
f"The unchanged runtime loader independently reproduces all 160 training rows. Baseline coefficients differ by at most {coefficient_delta:.8f}; supported quantiles differ by at most {max(delta):.6f} seconds. The following comparison applies the added hazard only inside the existing lap support gate and preserves actual runtime marginal/lap fallback byte-for-byte outside it. Frozen pre-September-14 tables and fits are used; this is not a live six-hour refit replay.",'',
'| Period | Cohort | Visits/checkpoints | MAE | WIS80 | Width80 | Early misses | Late misses |',
'|---|---|---:|---:|---:|---:|---:|---:|']
for period in ['Sep14_17','Sep18']:lines.append(line(get(period,'all','visit',gate_scores)))
lines+=['','For contrast, applying experimental hazards even to unsupported laps would change today’s three fallback-hold MAE 242→197 and WIS128→106. That is not a measured production improvement and is excluded from the gate-respecting comparison above.','',
'## Fixed-age equal-visit checks','',
'Each row gives every surviving supported visit equal weight, avoiding the inverse-eligible-landmark weighting issue.','',
'| Period | Age | Visits | MAE | WIS80 | Width80 | Early misses | Late misses |',
'|---|---:|---:|---:|---:|---:|---:|---:|']
for period in ['Sep14_17','Sep18']:
    for age in [0,60,180,300,480]:
        s=get(period,f'supported_elapsed_{age}','checkpoint');b,c=s['arms'].values()
        lines.append(f"| {period} | {age} | {b['visits']} | {b['mae']:.1f} → {c['mae']:.1f} | {b['wis80']:.2f} → {c['wis80']:.2f} | {b['width80']:.1f} → {c['width80']:.1f} | {b['earlyCount']} → {c['earlyCount']} | {b['lateCount']} → {c['lateCount']} |")
lines+=['','## Per-date supported visits','',
'| Period | Cohort | Visits/checkpoints | MAE | WIS80 | Width80 | Early misses | Late misses |',
'|---|---|---:|---:|---:|---:|---:|---:|']
for day in sorted({r['day'] for r in score_rows}):lines.append(line(get(day)))
lines+=['','## Genuine regressions and threshold crossings','',
'All reviewed visits remain. The new early misses are distinct journeys:','',
'- **45643, #316, September 14, pin+0:** actual59.98 seconds; lower bound57.61→60.27, creating0.29-second shortfall. Complete non-gap stopped visit, three rest polls, one shuffle, closest69.5m. There are no raw fixes from this date in the two available archives; no positive error evidence justifies removal.',
'- **58717, #309, September 16, pin+60:** actual110.10 seconds remaining; lower105.67→111.52, creating1.42-second shortfall. Complete non-gap stopped visit, eight rest polls, three shuffles; raw-frame evidence is saved in the audit.',
'- **70719, #306, September 18, pin+300:** actual340.05 seconds remaining; upper342.25→333.02, creating7.03-second late shortfall. It was already a visit with late misses at other ages: today’s number of distinct late-miss visits stays two. Raw and adjacent-event evidence is saved.',
'','The extra early crossings raise distinct affected supported visits from19 to21 across older dates, not just checkpoint counts. Existing difficult early cases64318 and65347 are retained: at+60 the former’s lower-bound shortfall increases33.72→35.14 seconds; at+480 the latter changes31.37→31.15 seconds. This feature does not explain away those genuine early releases.','',
'`regression-audit.json` includes the top five supported WIS regressions in each evaluation period, original visit records, neighboring leg records, raw continuity/plateau summaries where available, and all new bound crossings. Real waits range well beyond the early cases; no removal is based on residual, shortness or model disagreement.','',
'## Reproduction and next action','',
'Run `screen.py`, `runtime-comparator.mts` from the v2 app cwd, then `finish.py`, each computational step under `overnight-2026-09-17/heavy.lock` with one BLAS thread. `PLAN.json` preserves the frozen definition and input hashes; `fits.json`, `predictions.jsonl`, `scores.json`, `runtime-gated-scores.json`, `runtime-comparator.json` and `regression-audit.json` retain every arm and subgroup.','',
'The incremental feature is cheap enough to retain in the research backlog. The present four-to-six-second narrowing and nearly unchanged lower-tail score do not justify claiming a useful new rider ETA improvement. If later combined with a causally corrected wait-origin model, evaluate its incremental contribution with the same support gate, true short holds, continuous warm state, departure transitions, both target occurrences and new service dates.']
(OUT/'REPORT.md').write_text('\n'.join(lines)+'\n')
summary=dict(verdict='Small signal, not enough standalone benefit to prioritize full ETA replay now; retain as a low-cost possible combined-model feature.',
    maxCoefficientDelta=coefficient_delta,maxSupportedRuntimeQuantileDeltaSec=max(delta),newBoundCrossings=switches,
    oldNewEarlyDistinctVisits=[19,21],sep18LateDistinctVisits=[2,2],applicationChanged=False,deployed=False,
    report='REPORT.md',hashes={p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in OUT.iterdir() if p.is_file() and p.name not in ['summary.json','finish.log']})
(OUT/'summary.json').write_text(json.dumps(summary,indent=2)+'\n')
print(json.dumps({k:v for k,v in summary.items() if k!='hashes'},indent=2))
print('Gate respecting totals')
for period in ['Sep14_17','Sep18']:print(line(get(period,'all','visit',gate_scores)))
print('Audited cases')
for vid in [45643,58717,70719]:print(vid,json.dumps(audits[vid]['rawSummary']))
