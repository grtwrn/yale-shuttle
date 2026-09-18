"""Preserve all arms, runtime gates and real regressions; no model selection fit."""
from pathlib import Path
import collections, hashlib, json, math
import screen as s

OUT=s.OUT;ROOT=s.ROOT
original=[json.loads(x) for x in (OUT/'predictions.jsonl').read_text().splitlines()]
fresh=[json.loads(x) for x in (OUT/'extension-predictions.jsonl').read_text().splitlines()]
cohort={e['id']:e for e in json.loads((OUT/'cohort.json').read_text())+json.loads((OUT/'extension-cohort.json').read_text())}
runtime=json.loads((OUT/'runtime-comparator.json').read_text())
runtime_by={(r['id'],r['elapsed']):r for r in runtime['forecasts']}
primary=[r for r in original+fresh if r['regime']=='primary']
support={}
for stop in [11,121,117,13]:
    rs=[e['histories']['primary']['latest'][str(stop)] for e in cohort.values() if e['split']=='train']
    valid=[r for r in rs if r['duration'] is not None]
    support[stop]=dict(trainingFocalVisits=160,knownDurations=len(valid),missing=len(rs)-len(valid),
        distinctPriorVisits=len({r['id'] for r in valid}),pauses120=len([r for r in valid if r['duration']>=120]),
        pauses180=len([r for r in valid if r['duration']>=180]),
        longSourceIds=[r['id'] for r in valid if r['duration']>=120])
(OUT/'history-support.json').write_text(json.dumps(support,indent=2)+'\n')

parity=[];gate_rows=[]
for r in primary:
    rb=runtime_by[r['id'],r['elapsed']]
    assert rb['truthRemaining']==r['truthRemaining'] and rb['forecastAt']==r['forecastAt']
    if r['lapSupported']:parity.extend(abs(a-b) for a,b in zip(r['predictions'][s.ARMS[0]]['q'],rb['q']))
    x=dict(r,predictions={'runtime_component':dict(q=rb['q'],p120=rb['p120'])})
    for arm in s.ARMS[1:]:x['predictions'][arm]=r['predictions'][arm] if r['lapSupported'] else x['predictions']['runtime_component']
    gate_rows.append(x)
assert max(parity)<.001
old_ids={r['id'] for r in original};fresh_ids={r['id'] for r in fresh}
samples={'Sep14_17':[r for r in primary if r['day']!='2026-09-18'],
    'Sep18_original':[r for r in primary if r['day']=='2026-09-18' and r['id'] in old_ids],
    'Sep18_fresh':[r for r in primary if r['id'] in fresh_ids],
    'Sep18_combined':[r for r in primary if r['day']=='2026-09-18']}
gates={name:[r for r in gate_rows if r['id'] in {x['id'] for x in rr}] for name,rr in samples.items()}
score=[]
for sample,rr in samples.items():
    for name,rs,arms in [('supported',[r for r in rr if r['lapSupported']],s.ARMS),
        ('all',rr,s.ARMS),('runtime_gated',gates[sample],['runtime_component',*s.ARMS[1:]])]:
        score.append(dict(sample=sample,cohort=name,arms={a:s.base.metrics(rs,a,'visit') for a in arms}))
(OUT/'comparison-summary.json').write_text(json.dumps(score,indent=2)+'\n')

bound_changes=[];regressions=[]
by=collections.defaultdict(list)
for r in primary:
    if r['lapSupported']:by[r['id']].append(r)
