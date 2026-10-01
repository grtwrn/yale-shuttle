# Full-fleet cache diagnostic: verified first slice

The fixed cache diagnostic has no demonstrated rider accuracy gain in the first 6,000 fleet polls. Corrected 182,918-row mean error is 269.463 → 269.453 seconds; 4,925 same-trip option comparisons slightly worsen (352.172 → 352.216 seconds). Occurrence labels are corrected and original scores preserved. Research only; application files, HEAD and index unchanged.

The largest retained scored point regression is +69 seconds. An all-poll upper-bound change reaches +5,791 seconds. Restart repeatability alone does not establish acceptable ETA behavior. No application change is proposed.

## Scope and baseline

This completes the interrupted round's first 6,000 of 20,199 chronological fleet polls: September 16, 2026, 11:04:43.166–19:25:49.204 UTC, eight daytime routes 1/2/3/8/9/10/15/19. Actual ServerEta captured 4,002,512 current and 4,002,532 diagnostic arrival rows in separate processes with the original fleet order. The remaining night routes and later Red date are unfinished. All dates are reused evaluation, not a fresh holdout.

Baseline is 98e535b99649e74ca599d2e33bcfdc46df83d30d, also the local origin/master at verification. Current release behavior is enabled in both arms. Inputs, pre-September-14 marginals, pre-September-10 release fit and the existing causal refresh are identical. There is no new fit or coefficient search. The diagnostic differs only by the frozen kernel-mean rounding; research-only cache access permits exact continuation. Recorded GPS is original; collector pin/lap/at-stop flags are reconstructed, not recovered first-publication receipts.

PLAN.json froze the initial full archive goal. RESOURCE_AMENDMENT.json selected the first 6,000 chronological polls based on measured runtime before scoring. Initial unbounded partial files are preserved and not counted as complete runs. This recovery invocation reused saved forecasts; it did not restart the completed fleet or Red replay.

## Measurement corrections and verification

1. The original cycle-14 shallow-reference state proof is superseded by review-round-13/immutable. This capture serializes each poll immediately and hashes immutable minute snapshots with a no-future-timestamp assertion.
2. A standing/repositioning forecast can price from a different route position than its tracked lead. The physical origin is inferred uniquely from all served stop/hop rows; 0/0 current/diagnostic rows remain unmapped. All eight repaired ring sequences, including repeated positions on routes 8/9/10, match the database topology.
3. Initial SQL verification wrongly rejected NULL transition provenance. Visit 58857 has an exact recorded arrival but no departure and how=NULL. Explicitly allowing NULL fixes the checker while retaining the arrival; it does not invent a departure. See VERIFICATION_CORRECTION.md and preserved failed logs.
4. A separate semantic audit found that post-departure zero-hop rows could be matched to the next lap, shifting the following row one lap too far. The final rule keeps zero-hop source occurrence zero even after recorded departure, starts a full-lap first row at the next return, and leaves positive sub-lap same-source identity unresolved. Each arm is resolved separately. This corrects 125 target labels, adds 187 now-resolvable rows, leaves 182,606 truths unchanged, and moves 1,323 initially scored rows to unresolved/past accounting. No forecast or historical row was removed.
5. A cumulative physical-hop guard requires the actual recorded target at the intended traversal distance, so a skipped target cannot borrow a later lap. It changes 0 further labels in this slice; it is a verified guard, not an additional observed failure.

Initial and intermediate outputs are preserved in initial-score-superseded/ and intermediate-ordinal-join/. Only root score.json/connected-pairs.jsonl are final. JOIN_CORRECTION.json and PHYSICAL_HOP_CORRECTION.json were written before their respective rescoring. This is a correction to replay labels, not a production accuracy improvement or a detector-error exclusion.

Direct read-only verification checks 182,918 truths, 86,683 distinct chains and 1,920,044 leg uses. Independent raw-wire/cumulative-hop verification checks all 182,918 scored rows per arm. The 16 numerical backward lead transitions have identical timestamps, buses and endpoints in both arms; they remain documented baseline events, not silently treated as correct physical behavior.

Both native-cache continuations 5900:6000 reproduce 100/100 wire/tracking polls plus eight immutable full-state minute digests per arm. This verifies research chunking, not an additional production checkpoint fix. Current-arm native state must include its first-caller kernel cache. Ordinary diagnostic production-checkpoint repeatability remains the earlier independent result.

## Corrected connected outcomes

First poll per UTC minute, ten-minute per-bus warmup. These are dependent repeated forecasts across 3,045 source visits and 3,885 target visits, not independent trials. Both physical-position occurrences, passed/stopped strata, route-level tails and stability remain in score.json.

| Route | Paired minute rows | MAE seconds | WIS | Early/late misses |
|---|---:|---:|---:|---:|
| 1 | 56,353 | 257.657 → 257.635 | 158.531 → 158.522 | 8225/743 → 8227/745 |
| 2 | 36,671 | 444.973 → 444.947 | 285.894 → 285.880 | 9207/5101 → 9208/5104 |
| 3 | 49,467 | 187.245 → 187.274 | 125.673 → 125.692 | 1662/2456 → 1671/2453 |
| 8 | 17,832 | 167.304 → 167.359 | 127.803 → 127.833 | 151/485 → 148/483 |
| 9 | 9,941 | 366.961 → 366.973 | 256.858 → 256.884 | 2432/270 → 2432/270 |
| 10 | 6,251 | 136.899 → 136.272 | 106.687 → 106.461 | 122/199 → 121/196 |
| 15 | 5,400 | 275.530 → 275.920 | 199.638 → 199.790 | 217/334 → 219/333 |
| 19 | 1,003 | 214.253 → 213.863 | 155.400 → 155.034 | 6/116 → 6/114 |

