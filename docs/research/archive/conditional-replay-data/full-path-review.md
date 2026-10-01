# Full-path conditional-hold review

**Keep this as an experiment. The corrected candidate improves the Winchester waiting forecasts, but the full-route version also causes a systematic later bias on longer Union-to-Division forecasts. That is different from accepting a few worse outliers.** Narrowing an overbroad interval is a legitimate benefit; increased misses alone do not invalidate a candidate. Here, the longer-route median error, MAE, and proper score all worsen, on both recorded dates. No production change is justified by this version alone.

Reviewed the frozen `raw-pairs.jsonl`, `raw-meta.json`, `raw-score.json`, `raw-unclamped-score.json`, `raw-feed.mts`, `replay-fast.mts`, normalized prior construction, and the relevant collector/filter/pricing code. The independent [audit script](full-path-review.py) checks all 45 checkpoint groups per available contrast, recomputes MAE/WIS/tail counts, preserves file hashes, and saves [numerical evidence](full-path-review-audit.json). Application and production files were not changed.

## Scope and scoring

The raw experiment contains **12,654 polls, 48,994 paired outputs, and 36,516 identical baseline/candidate belief checks**. It uses September 16 and partial September 17 Red observations, the frozen September 14 prior tables, and parameter version `fit-2026-09-15`. The candidate is `normalized-live-clock-patch.json` with 136 Winchester and 150 Union prior positive holds. It preserves the baseline zero-duration atom; the filter/hazard is unchanged. This is a retrospective component-pricing comparison, not independently calibrated rider probabilities.

The primary reviewed score is **`raw-score.json`, minimum recorded warm duration 600 seconds**. `raw-score-rider.json` is an earlier 300-second sensitivity file. After the 600-second cutoff, 47,812 forecast rows remain. The exact connected-chain scorer finds 163 source-target journeys, but actual checkpoint evidence covers **78 source visits, 94 distinct target visits, and 1,495 checkpoint rows**. Repeated elapsed checkpoints and the Union/Winchester contexts can share a target arrival; these are not 1,495 independent rides. Neither date supplies an independent large-sample validation set. Union-to-Rosenkranz is absent because the replay excludes target occurrences at 20 or more stops ahead.

Scoring matches the rider adapter's nonnegative remaining times. The previous rejection of finite negative wire lower bounds was fixed in `red-window-data/full-path-score.py`: 2,737 baseline and 1,809 candidate lower bounds are clipped to zero, with raw values retained. Original finite/order checks remain. The fast replay stores unrounded predictions; production rounds each field, a remaining difference of at most 0.5 seconds per endpoint/point.

WIS is correct for the point treated as a median and one nominal central 80% interval: `(0.5*absolute_error + 0.1*interval_score)/1.5`, with tenfold penalties beyond either endpoint. This evaluates the requested quantile forecasts; it does not make the floor-adjusted output a validated CDF. `early` means truth below the lower bound; `late` means truth above the upper bound. Point overprediction is the direction in which the bus can arrive sooner than a rider expects. Actual missed connections have not been simulated here. Target arrival is a detector/GPS proxy, and passed stops are not proof a rider could have boarded; stopped-target sensitivity is included in the score files.

## Typical gains and systematic losses

Baseline → candidate, with the current display floors retained; seconds throughout:

| Source → target; checkpoint | n | MAE | Median absolute error | Mean width | WIS | Early / late misses |
|---|---:|---:|---:|---:|---:|---:|
| Winchester → Division; pin +0 s | 48 | 103.8→89.6 | 88.5→69.9 | 774.0→610.4 | 86.2→70.6 | 0/0→1/0 |
| Winchester → Division; pin +60 s | 47 | 224.2→180.1 | 205.6→161.3 | 569.0→514.8 | 113.7→97.3 | 0/2→0/5 |
| Winchester → Division; pin +180 s | 31 | 200.0→140.5 | 166.3→143.0 | 513.3→496.2 | 100.9→81.2 | 0/0→0/2 |
| Winchester → Division; departure +0 s | 48 | 33.8→42.1 | 30.1→36.6 | 358.5→296.8 | 35.2→33.8 | 0/0→0/0 |
| Winchester → Rosenkranz; pin +60 s | 45 | 159.2→131.5 | 127.7→92.9 | 821.0→735.6 | 107.8→93.3 | 0/0→0/1 |
| Union → Division; pin +0 s | 30 | 201.4→250.2 | 144.1→228.6 | 1015.8→854.3 | 147.3→155.6 | 2/1→2/1 |
| Union → Division; departure +0 s | 30 | 212.5→265.7 | 171.7→251.3 | 795.9→686.4 | 140.2→157.0 | 3/1→5/1 |

Winchester-to-Division improves MAE and WIS on both dates at the first three standing checkpoints. At +60 seconds, 32 of 47 forecasts improve absolute error by more than one second and seven worsen. This is useful evidence, although significant underprediction remains during the hold: mean signed error is still approximately −167 seconds in the candidate at that checkpoint.

Union-to-Division shows the opposite pattern: at pin +0, 20 of 30 forecasts get worse and nine improve by more than one second; 29 move later. At departure +0, 24 worsen and five improve. MAE and WIS worsen separately on September 16 and 17. The latter date has only six Union observations here, so its effect size is uncertain; the direction is not driven solely by one rare extreme. Winchester-to-Rosenkranz approaching the hold also generally gets later with worse point error, although narrowing often offsets that in WIS.