for arm in s.ARMS[2:]:
    for vid,rr in by.items():
        b,c=[s.base.metrics(rr,a,'visit') for a in [s.ARMS[1],arm]]
        regressions.append(dict(id=vid,arm=arm,day=rr[0]['day'],bus=rr[0]['bus'],holdSec=rr[0]['holdSec'],
            deltaWis=c['wis80']-b['wis80'],deltaMae=c['mae']-b['mae'],baseline=b,candidate=c,
            priorHistories=cohort[vid]['histories']['primary'],
            checkpoints=[dict(elapsed=r['elapsed'],truth=r['truthRemaining'],baseline=r['predictions'][s.ARMS[1]],candidate=r['predictions'][arm]) for r in rr]))
        for r in rr:
            y=r['truthRemaining'];bq=r['predictions'][s.ARMS[1]]['q'];cq=r['predictions'][arm]['q']
            be,ce=max(0,bq[1]-y),max(0,cq[1]-y);bl,cl=max(0,y-bq[5]),max(0,y-cq[5])
            if ce>be+1e-6 or cl>bl+1e-6:
                bound_changes.append(dict(id=vid,arm=arm,day=r['day'],bus=r['bus'],elapsed=r['elapsed'],truth=y,
                    baselineLow=bq[1],candidateLow=cq[1],baselineHigh=bq[5],candidateHigh=cq[5],
                    baselineEarlyShortfall=be,candidateEarlyShortfall=ce,baselineLateShortfall=bl,candidateLateShortfall=cl,
                    newEarly=ce>0 and be==0,newLate=cl>0 and bl==0))
(OUT/'all-bound-regressions.json').write_text(json.dumps(bound_changes,indent=2)+'\n')
(OUT/'all-visit-comparisons.json').write_text(json.dumps(regressions,indent=2)+'\n')
top={arm:sorted([r for r in regressions if r['arm']==arm],key=lambda r:-r['deltaWis'])[:5] for arm in s.ARMS[2:]}
(OUT/'top-regressions.json').write_text(json.dumps(top,indent=2)+'\n')

visits,_=s.load_history();capture=json.loads((OUT.parent/'recordings.json').read_text());visits.update({v['id']:v for v in capture['stop_visits']})
selected={r['id'] for r in bound_changes if r['arm']=='plus_previous_winchester_hold'}|{r['id'] for r in top['plus_previous_winchester_hold']}|{64318,65347,67621}
audit={}
for vid in sorted(selected):
    e=cohort[vid];v=visits[vid];prior=e['histories']['primary']['latest']['11']
    pv=visits.get(prior['id'])
    audit[vid]=dict(focal=v,priorWinchester=pv,historyUsed=prior,retained=True,
        verdict='Recorded focal and previous source outcomes retained; no outcome-based exclusion. See independent raw audit for selected cases.')
(OUT/'focal-and-prior-record-audit.json').write_text(json.dumps(audit,indent=2)+'\n')

def get(sample,cohort='supported'):return next(r for r in score if r['sample']==sample and r['cohort']==cohort)
def rowline(sample,arm,cohort='supported'):
    v=get(sample,cohort)['arms'][arm]
    return f"| {sample} | {arm} | {v['visits']}/{v['landmarks']} | {v['mae']:.2f} | {v['wis80']:.2f} | {v['width80']:.1f} | {v['earlyCount']} | {v['lateCount']} |"
