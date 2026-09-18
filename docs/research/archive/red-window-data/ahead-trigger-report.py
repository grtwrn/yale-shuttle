"""Render corrected all-family scores and all-stop event-study evidence."""
import csv,json,pathlib
D=pathlib.Path(__file__).resolve().parent
x=json.loads((D/'ahead-trigger-screen.json').read_text());y=json.loads((D/'ahead-trigger-barrier.json').read_text());scores=x['scores']+y['scores']
assert 'causalCorrection'in x['plan']
assert all(r['ready']<=1789665240913 for r in x['featureRows'])
assert all(r['predecessor']is None or(r['predecessor']['known']<=r['a']and r['predecessor']['bus']!=r['bus'])for r in x['featureRows'])
for group in x['perEpisodeScores']+y['perEpisodeScores']:
 es=group['episodes'];assert len(es)==len({r['id']for r in es})=={11:99,121:103}[group['stop']]
def score(reg,stop,arm,cal=False,group='all'):
 return next(s for s in scores if(s['regime'],s['stop'],s['arm'],s['calibrated'],s['group'])==(reg,stop,arm,cal,group))
for stop in[11,121]:
 assert score('arrival15_clear30_proxy',stop,'baseline')['meanLogLossPerHold']==score('completed120',stop,'baseline')['meanLogLossPerHold']
fields=['regime','sourceStop','triggerStop','triggerName','eventKind','split','window','riskBins','exposureMinutes','holdEpisodes','dates','departures','baselineExpectedDepartures','observedToExpected']
with (D/'ahead-trigger-event-study.csv').open('w')as f:
 w=csv.DictWriter(f,fieldnames=fields);w.writeheader()
 for e in x['eventStudy']:
  for k in ['afterKnownEvent','beforeFutureKnownEvent_NEGATIVE_CONTROL']:
   w.writerow({**{n:e[n]for n in fields[:6]},'window':k,**e[k]})
lines=['# Ahead-shuttle trigger investigation','',
'**The explicit stop-trigger family is now tested separately from broad headways. The useful new lead is predecessor progress interacting with the clock at Winchester.** This does not identify a single dispatch trigger. Union benefits are small or mixed. No app change, model publication or reserved-afternoon feature tuning was performed.','',
'## Causal contract and chronological evaluation','',
'The predecessor is the most recently confirmed **other** bus to depart the same regulator before the focal bus pins, on the same day and within 60 minutes. Its completed-record availability must precede focal pin, and its identity stays fixed throughout the hold. This is earlier-departure order, not future-defined order or the nearest physical bus after an overtake.','',
'The existing elapsed-age, own-lap and 15-minute-clock departure hazard is the baseline/offset. New coefficients fit Sep 3, 4, 8 and 9; a separate probability calibration intercept uses Sep 10–11; evaluation uses the previously inspected Sep 14–17 development recordings, ending at **17:14:00.913 UTC on Sep 17**. Winchester/Union counts are 102/112 training, 58/61 calibration and 99/103 evaluation holds. Predecessor identity is known for 95/99 and 100/103 evaluation holds. The previously proved corrupt source 65237 is excluded by the existing cohort; legitimate short and long outliers remain.','',
'Each prediction covers departure in the **next 15 seconds**, using neighbor observations available at the start of that risk bin. This is adaptive one-step hazard validation. A current remaining-wait CDF cannot be evaluated by supplying the predecessor’s realized future route: that would leak. No such future-path input is used here.','',
'Two availability contracts are evaluated:','',
'- **Pinned arrival +15s / clearance +30s proxy:** a pin becomes arrival evidence only at pin time +15s, including pinned passes. Unpinned passes are not asserted stop arrivals. Sparse forward progress uses anchor +15s for every visit, regardless of whether it later pins. Clearance uses a non-gap departure +30s. These are timestamp proxies, not exact receipt logs.','- **Completed +120s sensitivity:** evidence is admitted only after completed departure +120s, or later recorded confirmation evidence. This may remove precisely the information an immediate dispatch trigger needs. Duplicate arrival/clearance columns, when present, are collapsed from training features only.','',
'**Correctness repair:** the preliminary “pin if it eventually pins, otherwise anchor” fallback could make early event absence depend on a future pin. It was removed before this final report. All numbers below use the corrected contract; `before-causal-fix` files are archived, superseded diagnostics.','',
'Initial fixed families were baseline, predecessor availability/headway, sparse progress, all-stop recent arrival pulses, all-stop recent clearance pulses, and their joint extension. Pulses last 120 seconds. Stop columns enter jointly with L2 = 10 and need exposure in at least five training holds on two dates; development outcomes do not select supported stops.','',
'A separately documented **post-first-screen extension** tests the user’s “wait until” wording more directly: persistent already-reached/already-cleared flags since the predecessor’s selected prior-source departure, plus already-reached flags interacting with the current 15-minute clock. All three extension families are reported; no individual stop is chosen from evaluation results.','',
'## All tested families','',
'Mean sequential negative log loss per hold; lower is better. Raw and independently intercept-calibrated results are both shown.']
arms=x['plan']['arms']+y['extension']['arms']
labels={'baseline':'Existing lap + clock','predecessor_control':'Predecessor availability/headway','progress':'Known forward stop progress','arrival_pulses':'All-stop recent arrival pulses','clearance_pulses':'All-stop recent clearance pulses','joint':'Progress + arrival/clearance pulses','reached_barrier':'Already reached (extension)','cleared_barrier':'Already cleared (extension)','reached_clock_interactions':'Already reached × clock (extension)'}
for reg,title in [('arrival15_clear30_proxy','Pinned arrival +15s / clearance +30s'),('completed120','Completed +120s sensitivity')]:
 lines += ['',f'### {title}','','| Family | Winchester raw | Winchester calibrated | Union raw | Union calibrated |','|---|---:|---:|---:|---:|']
 for arm in arms:
  vv=[score(reg,stop,arm,cal)['meanLogLossPerHold']for stop in[11,121]for cal in[False,True]]
  lines.append('| '+labels[arm]+' | '+' | '.join(f'{v:.4f}'for v in vv)+' |')