## Floors and temporal behavior

The pricing change does not resolve the standing-mixture floor mechanism. Comparing unclamped baseline with unclamped candidate still shows essentially the same Union deterioration. Removing floors also changes the Winchester tradeoff: at +180 seconds, unclamped MAE is 74.4→74.5 seconds, whereas retained-floor MAE is 200.0→140.5. Part of the apparent retained-floor improvement is interaction with the floor's earlier low value, rather than a uniformly better current marginal forecast.

Unclamped candidate Winchester-to-Division departure +0 MAE is 87.4 seconds, versus 42.1 with its floor retained; point overprediction above 120 seconds occurs in 10/48 unclamped cases versus 1/48 retained-floor cases. This is an observed departure forecast penalty, not a count of missed riders.

With floors retained, upward absolute-arrival-time jumps exceeding 60 seconds increase from **16 to 29** for Division (13→23 distinct target visits) and **28 to 41** for Rosenkranz (19→26 visits). Division jumps above 180 seconds increase 0→5. They are rare among adjacent polls but are not confined to one bus visit. Removing floors produces many more upward jumps in both arms. These counts condition on observed connected journeys, use identical neighboring timestamps, and deduplicate repeated upstream source contexts. Changes in inferred position may explain some jumps; they are not all avoidable numerical noise.

## Replay fidelity and remaining clock mismatch

The new raw feed is a substantial improvement over the earlier GPS replay: it uses real `stepManyWithVisits`, `Collector.updateLivePositions`, and **legacy dwell events** for `noteDeparture`, with `lapAges` and the actual naive-UTC wire clocks. Modern visit outcomes are not used as live lap updates. No future outcome labels are consumed to produce the raw observations. `raw-meta.json` verifies the corrected patch and reports 1,808 successful target/full-server parity checks.

There are important limits:

- The raw replay starts without collector history seeds. Ten minutes of observations do not recover a missing prior lap. At the first standing checkpoint, the current source's lap exists for 42/48 Winchester and 28/30 Union cases; fallback is part of the result. September 14/15 local raw archives have zero Red rows, so the apparent four-day historical request cannot be fully replayed from those archives.
- The target-scoped engine's parity check clones its state **after** its own step and compares same-poll output. It verifies that output against the real function at sampled polls, not a separately evolving full-server trajectory. It also evicts absent entries at 300 seconds versus production's 600 seconds. The observed raw run has only its initial and overnight global resets; quantify per-bus disappearance before treating eviction differences as important. Red-only replay omits possible cross-route name contention and lacks first-observation stationary-history seeding.
- Correcting the previous departure to legacy `arrivals` fixes only half the covariate clock contract. **The prior table is pinned-to-departure, while live pricing's `clockOrigin()` is the filter's `restSince`.** The source comment describing the old visit source is misleading. At Winchester pin +0, among 15 already-rested observations served at Winchester, rest origin precedes the pin by a median 30 seconds. Four cases differ by 320–540 seconds: source IDs **59602, 59805, 65237, 66278**. Three have long anchor-to-pin delays of 340, 525, and 470 seconds; these are not duplicate short visits. The filter can charge a long pre-pin rest that is absent from the duration label. Source65237 needs closer raw inspection. Neither the old modern-departure component nor the corrected-previous-departure patch is an exact reconstruction of the full live conditioning contract.
- Prior completion cutoffs and a weekend gap avoid the earlier direct inclusion of test visits, but legacy records still lack exact historical ingestion availability. The available evidence does not establish prospective calibration. The new `lapQ/lapQn` fields are also absent from `eta/index.ts`'s dwell cache fingerprint. Distinct segment objects isolate this experiment; any production implementation must include those fields in cache identity.

## Recommended next experiments

1. **Attribute current-rest versus future-hold effects before modifying coefficients.** Hold the same feed/filter/floors and separate normalized pricing for an ongoing hold from future holds, recording the projected lap and its factor. This is a diagnostic decomposition, not a proposed abrupt arrival-only UI switch. The Union-to-Division path includes a future Winchester hold; the later bias remains after Union departure. Determine whether its future hold center, predicted lap, or accumulated intervening times cause it. A future lap estimated from nominal durations is not the realized lap used in training. Sample-wise path/lap conditioning is a testable next hypothesis; it must preserve stop/pass mass and evaluate joint tail error.
2. **Align the duration origin before claiming conditional precision.** Reconstruct the filter rest origin causally from earlier raw recordings, or explicitly model pre-pin rest/approach and pinned hold as separate quantities. Keep the current label clock and source-selection differences visible. Do not silently substitute anchor time, delete short holds, or tune the model to the four highlighted examples.

Freeze any resulting variant and assess the same route/horizon/checkpoint metrics, date/visit-balanced errors, stopped-target sensitivity, departure +0/+5/+15/+30/+60 response, and rider catch outcomes. Confirm on newly accumulated dates after independent calibration; all currently inspected dates are development evidence. The present results justify continued targeted investigation and support the user's willingness to trade some rare errors for better typical forecasts. They do not justify accepting a reproducible typical-error regression on a whole longer-trip context.