lines=['# Own previous rests and Red Winchester release','',
'**Result: the previous Winchester wait is a useful research lead and merits one bounded full pickup-ETA replay. It does not yet justify a production change. Longer previous Winchester waits predict slightly longer current waits after controlling for lap and clock: persistence, rather than clear evidence of compensation for a bathroom break.**','',
'All feature families, penalties and timing contracts were declared before fitting. The simpler previous-Winchester arm improves current-wait accuracy on three of four older evaluation dates, the earlier September 18 sample, and five newly completed September 18 holds read only after coefficients were frozen. Its recent gains come mainly from correcting overly early departure predictions; the recent windows become slightly wider. Cedar and previous-Union history do not show consistent additional benefit in this screen.','',
'## Scope and exact hypothesis','',
'The canonical Red sequence contains **117 Gilbert/Cedar** and **13 Amistad/Cedar**, followed by **14 Amistad/Church St South** and **121 Union Station**.344Winchester is stop11. Other stops named Cedar are not on Red. The two Red Cedar locations were kept separate; stop14 was not silently included as Cedar.','',
'The ordinary nine-feature release hazard uses elapsed wait, lap fixed at pin and15-minute clock phase. Every new history arm adds to the previously tested **own-Union-departure-age** version of that baseline. Therefore the simpler candidate here has both Union-age and prior-Winchester-duration inputs; “prior Winchester alone added directly to the nine-feature runtime” was not a separate fitted arm. The paired increment isolates prior Winchester relative to the matched Union-age baseline.','',
'There are160 training holds on six dates before September14,113 older evaluation holds,12 initially available September18 holds, and5 later holds. Runtime lap support leaves100/9/5 evaluation holds respectively. Training uses one event-history likelihood per visit,15-second bins and fixedL2=4. No feature/penalty tuning, recalibration, residual trimming, or removal of valid short/long outcomes occurred.','',
'Prior duration means modern recorded **stand_sec**, measured from arrival/rest onset to final resting departure, including the measurement convention around shuffles; it is not legacy anchor residence and not evidence of a personal break. The duration feature is `log1p(stand_sec/60)` plus a missing indicator. The simple prior-Winchester coefficient is−0.22612 per unit of that log-duration: increasing the previous wait from1 to5minutes multiplies fitted15-second departure odds by about0.78, holding other inputs fixed. This association does not identify a driver, a causal instruction or a deterministic schedule.','',
'Current-lap history separately counts completed recorded waits at117/13/121 after the previous Winchester departure; it excludes the prior Winchester wait itself. Missing coverage is explicit and is never silently zero. No current target-hold outcome or future neighbor path enters any predictor.','',
'## Every prespecified arm','',
'Visit-balanced descriptive scores in seconds. Each visit has equal total weight across eligible0/60/180/300/480-second landmarks. These are not calibrated live per-poll probabilities; repeated landmarks are not independent trips. Early means departure before the lower bound; late means after the upper bound.','',
'| Sample | Arm | Visits/checkpoints | MAE | WIS80 | Width80 | Early checkpoints | Late checkpoints |',
'|---|---|---:|---:|---:|---:|---:|---:|']
for sample in ['Sep14_17','Sep18_original','Sep18_fresh']:
    for arm in s.ARMS:lines.append(rowline(sample,arm))
lines+=['','The previous-Winchester increment reduces WIS43.85→43.07 on the older dates (1.8%),57.35→53.20 on the original supported September18 sample (7.2%), and54.74→49.47 on the five later holds (9.6%). The new five-hold MAE changes88.9→81.3seconds; its width311→317seconds **widens**, while late checkpoints8→3 improve. No early misses occur in either arm on those five holds. Five holds from the same date are a useful extension, not a new independent-day validation.','',
'Combined history has somewhat better aggregate WIS but adds fragile Union/Cedar measurements and little extra benefit on the later five holds. This screen does not select the combined arm for production. The simpler previous-Winchester arm has fewer inputs and clearer measurement provenance.','',
'## By date and fixed elapsed age','',
'| Date | Supported visits | Union-age WIS | +previous Winchester WIS | +all history WIS | +previous Winchester MAE |',
'|---|---:|---:|---:|---:|---:|']
scores=json.loads((OUT/'scores.json').read_text())
for r in scores:
    if r['regime']=='primary' and r['period'].startswith('2026') and r['cohort']=='lap_supported' and r['weighting']=='visit':
        b,p,a=[r['arms'][k] for k in [s.ARMS[1],s.ARMS[2],s.ARMS[6]]]
        lines.append(f"| {r['period']} | {b['visits']} | {b['wis80']:.2f} | {p['wis80']:.2f} | {a['wis80']:.2f} | {p['mae']:.2f} |")
