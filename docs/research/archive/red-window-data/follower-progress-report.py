"""Render all prespecified follower families; no fitting or model selection."""
import json,pathlib
D=pathlib.Path(__file__).resolve().parent
x=json.loads((D/'follower-progress-screen.json').read_text());scores=x['scores']
def score(identity,regime,stop,offset,arm,cal=False,group='all'):
 return next((s for s in scores if all(s[k]==v for k,v in dict(identity=identity,regime=regime,stop=stop,offset=offset,arm=arm,calibrated=cal,group=group).items())),None)
lines=['# Following-shuttle progress: historical screen','',
'This tests the following bus’s stop progress explicitly. Earlier work only screened approximate ahead/behind spacing jointly. This analysis is exploratory and does not modify production or supply realized future bus movement to an ETA.','',
'## Design','',
'The baseline is the existing elapsed-wait / own-lap / 15-minute-clock departure hazard. Additional follower features fit before September 10; September 10–11 provides a separate intercept calibration; September 14–17 through 13:14 ET supplies previously inspected development outcomes. All 99 Winchester and 103 Union development holds stay in each comparison. The later afternoon replay is excluded. Risk bins are 15 seconds and share visits, buses and four dates.','',
'Two follower identities are fixed at the focal bus’s pin: (1) the first already-confirmed different-bus departure after the focal bus’s previous departure from this regulator, with same-day and intervening-stop guards; (2) the nearest backward stop-index position among fresh already-observed other buses. The second is sparse topological order, not metric GPS spacing. Same-stop/tied order yields unknown. The first can coincide with the predecessor in a two-bus loop or after changed ordering. Unknown identities retain the baseline in the raw arm; an arm-specific calibration intercept can also change unknown cases.','',
'Progress, arrival pulses, persistent reached-stop flags, and their interactions with clock phase use only events known at the risk-bin start. Arrival+15s and completion+120s are availability proxies. Additional effects are regularized with L2=10, with stop features supported by at least five training holds on two dates. A separate comparison adds follower effects on top of the fixed, training-only predecessor reached×clock model, checking whether the information is additional. Exact reproduction of that prior model’s raw scores is asserted.','',
'## Identity support','',
'| Identity | Stop | Known / all development holds | Same bus as predecessor | Unknown reasons |','|---|---|---:|---:|---|']
for s in x['support']:
 if s['regime']!='arrival15_clear30_proxy':continue
 z=s['split']['development'];lines.append(f"| {s['identity']} | {s['stop']} | {z['known']} / {z['n']} | {z['sameAsAhead']} | {json.dumps({k:v for k,v in z['reasons'].items()if k!='known'})} |")
lines += ['', '## Every tested family','', 'Mean sequential negative log loss per hold; lower is better. Values are raw, followed by the separately intercept-calibrated value in parentheses. The calibrated result is not a coverage guarantee. “With ahead” includes the already-tested predecessor reached×clock feature before fitting the follower addition.','']
for identity in x['plan']['identities']:
 for regime in x['plan']['regimes']:
  lines += [f'### {identity}; {regime}','','| Follower family | Winchester | Winchester with ahead | Union | Union with ahead |','|---|---:|---:|---:|---:|']
  for arm in x['plan']['arms']:
   cells=[]
   for stop,offset in [(11,'lap_clock'),(11,'lap_clock_ahead'),(121,'lap_clock'),(121,'lap_clock_ahead')]:
    raw=score(identity,regime,stop,offset,arm);cal=score(identity,regime,stop,offset,arm,True)
    cells.append(f"{raw['meanLogLossPerHold']:.4f} ({cal['meanLogLossPerHold']:.4f})")
   lines.append('| '+arm+' | '+' | '.join(cells)+' |')
  lines.append('')