b=score('arrival15_clear30_proxy',11,'baseline');a=score('arrival15_clear30_proxy',11,'arrival_pulses');c=score('arrival15_clear30_proxy',11,'reached_clock_interactions')
lines += ['',f"At Winchester, arrival pulses improve raw log loss {b['meanLogLossPerHold']:.4f} → {a['meanLogLossPerHold']:.4f}. Already-reached × clock improves it to {c['meanLogLossPerHold']:.4f}, about {(1-c['meanLogLossPerHold']/b['meanLogLossPerHold'])*100:.1f}%. Raw mean Brier per hold changes {b['meanBrierPerHold']:.6f} → {c['meanBrierPerHold']:.6f}. This is a predictive lead, not a measured 4% improvement in rider ETA accuracy.",'',
'### Date consistency for the Winchester interaction','',
'| Development date | Holds | Baseline raw log loss | Interaction raw | Baseline calibrated | Interaction calibrated |','|---|---:|---:|---:|---:|---:|']
for day in ['2026-09-14','2026-09-15','2026-09-16','2026-09-17']:
 z=[score('arrival15_clear30_proxy',11,arm,cal,day)for cal in[False,True]for arm in['baseline','reached_clock_interactions']]
 lines.append(f"| {day} | {z[0]['n']} | "+' | '.join(f"{s['meanLogLossPerHold']:.4f}"for s in z)+' |')
lines += ['',
'Three dates improve; Sep 15 worsens. Calibration on the two earlier dates lowers Winchester’s forecast departure rate and worsens absolute development log loss for all families, so it is not a reliable probability-calibration guarantee. Union live-event effects are small, the joint pulse family worsens, and the delayed already-reached × clock family also worsens.','',
'Risk bins share holds, buses and days. Primary scores sum sequential log losses per hold. Per-hold Brier is descriptive; pooled risk-bin Brier and all date/availability strata are in JSON. These scores establish neither a remaining-time interval nor fewer missed buses.','',
'## Event timing and negative controls','',
'The CSV reports every one of the 29 route stops, both source regulators, all three date partitions, both event types and both latency contracts. It includes risk exposure, hold/date support, actual departures, and the baseline hazard’s expected count. The timing control looks at events becoming known in the **next** 120 seconds and is descriptive only; it never enters a predictive feature. Observed/expected ratios are not causal effects or independent significance tests.','',
'Illustrative training-associated stops, with all stops retained in the predictive families:','',
'| Focal stop; predecessor arrival | Training after: observed/expected | Development after | Development before-event control |','|---|---:|---:|---:|']
for src,sid in [(11,39),(11,38),(121,3),(121,11)]:
 tr=next(e for e in x['eventStudy']if(e['regime'],e['sourceStop'],e['eventKind'],e['split'],e['triggerStop'])==('arrival15_clear30_proxy',src,'arrival','train',sid))
 te=next(e for e in x['eventStudy']if(e['regime'],e['sourceStop'],e['eventKind'],e['split'],e['triggerStop'])==('arrival15_clear30_proxy',src,'arrival','development',sid))
 def fmt(p):return f"{p['departures']}/{p['baselineExpectedDepartures']:.2f} ({p['observedToExpected']:.2f}×)"
 lines.append(f"| {'Winchester'if src==11 else 'Union'}; {tr['triggerName']} | {fmt(tr['afterKnownEvent'])} | {fmt(te['afterKnownEvent'])} | {fmt(te['beforeFutureKnownEvent_NEGATIVE_CONTROL'])} |")
lines += ['',
'College/George and College/Crown show Winchester associations after arrival, but development departures are elevated before those events as well. Union’s Prospect association does not persist after arrival. Shared operating cycles, correlated progress and anticipation of a nearby predecessor remain plausible explanations. The event-latency proxies also prevent treating the negative controls as definitive disproof of an operational rule.','',
'## Recommendation','',
'**Keep predecessor progress × clock as a Winchester research candidate; do not hardcode a stop-trigger rule or add this family to the already frozen production candidate from these results.** Verify predecessor identity and exact receipt times against continuous GPS, including overtaking, missing buses and same-stop encounters. A later prospective shadow can test the fixed family on new dates. Full ETA use must forecast future predecessor movement causally and fall back when the evidence is stale.','',
'Same-stop co-presence is the parent agent’s separate investigation. These families do not exhaust conditional dispatch barriers, other landmarks, service blocks or alternate fleet-order definitions. Weak average results do not rule out a real operational rule or a better model of it.','',
'Reproduce with `ahead-trigger-screen.py`, `ahead-trigger-barrier.py`, then `ahead-trigger-report.py`. Corrected plans, JSON/log evidence, all-stop CSV and input hashes are saved alongside this report. SQLite access was read-only; the reserved afternoon and application files were untouched.']
(D/'ahead-trigger-review.md').write_text('\n'.join(lines)+'\n')
print('Corrected cohort/causality assertions passed; report and all-stop CSV saved.')