lines+=['','September15 is a small real regression for the simple prior-Winchester increment (WIS34.03→34.11). Full equal-visit fixed-age results, all arms, unsupported-lap strata and every timing sensitivity remain in `scores.json` and `extension-scores.json`. At each fixed age use `weighting=checkpoint` for equal surviving visits; the visit-weighted aggregate serves a different descriptive population.','',
'## Runtime gate and deployment boundary','',
f"The same-code runtime loader independently matches all160 training visits. Supported-lap baseline quantiles match to within{max(parity):.6f}seconds. Below, actual runtime marginal/lap fallback is unchanged for every unsupported case; the experimental history hazard only enters within the existing support gate.",'',
'| Sample | Arm | Visits/checkpoints | MAE | WIS80 | Width80 | Early checkpoints | Late checkpoints |',
'|---|---|---:|---:|---:|---:|---:|---:|']
for sample in ['Sep14_17','Sep18_original','Sep18_fresh']:
    for arm in ['runtime_component','plus_own_union_age','plus_previous_winchester_hold']:
        lines.append(rowline(sample,arm,'runtime_gated'))
lines+=['','These remain current-wait **component** comparisons with frozen pre-September14 fitting/tables. They do not include live rest/movement mixtures,30-second quantile pooling, approach/departure recognition, Division pickup endpoints, route-ranking changes, later target occurrences, or six-hour model refresh. Full rider gains cannot be inferred directly from these numbers.','',
'## Measurement and availability checks','',
'Every prior visit must already be observable on this route, on the same day and within90minutes at focal pin. More recent unknown or invalid-duration visits are kept missing rather than replaced with an older convenient wait. Already-observed other-route assignments reset this history. The known restart-truncated source65237 keeps its verified departure clock but has missing duration. Focal outcomes and all valid long/short prior durations remain.','',
'Primary known-time is the conservative proxy `max(departure+120s, departure+confirmSec+15s, firstMoved+confirmSec)`. `firstMoved+confirmSec` alone is not exact publication after shuffles: firstMoved is the first-ever motion, while confirmSec references the final departure candidate. The original120-second proxy gives identical features. The stricter `departure+600s+confirmSec` sensitivity, motivated by the current10-minute maximum accepted gap, changes only focal48783; it changes no training features. Its scores are preserved. Neither proxy is called recovered exact receipt time.','',
'Only a few long Cedar pauses occur in the fitted history:','',
'| Prior stop | Known durations /160 focal training holds | At least120s | At least180s |',
'|---|---:|---:|---:|']
for stop,name in [(11,'344 Winchester'),(121,'Union'),(117,'Gilbert/Cedar117'),(13,'Amistad/Cedar13')]:
    v=support[stop];lines.append(f"| {name} | {v['knownDurations']} | {v['pauses120']} | {v['pauses180']} |")