lines += ['## Date and identity-overlap checks','', 'The two clock-interaction families are shown separately; no best stop or best day is selected. Relative improvement compares raw loss to the corresponding baseline for that same group, including the ahead effect where specified. Negative improvement means worse.','', '| Identity | Stop | Baseline | Follower family | All gain | Date gains (Sep 14 / 15 / 16 / 17) | Distinct-follower gain | Same-as-ahead gain |','|---|---|---|---|---:|---|---:|---:|']
regime='arrival15_clear30_proxy'
for identity in x['plan']['identities']:
 for stop in [11,121]:
  for offset in x['plan']['offsets']:
   for arm in ['progress_clock','reached_clock']:
    def gain(group):
     a=score(identity,regime,stop,offset,'baseline',group=group);b=score(identity,regime,stop,offset,arm,group=group)
     return f"{100*(1-b['meanLogLossPerHold']/a['meanLogLossPerHold']):+.1f}% (n={a['n']})" if a and b else 'unavailable'
    lines.append('| '+ ' | '.join([identity,str(stop),offset,arm,gain('all'),' / '.join(gain(d)for d in ['2026-09-14','2026-09-15','2026-09-16','2026-09-17']),gain('distinct_from_ahead'),gain('same_as_ahead')])+' |')
lines += ['', '## Limits and reproducibility','',
'These scores measure one-step departure prediction, not remaining-wait or rider-arrival accuracy. Integrating this time-varying hazard into an ETA needs a causal forecast of future follower progress, including uncertainty and missing/stale observations. Another option is a separately trained remaining-time distribution conditioned directly on the follower’s currently observed state. Neither approach may use the observed future follower trajectory as a forecast input. No production change is justified by a lucky family or a few development dates alone.','',
'The independently audited short and long focal holds remain. No new residual/outlier exclusions are made. Sparse stop evidence, timestamp proxies and changing fleet order limit interpretation; predictive association does not establish that drivers wait for a following bus. Separate raw and calibrated scores, both identity definitions, both timing contracts and all seven families are retained.','',
'Run `OPENBLAS_NUM_THREADS=1 python red-window-data/follower-progress-screen.py`, then `python red-window-data/follower-progress-report.py`. The frozen plan, input hashes, coefficients, per-visit scores and selection reasons are in `follower-progress-plan.json` and `follower-progress-screen.json`. The independent identity and route-reassignment audits are saved alongside them. Input SQLite is read-only.','']
lines[2:2]=[
'**Result:** follower progress adds little at Winchester once predecessor progress is included. At Union, the two clock-interaction families improve raw departure log loss about 1.0–1.2% over lap/clock alone and 1.2–1.4% after including the predecessor. Both follower identity definitions support a small Union signal. This is not a measured ETA improvement, and no coefficients are deployed.', '',
'The gain is score-dependent: after the predecessor model, Union mean per-hold Brier is 0.075169 at baseline, 0.075373 with follower progress×clock and 0.075227 with follower reached×clock (slightly worse). The log-loss gain should not be described as a general probability-calibration improvement.', '',
'The Union signal is stronger when follower and predecessor are different buses: incremental log-loss gains are about 3.2–3.7% across 60 holds. They improve separately on all three dates where this group appears. However, group membership is strongly tied to the date: September 15 has 21 same-bus cases, zero distinct-follower cases and two unknowns. This is suggestive of an operating-regime interaction, not evidence for a causal fleet-size or driver-dispatch rule.', '',
]
lines += [
'## September 15 regression inspection', '',
'The six largest Union per-hold log-loss regressions in the departure-order reached×clock arm after the predecessor offset are visits 51469, 54002, 52633, 52168, 54777 and 53429. All identify the same other bus as both predecessor and follower. Their recorded waits are 550, 30, 410, 510, 470 and 505 seconds: the problem is not confined to extreme durations. Each has a completed non-gap stopped visit and recorded rest evidence. No positive measurement-error evidence justifies removing them; they remain in every score. This is a completed-event inspection, not a new raw-GPS verification. Details are preserved in `follower-sep15-regressions.json`.', '',
'The independent identity audit checks selected follower assignments against latest known anchors from every route: zero reassignment contradictions were found at pin or through the corresponding holds. The independently guarded Winchester count differs by one because the screen accepts an already-observed opposite-stop anchor while the conservative audit also examines completed opposite-stop evidence.', '',
]
(D/'follower-progress-report.md').write_text('\n'.join(lines))