Pooled MAE is 269.463 → 269.453; median 182.119 → 182.264; p90 626.340 → 626.419; WIS 176.952 → 176.950. These tiny mixed changes do not establish accuracy gains or nominal interval coverage.

Availability is explicit in unpaired-arrivals.jsonl, not summarized as an improvement from the 20-row net difference. There are 9,261 minute rows with unresolved same-source identity and 2,661 post-arrival transition rows. All 5,021 raw band changes above 60 seconds remain; 1,832 have connected nonnegative outcomes and 3,189 lack an established target truth. The largest high-bound change is route 9/#122, poll 2738, target physical index 18: high 5 → 5,796 seconds, point 4 → 475, recorded target 880.193 seconds later. The two arms' pricing origins and hop counts differ. This does not justify choosing one large tail as physically correct.

Raw negative lower bounds (16,825/16,826) remain in the files; only scoring uses the existing rider adapter's zero normalization. Upward/downward >60-second jump counts are retained by route and arm, with mixed changes.

| Route / bus | Source → target visit | Occurrence | Actual remaining seconds | Point seconds | Error increase |
|---|---|---:|---:|---:|---:|
| 15 / #304 | 57627 → 57634 | 0 | 44.997 | 94 → 163 | +69.000 |
| 15 / #304 | 58203 → 58297 | 0 | 780.071 | 895 → 959 | +64.000 |
| 3 / #309 | 57831 → 58167 | 0 | 2240.275 | 2477 → 2540 | +63.000 |
| 2 / #51 | 59535 → 59711 | 0 | 1511.387 | 1453 → 1390 | +63.000 |
| 2 / #51 | 59535 → 59700 | 0 | 1491.315 | 1420 → 1357 | +63.000 |

largest-case-audit.json retains exact records, connected legs and surrounding GPS for the largest tails/regressions. transition-audit.json adds 24 focal cases across 76 distinct polls, with both actual wire occurrences, tracking, inferred pricing origin and original GPS/reconstructed flags distinguished. No measurement-error exclusions are made. Previously audited Red cases and the 38 pickup uncertainties remain unchanged in earlier evidence; this earlier-day slice does not newly certify cases outside its range.

## Rider decisions and their actual trips

The exact current extracted numerical memo, planner, pickup projection and ranking run on the fleet wire for the previously declared stationary Red-origin geometries: 2,036 paired decisions in 20 sessions. No selected boarding vehicle, visible order, caution, destination availability or synthetic 15/30/45-minute point-deadline outcome changes. Fourteen selected-pickup metadata records change their relative-hop/visit description; those are not 14 bus switches. This is a numerical-path check, not a browser test.

RIDER_OUTCOME_PLAN.json froze all saved shuttle options before outcome matching. Each of 4,925 complete paired option-polls connects to the same actual boarding and target visits in both arms. 3,277 paired option-polls remain unresolved, with identical reason counts in each arm. Independent database checks validate 48,072 ride-leg uses per arm and require the exact selected physical ride displacement, including repeated stops.

Recorded target arrival plus modeled final walk has mean absolute error 352.172 → 352.216 seconds. Walking is hypothetical; the 4,494 access-before-recorded-departure cases do not prove actual boarding. Passed endpoints and raw-current transitions remain explicitly labeled. There is no observed rider-choice or calibrated deadline-probability claim.

## Commands, completion and limits

All commands below ran successfully in this recovery invocation unless explicitly labeled inherited:

- `flock -w 900 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/heavy.lock bash -c '<checked sequential score.py, verify_score.py, audit_tails.py, rider_outcomes.py commands>'` — exit 0; exact expanded command is in commands.md. Final logs: score-final.log, verification-final.log, tail-audit-final.log, rider-outcomes-final.log.
- `python3 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/cycle-15/verify_semantics.py` — exit 0; raw-wire/cumulative occurrence, identical backward-event identities and connected rider database checks.
- `python3 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/cycle-15/audit_join_changes.py` — exit 0; every initial/final identity change accounted for, originals retained.
- `python3 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/cycle-15/audit_transitions.py` — exit 0; paired transition windows and GPS context.
- `python3 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/cycle-15/compare_resume.py` — exit 0; both 100-poll continuations reproduced exactly from saved outputs.
- `python3 -m py_compile /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/cycle-15/score.py /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/cycle-15/verify_score.py /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/cycle-15/rider_outcomes.py /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/cycle-15/verify_semantics.py` — exit 0.
- `python3 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/cycle-15/finish.py` — final integrity command; its result is final-integrity.json, created after this report.

The inherited locked run.sh capture completed before interruption; this invocation verified its saved outputs rather than rerunning it. Earlier failed/partial harness evidence remains. No application unit tests, typechecks, Vite build, full suite, browser, staging, CI or deployment were run or claimed. No dependencies or screenshots were added. No DB writes, watcher changes, source-control/publication actions or other-team file changes.

Next: independent review of final semantic labels, tails, connected rider matching and continuation. Then resume the same frozen arms from poll 6000 in a bounded chronological chunk (suggest 6000:9000), including remaining routes/date before any application proposal. Do not cold-replay the completed prefix, tune a new arm, cap tails or discard regressions. Ambiguous current-versus-next source identities are an explicit remaining measurement task, not filled with guessed labels.

Final decision-field audit: `python3 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/cycle-15/verify_decisions.py` exits0 and independently reproduces all2036saved comparisons. The initial script checked a nonexistent top-level catchRisk field; the corrected script and direct verifier check journeyArrival.catchRisk and confirm zero caution changes. Original script retained; no forecasts/options changed. This check also confirms all14metadata differences,zero boarding-vehicle/ranking/availability/synthetic-deadline differences.