lines+=['','Thus weak Cedar coefficients do not rule out a policy specifically after multi-minute Cedar pauses. Independent raw checks confirm real long Cedar pauses58174 (~310seconds) and64797 (~235seconds), followed by genuine Winchester waits465 and660seconds; these counterexamples show that a long Cedar stop does not deterministically eliminate the next Winchester wait.','',
'The independent reviewer also found a **real prior-history defect**: Union60020 reports4.946seconds after a provider-ID change, but raw fixes show320seconds continuous standing before its late re-anchor on exit. Focal Winchester60263 remains valid. Training Union24868 has a similar suspicious ID/open-visit pattern but lacks the same raw proof. Original coefficients/results remain intact. This caveat particularly affects prior-Union/current-lap/combined families; the simpler previous-Winchester candidate does not use their duration inputs. A provenance-based sensitivity for combined history must preserve original results and focal outcomes.','',
'## Genuine regressions are retained','',
'The new early-bound crossing for the simpler candidate is **67621 (#309, September17, +180seconds)**: actual65.342seconds remaining, lower62.595→69.866, creating4.524seconds shortfall. Its245.342-second focal wait and previous Winchester67188 (~640seconds standing) have independently verified raw continuity/rest plateaus and onward movement. They are genuine; neither is excluded.','',
'Two previously audited difficult cases remain difficult. At64318 +60seconds, lower-bound shortfall35.14→38.96seconds worsens; at65347 +480seconds it changes31.15→37.94seconds. Prior wait memory does not solve every early departure. The five largest visit-WIS regressions for the simpler candidate are61306,48370,65347,47054 and67621; their paired forecasts and prior source records are preserved.','',
'`all-bound-regressions.json` contains **every increased early or late shortfall**, including already-outside intervals, for every history arm; `all-visit-comparisons.json` contains all paired visit changes. `focal-and-prior-record-audit.json` retains the exact focal/source evidence for every simpler-candidate tail regression and its largest WIS regressions. The independent source/raw audit is `../own-history-measurement-review.json` and its companion script. No residual-based exclusion or duration cap was introduced.','',
'## Next bounded implementation/replay task','',
'Carry forward the frozen **lap/clock + own Union age + previous Winchester duration** candidate for an isolated full pickup-ETA replay, with a matched current-production arm. Adding only previous Winchester directly to the nine-feature runtime is an untested ablation and must be named/frozen separately if chosen.','',
'No route-position filter or GPS projection change is required. The runtime needs two historically warm, pin-latched own-bus inputs: last confirmed Union departure and last valid completed Winchester recorded stand, including explicit missingness and provenance. Load history from the server DB at startup, update only on confirmed completed events, and latch values for the entire current wait. The release-fit payload gains the fitted coefficients; server state/checkpoints carry the per-bus inputs. Preserve the stable bus_name identity, route/service-day resets, runtime lap gate, duration quarantine, stale-history fallback and topology-refresh behavior. Do not make browsers learn these histories from scratch.','',
'Replay actual continuous raw observations, preserve identical forward route-position beliefs, and evaluate Winchester→Division48 and Rosenkranz4 first and second occurrences, arrival-window proper scores, early pickup misses/catchability, departure+0/+15/+60 behavior, availability, >60-second absolute-arrival jumps, and route ranking. Use real historical as-of fitting/receipt boundaries, not eventual source outcomes. Explicitly retain64318/65347/67621 and the largest current regressions. A useful component gain can still disappear in the full wait/movement mixture. Require independent review before any production proposal; this task makes no deployment claim.','',
'## Reproduction','',
'Run `screen.py`, then `extend.py` only after `fits.json` exists; run `runtime-comparator.mts` from the v2 app cwd, then `report.py`. All computational runs used `overnight-2026-09-17/heavy.lock` and one BLAS thread. Plans, timestamps, source/input hashes, every coefficient and all predictions remain in this directory. No app, production database, watcher or deployment was modified.']
(OUT/'REPORT.md').write_text('\n'.join(lines)+'\n')
summary=dict(verdict='Simple previous-Winchester history merits bounded full pickup-ETA replay; no deployment yet. Combined history needs measurement-quality sensitivity.',
    testedSimpleCandidate='lap/elapsed/clock + ownUnionAge + previousWinchesterStand',sign='Longer previous Winchester stand predicts longer current remaining wait conditional on core inputs; not compensation proof.',
    sourceHistoryDefect='Union60020 truncated duration independently confirmed; preserve focal60263. PriorWinchester candidate does not use Union duration.',
    freshVisits=sorted(fresh_ids),runtimeParityMaxSeconds=max(parity),applicationChanged=False,deployed=False,
    report='REPORT.md',hashes={p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in OUT.iterdir() if p.is_file() and p.name not in ['summary.json','report.log']})
(OUT/'summary.json').write_text(json.dumps(summary,indent=2)+'\n')
print(json.dumps({k:v for k,v in summary.items() if k!='hashes'},indent=2))
for sample in ['Sep14_17','Sep18_original','Sep18_fresh']:
    for arm in ['runtime_component','plus_previous_winchester_hold']:print(rowline(sample,arm,'runtime_gated'))
