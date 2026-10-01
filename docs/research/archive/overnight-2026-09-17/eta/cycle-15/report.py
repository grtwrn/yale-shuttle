from pathlib import Path
import json,datetime
O=Path(__file__).resolve().parent;E=O.parent
read=lambda n:json.loads((O/n).read_text())
s,v,d,a,r,j,z,t=[read(n) for n in ['score.json','verification.json','decision-summary.json','largest-case-audit.json','rider-outcome-summary.json','join-audit.json','semantic-verification.json','transition-audit.json']]
c=s['counts'];m=s['metrics']['all'];now=datetime.datetime.now(datetime.timezone.utc).isoformat();base=read('PLAN.json')['base'];worst=s['largestPointRegressions'][0]
rows=[]
for route in [1,2,3,8,9,10,15,19]:
 g=s['metrics']['route:'+str(route)];x,y=g['current'],g['canonical'];rows.append(f"| {route} | {x['n']:,} | {x['MAE']:.3f} → {y['MAE']:.3f} | {x['WIS']:.3f} → {y['WIS']:.3f} | {x['early']}/{x['late']} → {y['early']}/{y['late']} |")
regrows=[]
for x in s['largestPointRegressions'][:5]:regrows.append(f"| {x['route']} / #{x['bus']} | {x['sourceId']} → {x['targetId']} | {x['occurrence']} | {x['truthSec']:.3f} | {x['current'][0]} → {x['canonical'][0]} | +{x['errorIncrease']:.3f} |")
paired=r['paired'];rm=r['sameTripMetrics'];jc=j['counts'];sem=z['rawWireAndPhysicalOccurrenceChecks']
summary=f"The fixed cache diagnostic has no demonstrated rider accuracy gain in the first 6,000 fleet polls. Corrected {c['scored']:,}-row mean error is {m['current']['MAE']:.3f} → {m['canonical']['MAE']:.3f} seconds; {paired['sameConnectedTrip']:,} same-trip option comparisons slightly worsen ({rm['current']['MAE']:.3f} → {rm['canonical']['MAE']:.3f} seconds). Occurrence labels are corrected and original scores preserved. Research only; application files, HEAD and index unchanged."
report=f'''# Full-fleet cache diagnostic: verified first slice

{summary}

The largest retained scored point regression is +{worst['errorIncrease']:.0f} seconds. An all-poll upper-bound change reaches +5,791 seconds. Restart repeatability alone does not establish acceptable ETA behavior. No application change is proposed.

## Scope and baseline

This completes the interrupted round's first 6,000 of 20,199 chronological fleet polls: September 16, 2026, 11:04:43.166–19:25:49.204 UTC, eight daytime routes 1/2/3/8/9/10/15/19. Actual ServerEta captured {c['currentRows']:,} current and {c['canonicalRows']:,} diagnostic arrival rows in separate processes with the original fleet order. The remaining night routes and later Red date are unfinished. All dates are reused evaluation, not a fresh holdout.

Baseline is {base}, also the local origin/master at verification. Current release behavior is enabled in both arms. Inputs, pre-September-14 marginals, pre-September-10 release fit and the existing causal refresh are identical. There is no new fit or coefficient search. The diagnostic differs only by the frozen kernel-mean rounding; research-only cache access permits exact continuation. Recorded GPS is original; collector pin/lap/at-stop flags are reconstructed, not recovered first-publication receipts.

PLAN.json froze the initial full archive goal. RESOURCE_AMENDMENT.json selected the first 6,000 chronological polls based on measured runtime before scoring. Initial unbounded partial files are preserved and not counted as complete runs. This recovery invocation reused saved forecasts; it did not restart the completed fleet or Red replay.

## Measurement corrections and verification

1. The original cycle-14 shallow-reference state proof is superseded by review-round-13/immutable. This capture serializes each poll immediately and hashes immutable minute snapshots with a no-future-timestamp assertion.
2. A standing/repositioning forecast can price from a different route position than its tracked lead. The physical origin is inferred uniquely from all served stop/hop rows; {c['currentIndexUnresolved']}/{c['canonicalIndexUnresolved']} current/diagnostic rows remain unmapped. All eight repaired ring sequences, including repeated positions on routes 8/9/10, match the database topology.
3. Initial SQL verification wrongly rejected NULL transition provenance. Visit 58857 has an exact recorded arrival but no departure and how=NULL. Explicitly allowing NULL fixes the checker while retaining the arrival; it does not invent a departure. See VERIFICATION_CORRECTION.md and preserved failed logs.
4. A separate semantic audit found that post-departure zero-hop rows could be matched to the next lap, shifting the following row one lap too far. The final rule keeps zero-hop source occurrence zero even after recorded departure, starts a full-lap first row at the next return, and leaves positive sub-lap same-source identity unresolved. Each arm is resolved separately. This corrects {jc['retargetedToCorrectPhysicalOccurrence']} target labels, adds {jc['newlyScorableAfterIdentityCorrection']} now-resolvable rows, leaves {jc['identicalTruth']:,} truths unchanged, and moves {jc['previouslyScoredNowUnresolvedOrPast']:,} initially scored rows to unresolved/past accounting. No forecast or historical row was removed.
5. A cumulative physical-hop guard requires the actual recorded target at the intended traversal distance, so a skipped target cannot borrow a later lap. It changes {jc['additionalCumulativeHopGuardChangedLabels']} further labels in this slice; it is a verified guard, not an additional observed failure.

Initial and intermediate outputs are preserved in initial-score-superseded/ and intermediate-ordinal-join/. Only root score.json/connected-pairs.jsonl are final. JOIN_CORRECTION.json and PHYSICAL_HOP_CORRECTION.json were written before their respective rescoring. This is a correction to replay labels, not a production accuracy improvement or a detector-error exclusion.

Direct read-only verification checks {v['scoredTruths']:,} truths, {v['connectedChains']:,} distinct chains and {v['connectedLegUses']:,} leg uses. Independent raw-wire/cumulative-hop verification checks all {sem['current:wireAndCumulativeOccurrence']:,} scored rows per arm. The 16 numerical backward lead transitions have identical timestamps, buses and endpoints in both arms; they remain documented baseline events, not silently treated as correct physical behavior.

Both native-cache continuations 5900:6000 reproduce 100/100 wire/tracking polls plus eight immutable full-state minute digests per arm. This verifies research chunking, not an additional production checkpoint fix. Current-arm native state must include its first-caller kernel cache. Ordinary diagnostic production-checkpoint repeatability remains the earlier independent result.

## Corrected connected outcomes

First poll per UTC minute, ten-minute per-bus warmup. These are dependent repeated forecasts across {v['sources']:,} source visits and {v['targets']:,} target visits, not independent trials. Both physical-position occurrences, passed/stopped strata, route-level tails and stability remain in score.json.

| Route | Paired minute rows | MAE seconds | WIS | Early/late misses |
|---|---:|---:|---:|---:|
'''+ '\n'.join(rows)+f'''

Pooled MAE is {m['current']['MAE']:.3f} → {m['canonical']['MAE']:.3f}; median {m['current']['median']:.3f} → {m['canonical']['median']:.3f}; p90 {m['current']['p90']:.3f} → {m['canonical']['p90']:.3f}; WIS {m['current']['WIS']:.3f} → {m['canonical']['WIS']:.3f}. These tiny mixed changes do not establish accuracy gains or nominal interval coverage.

Availability is explicit in unpaired-arrivals.jsonl, not summarized as an improvement from the 20-row net difference. There are {c['unscored:source-target-identity-unresolved']:,} minute rows with unresolved same-source identity and {c['postArrivalTransition']:,} post-arrival transition rows. All {c['largeBandChanges']:,} raw band changes above 60 seconds remain; {a['connectedNonnegative']:,} have connected nonnegative outcomes and {a['unknownTruth']:,} lack an established target truth. The largest high-bound change is route 9/#122, poll 2738, target physical index 18: high 5 → 5,796 seconds, point 4 → 475, recorded target 880.193 seconds later. The two arms' pricing origins and hop counts differ. This does not justify choosing one large tail as physically correct.

Raw negative lower bounds ({c['currentNegativeLow']:,}/{c['canonicalNegativeLow']:,}) remain in the files; only scoring uses the existing rider adapter's zero normalization. Upward/downward >60-second jump counts are retained by route and arm, with mixed changes.

| Route / bus | Source → target visit | Occurrence | Actual remaining seconds | Point seconds | Error increase |
|---|---|---:|---:|---:|---:|
'''+ '\n'.join(regrows)+f'''

largest-case-audit.json retains exact records, connected legs and surrounding GPS for the largest tails/regressions. transition-audit.json adds {t['count']} focal cases across {t['uniquePolls']} distinct polls, with both actual wire occurrences, tracking, inferred pricing origin and original GPS/reconstructed flags distinguished. No measurement-error exclusions are made. Previously audited Red cases and the 38 pickup uncertainties remain unchanged in earlier evidence; this earlier-day slice does not newly certify cases outside its range.

## Rider decisions and their actual trips

The exact current extracted numerical memo, planner, pickup projection and ranking run on the fleet wire for the previously declared stationary Red-origin geometries: {d['pairedDecisions']:,} paired decisions in {d['sessions']} sessions. No selected boarding vehicle, visible order, caution, destination availability or synthetic 15/30/45-minute point-deadline outcome changes. Fourteen selected-pickup metadata records change their relative-hop/visit description; those are not 14 bus switches. This is a numerical-path check, not a browser test.

RIDER_OUTCOME_PLAN.json froze all saved shuttle options before outcome matching. Each of {paired['sameConnectedTrip']:,} complete paired option-polls connects to the same actual boarding and target visits in both arms. {paired['unresolvedAtLeastOne']:,} paired option-polls remain unresolved, with identical reason counts in each arm. Independent database checks validate 48,072 ride-leg uses per arm and require the exact selected physical ride displacement, including repeated stops.

Recorded target arrival plus modeled final walk has mean absolute error {rm['current']['MAE']:.3f} → {rm['canonical']['MAE']:.3f} seconds. Walking is hypothetical; the {paired['modelAccessBeforeRecordedDeparture']:,} access-before-recorded-departure cases do not prove actual boarding. Passed endpoints and raw-current transitions remain explicitly labeled. There is no observed rider-choice or calibrated deadline-probability claim.

## Commands, completion and limits

All commands below ran successfully in this recovery invocation unless explicitly labeled inherited:

- `flock -w 900 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/heavy.lock bash -c '<checked sequential score.py, verify_score.py, audit_tails.py, rider_outcomes.py commands>'` — exit 0; exact expanded command is in commands.md. Final logs: score-final.log, verification-final.log, tail-audit-final.log, rider-outcomes-final.log.
- `python3 {O}/verify_semantics.py` — exit 0; raw-wire/cumulative occurrence, identical backward-event identities and connected rider database checks.
- `python3 {O}/audit_join_changes.py` — exit 0; every initial/final identity change accounted for, originals retained.
- `python3 {O}/audit_transitions.py` — exit 0; paired transition windows and GPS context.
- `python3 {O}/compare_resume.py` — exit 0; both 100-poll continuations reproduced exactly from saved outputs.
- `python3 -m py_compile {O}/score.py {O}/verify_score.py {O}/rider_outcomes.py {O}/verify_semantics.py` — exit 0.
- `python3 {O}/finish.py` — final integrity command; its result is final-integrity.json, created after this report.

The inherited locked run.sh capture completed before interruption; this invocation verified its saved outputs rather than rerunning it. Earlier failed/partial harness evidence remains. No application unit tests, typechecks, Vite build, full suite, browser, staging, CI or deployment were run or claimed. No dependencies or screenshots were added. No DB writes, watcher changes, source-control/publication actions or other-team file changes.

Next: independent review of final semantic labels, tails, connected rider matching and continuation. Then resume the same frozen arms from poll 6000 in a bounded chronological chunk (suggest 6000:9000), including remaining routes/date before any application proposal. Do not cold-replay the completed prefix, tune a new arm, cap tails or discard regressions. Ambiguous current-versus-next source identities are an explicit remaining measurement task, not filled with guessed labels.
'''
report += '\nFinal decision-field audit: verify_decisions.py independently reproduces all 2,036 comparisons using journeyArrival.catchRisk. The interrupted script used an absent top-level catchRisk field; its original is retained, corrected script and direct check confirm zero actual caution changes. No saved forecast/options changed.\n'
(O/'RESULTS.md').write_text(report)
(O/'REVIEW_REQUEST.md').write_text('Research-only independent review requested; no application diff.\n\nRead RESULTS.md, PLAN/RESOURCE_AMENDMENT, JOIN_CORRECTION, PHYSICAL_HOP_CORRECTION, RIDER_OUTCOME_PLAN and RESUME. Review final root outputs only; initial-score-superseded and intermediate-ordinal-join preserve superseded labels. Independently check zero-hop/full-lap/current-source ambiguity, cumulative physical distances on repeated routes, SQL NULL endpoint semantics, exact both-arm wire attribution, retained unpaired/unknown/tail rows, complete chosen boarding-to-target chains and the native-cache continuation. No full completed replay rerun is required unless a concrete defect warrants it. Verify all 125 retargeted rows and keep the remaining 9,261 minute identity uncertainties visible. No ETA accuracy, nominal coverage or publication approval is requested.\n')
(E/'PROGRESS.md').open('a').write('\n## '+now+' — cycle15 recovered slice complete, research only\n\n'+summary+'\n\nFinal root outputs supersede preserved initial/intermediate labels:125target corrections,187newly resolvable,1323now unresolved/past; physical-hop guard changes no additional labels. Independent checks pass182918raw-wire/occurrence truths per arm,86683chains/1920044leg uses,4925same-trip outcomes/48072rideleguses per arm, and identical16backward event identities. Largest scored regression69sec; largest raw high change5791sec; all5021large bands and9261same-source identity uncertainties retained. Native100/100continuations reverified. Commands/results and limits in cycle15/RESULTS.md; no app/tests/types/build/browser/publication claim. All owned sessions collected; no owned process/browser/server/lock, watcher untouched. Next independent review, then bounded frozen continuation6000:9000.\n')
cp=f'''# Latest checkpoint — cycle15 recovered and verified, {now}

{summary}

Start cycle-15/RESULTS.md, REVIEW_REQUEST.md and RESUME.md. HEAD/base {base}; checkout/index unchanged. Do not restart the completed first6,000fleet polls or previous Red/export/model experiments. Current/canonical frozen bundles plus arm-matched native checkpoint6000.v8 preserve the global first-caller cache; both5900:6000continuations independently recompare100/100with8immutable minute digests each. Next bounded capture suggested6000:9000under heavy.lock, using copied frozen bundles/checkpoints in a new own cycle; do not rebuild a different baseline silently.

Final outputs are cycle15 root score.json/connected-pairs.jsonl/rider-outcome-summary.json. Initial and intermediate labels are preserved under explicitly superseded directories. Final semantic rules: unique pricing origin from all wire hops; physical repaired/repeated ring indices; zero-hop latest-source keeps current occurrence after recorded departure; full-lap first row targets next return; positive sub-lap same-source identity unresolved; exact cumulative connected distance prevents borrowing later laps for skipped visits. SQL NULL how is permitted for an exact arrived endpoint, never inventing departure. Read correction JSONs/verification note before reusing scripts.

Verification:182918truths per arm with actual wire and cumulative hop checks;86683chains/1920044leguses;4925same actual rider trips/48072rideleguses per arm. 3277paired option-polls unresolved. Mean endpoint improvement0.010sec and rider error+0.044sec do not support release. Largest genuine final point regression69sec; raw high-band delta5791sec. All5021large changes,9261same-source unknown minute rows,negative bounds,unpaired rows and identical16baseline backward transitions retained. The old75secBlue regression used the wrong second-return label; corrected source59329example is in semantic-verification/join-audit, original preserved. Older separately audited Red regressions and38pickup unknowns unchanged, not newly certified outside this slice.

No app/source/control/controller/other-team modifications, new screenshots/dependencies, DBwrites or watcher changes. No application tests/types/Vite/browser/staging/CI/deploy run. Exact successful commands and failures are in RESULTS.md/commands.md/logs. All owned commands finished and shared lock released. Current UX06:07map gesture repair has no ETA interface dependency.

Next reviewer audits semantic and rider joins plus tails and cache continuation; next builder continues frozen chronology. Remaining night routes/laterRed date and ambiguous source identities stay outstanding; no one-line production cache change yet.

Earlier checkpoints follow unchanged.

'''
p=E/'CHECKPOINT.md';p.write_text(cp+p.read_text())
(E/'BACKLOG.md').open('a').write('\nRound15 task6 **[First full-fleet slice complete; corrected outcome semantics and rider chains verified; research only]**: cycle-15/RESULTS.md. '+summary+' Remaining archive starts6000; use frozen native-cache continuation, preserve9261identity-unknown minute rows and all large tails. Independent review next.\n')
(E/'MORNING_SUMMARY.md').open('a').write('\n## Latest ETA result — '+now+'\n\n'+summary+' The diagnostic remains artifact-only: largest final scored regression69seconds and a raw upper-bound change5791seconds remain. No code from this round is ready to deploy. Restart reproducibility is established separately; full remaining-route validation is unfinished. Final evidence:cycle-15/RESULTS.md, semantic-verification.json and rider-outcome-summary.json.\n')
print(summary)
