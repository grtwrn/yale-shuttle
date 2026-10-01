# Statistical review of shuttle arrival estimates, graphs, and evidence

Reviewed September 16–17, 2026. Live implementation: master `fdf350ae058cbcac0df7159696bf2f36519cec9e`. Source checkout: `/home/gwarren/projects/yale-shuttle-watcher/server-eta-2026-09-16`. Read-only examination of application/model code, existing replay JSON/SQLite, and captured production payloads; no application edits, deployments, production writes, or daemon changes. A concurrent local UI change makes historical evidence more prominent; this review does not certify a new implementation.

## Decision

The service has a defensible forecasting foundation, but there is insufficient evidence that its distributions are calibrated or that this is the most accurate available approach. Keeping the live service, warm server state, approximate ETA/window, and candidly labeled observations is reasonable. Do not claim an 80% prediction interval, a validated late-arrival probability, or that the plotted dots describe actual previous buses. Do not promote new model parameters using the existing evaluation pipeline as the sole statistical gate until the validation defects below are fixed.

The user's intended quantity is **time remaining from this bus's current state to the selected pickup stop**. Current state includes its route direction/occurrence, position along the route, whether it is standing, and elapsed standing time. It is not generally the full travel time from the last stop, the time between successive buses, or the error of an earlier ETA. All four quantities are useful, but require different labels and matching rules.

A normal distribution is not required and is often inappropriate: times are nonnegative, layovers have long tails, and uncertain route/rest states can make multiple modes. Remaining uncertainty generally decreases as travel is completed, but need not decrease on every update. A bus still standing after an unexpectedly long rest or a new traffic delay can legitimately increase its remaining-time estimate or uncertainty. A prediction interval concerns the next actual arrival; a confidence interval on an average travel time answers a different question and is unsuitable as the rider's arrival window.

## Prioritized findings

### 1. High: historical dots currently answer a different question from the one the rider requested

**Observed.** `services/shuttle-v2/src/server/arrivalHistory.ts:25` matches a past prediction by bus, target, route, displayed ETA range, and screen surface. Lines 48–74 take actual time after that prediction, with nearby time of day and weekday category. There is no source stop, route occurrence, segment progress, or current rest-state match. `web/src/ArrivalHistory.tsx:42` correctly calls these “Actual waits after similar ETAs”; those data cannot be relabeled “time from the current stop.”

The current endpoint's guard against previous laps, deduplication to one prediction per visit, honest empty states, and dated records are useful. Its 240-visit scan and maximum 24 matches are operationally sensible for a small disclosure, but these are a selected convenience sample, not independent draws from today's conditional arrival distribution. Predictions require somebody or a tester to have opened a supported screen; completed detected stops exclude missing outcomes, some pass-throughs, and sufficiently long waits. Model versions are mixed. A bounded +/-25% forecast range also mixes genuinely different horizons.

**Concrete data.** `arrival-distribution-data-2026-09-16/history-probe-final.json` has 24 Red/48 trips across six dates and seven bus names. Actual wait median is 562.148 s (9.37 min); median actual-minus-predicted is +211.648 s (3.53 min). These are informative records of earlier forecasts, not a validation estimate for the current bus. Nine observations are from one date, September 11. Red/72 has only five matched trips, four on September 11.

**Recommended change.** Separate empirical route-progress evidence from forecast-performance diagnostics. Match historical physical state for the former; retain similar-ETA records as a secondary diagnostic if desired. Never fabricate additional dots to make a small sample look substantial. Show sample count, service dates, source/target, and the exact timing anchor.

**Data trap verified.** Do not repair this by filtering `predictions_log.from_stop_id`: `src/server/predictions.ts:486` reconstructs the earlier prediction timestamp, but line 503 records the collector's current `bus.lastStopId` at ingestion. Delayed browser submissions can therefore have a source stop from a later time.

### 2. High: the full plotted distribution is not calibrated, and the standing clamp alters its statistical meaning

**Observed.** `web/src/eta/arrival.ts:771` computes lead-cluster q10/median/q90; lines 790–798 optionally use a full alternative-state mixture for uncertainty. These are legitimate model calculations. However, lines 818–821 shift every plotted quantile and both interval endpoints downward whenever the never-rise display ceiling binds. This is an intentional stability rule, not conditioning on new evidence. The file documents a known case at lines 594–600 where a ceiling held a 208 s reading while actual remaining time was initially about 615 s. The alternate arming rule remains off at line 615.

`scripts/reestimate-lib.mjs:292` fits only the factor needed to cover truth inside one nominal 10–90 band. `arrival.ts:885` applies that factor to all 50 quantiles. A monotone rescaling still gives a mathematical distribution, but calibrating one interval does **not** calibrate the median, each other percentile, or the chance of beating a class deadline. Where alternative route states exist, the numeric point comes from the lead cluster and may also differ from the full-mixture median. Fifty equal-weight quantile dots are a visualization of this corrected model, not 50 buses, independent observations, or a measure of sample support.

**Rider impact.** A stable but too-early forecast can encourage an unwarranted class-time decision. Conversely, artificially wide bands can make a good shuttle look unusable. No amount of careful dot styling resolves those statistical issues.

**Recommended change.** Keep forecast dots in an optional explanation labeled “Model estimate” until full-distribution validation exists. Do not derive a percentage from the dots or use dot counts as evidence of accuracy. Evaluate the clamp explicitly against a model whose belief/ETA can rise when evidence warrants it. Prefer explainable updates (“Still waiting at 344 Winchester”) and rounding/hysteresis on wording over silently forcing a physical prediction distribution downward. An abrupt removal of the clamp also needs replay validation: previous experiments show real rider tradeoffs, so this review is not recommending an untested model switch.

### 3. High: measured rider-window coverage is below nominal, with an important route-specific regression

**Observed from existing paired artifacts, reproduced read-only.** Compare `server-eta-data/client-*.waits.jsonl` with `final-*.waits.jsonl`, restricting to jointly arrived/shown waits and excluding initial already-at-stop cases, as in `compare-routes.py`.

| Replay | Paired waits | Coverage before -> after | Other evidence |
|---|---:|---:|---|
| Sep 10, four routes | 140 | 75.7% -> 70.0% | p90 worst displayed jump 170 -> 110 s; median initial width 436 -> 404 s |
| Sep 16, Red | 66 | 72.7% -> 72.7% | p90 worst jump 170 -> 65 s; median width 611 -> 449 s |

Sep 10 breakdown: Blue Day 34/53 -> 29/53 covered (64.2% -> 54.7%); 24/53 final cases arrive **after** the upper bound and none before the lower bound. Red 44/47 -> 41/47 (93.6% -> 87.2%); Green 14/19 unchanged; Purple 14/21 unchanged. Today's Red has 48/66 covered and 18/66 after the upper bound. This does not prove permanent route-wide calibration, but it is a concrete concern for riders trying to reach class.

The 140 waits share only two start times and 12 arriving buses. The 66 waits share three start times and three buses. They are not 140 or 66 independent calibration trials. The historical comparison also uses September 15 model parameters and reconstructed history, so it is a paired release comparison rather than an untouched historical calibration holdout. These limitations prevent a defensible narrow confidence interval around the percentages.

**Recommended change.** Report accuracy, stability, coverage, interval width, and late/early miss rates together, by route and horizon. The improvement in jumps is real for these cases; “no ETA regressions” is false. Before stronger class recommendations, specifically investigate Blue Day's upper-tail misses and Red's long-rest cases.

### 4. High: the nightly validation pipeline does not provide the advertised untouched out-of-time check

Four concrete source issues require correction before using this pipeline to certify new parameters:

1. **Training overlaps the test date.** `scripts/reestimate-params.mjs:317` takes the latest archived counting window, including the latest day; lines 324–329 fit scalar emissions/hazards on it. Lines 342–355 then call that latest day “held out.” It is held out from the conformal factor fit, but not from all model fitting.
2. **The check date is used for selection.** `reestimate-params.mjs:378` and 391 compute effects on that day, and `scripts/reestimate-lib.mjs:437` and 460 select per-route/per-horizon parameters using those outcomes. It is a tuning/validation set, not a final untouched test set. The later pooled promotion comparison does not undo this reuse.
3. **Time-travel loaders can see future completed outcomes.** `src/calibrator/calibrator.ts:374`, 409, 444, and 475 bound visit/leg start times by the cutoff but do not also bound their completion times. Read-only SQL on `server-eta-data/history.db` at Sep 10 00:00 ET found five selected stopped visits and one leg completing after that cutoff; `red-eta-data/replay-lap.db` at Sep 16 midnight found two visits and one leg. The count is small, but the “available as of this time” contract is violated. Require the actual outcome-availability timestamp, including any confirmation delay where available.
4. **Replay caches are not tied to model/input identity.** `reestimate-params.mjs:198` and 228 name cached DB/patch/pairs by day and arm; line 246 skips replay when a file already exists. There is no parameter/source/input-content hash in this key. A rerun or next day's overlapping replay can reuse different-parameter or different-code outputs. This is a source-proven invalidation risk; I did not claim a particular production publication used stale files.

There is a further coherence problem: conformal widening is fitted to the champion's raw bands at line 365, and then can be applied alongside changed scalar, route, and horizon corrections. Replaying the challenger is valuable, but does not calibrate that new final model's distribution. Fit the final candidate first, calibrate its actual output on a separate later block, and evaluate it on another later untouched block.

`reestimate-lib.mjs:763` allows promotion based on pooled mean daily median error and relative coverage within a noise bound. It has no absolute calibrated-coverage requirement, proper distribution score, route-specific coverage floor, or rider missed-connection gate. A no-worse-than-an-undercovering-champion rule is not a calibrated service standard.

### 5. Medium: conditional modeling is sensible, but dependence and current-state features deserve targeted validation

**Strengths.** Empirical nonnegative stand/drive distributions, partial pooling for thin cells, survival-based elapsed-stand conditioning, route-state uncertainty, deterministic simulation, and persistent server tracking are sensible. `web/src/eta/dist.ts` handles residual standing time explicitly. `journeyArrival.ts:27` selects the same bus's correct forward destination occurrence; it does not incorrectly add pickup and ride marginal quantiles.

**Observed limitations.** The main stand/drive quantile tables are pooled across the 30-day window (`src/calibrator/calibrator.ts:63` and 150–152). Full time-of-day stratification would be too sparse, but smooth/hierarchical time effects remain worth testing. Ordinary moving-leg remainder is total leg duration times remaining fraction (`arrival.ts:513–519`), which cannot fully account for where a traffic hold occurred or recent progress. Different hop terms are independently permuted, so most shared traffic/day/driver dependence is absent. Conversely, prefix construction at lines 257–263 uses `2*s`/`2*s+1` with `s=k%N`, reusing precisely the same term draws at the same position on later laps; that imposes perfect rank dependence for repeated terms across laps. Neither zero dependence across different hops nor perfect dependence across repeated laps is established by data. This is a modeling issue with unmeasured net effect, not proof that changing it will improve every interval.

The `estimated` flag at `arrival.ts:898` only signals the absence of any measured backing under its current rule; it is not a reliability or effective-sample-size score for the whole path. Do not interpret `estimated=false` as well calibrated.

**Covariate evidence.** `red-eta-data/lap-spacing.json` uses three forward-date folds totaling 103 test visits: pooled stop median MAE 187.2 s; lap model 119.1 s; lap plus previous-shuttle timing 120.1 s; lap plus spacing 121.2 s; both additions 123.6 s. The spacing version improves p90 absolute error from 282.9 to 268.6 s while worsening mean error. This is a useful small hypothesis screen, with 295 cases excluded for lacking a fresh watcher frame, not a reason to ship all covariates. Lap time has the clearest current support. Test source-specific layover phase, recent bus progress, route/time effects, and correctly directed headway with shrinkage; demand incremental held-out benefit beyond lap. Headway may help tails or stopping probability even if it does not help the mean.

The existing lap fitter's day-clustered uncertainty and route rollout checks are strengths. Its round-robin day-fold assignment (`src/calibrator/lapFit.ts:286–295`) trains on dates later than some test dates. That tests across-day transfer, not strictly future forecasting; add a forward-date outer evaluation.

### 6. Medium: class UI is useful conditional guidance, not a complete journey probability

`journeyArrival.ts:36–42` shifts the destination bus distribution by a deterministic final walk, while marking uncertain boarding when the rider's walk exceeds the pickup lower bound. `ArriveBy.tsx:79` states the catch assumption, and line 103 explicitly disclaims a validated late-arrival chance. These qualifications are necessary and defensible.

The distribution is still an unconditional bus-destination distribution, not mathematically reweighted on successfully catching that bus; boarding and destination lateness share delays. Walking pace, crossings, accessibility needs, missed boarding, service interruption, and building entry are not random components in this graph. The marker called “Walk estimate” has different uncertainty from the bus graph. The headline “Take [route]” is based on an unvalidated upper endpoint fitting the target; use restrained recommendation wording and keep the conditional statement close to it until end-to-end outcomes are evaluated. A precise “90% likely to make class” would be unjustified.

## Recommended empirical display and its near-term scope

Use one simple horizontal dot/strip plot of **observed durations** in the pickup detail, with current ETA/window above it and the model distribution behind a secondary disclosure. Do not overlay quantities with different timing anchors on one axis. A histogram/density curve is unnecessary for a few dozen trips; dots plus dates reveal the sample honestly.

For a bus standing at source A for elapsed time r, a legitimate historical residual observation is:

`target arrival - (source pinned time + r)`

Include only visits that were still standing at elapsed r, with the same source route occurrence and forward target occurrence, connected by observed legs, and completed before the current snapshot. The live elapsed clock and historical pinned clock must have the same definition; otherwise this is approximate context and must say so. Long stands being retained more often is appropriate survival conditioning for this question, not something to “correct” by discarding them. Observation gaps and complete-case exclusions still need disclosure.

The concurrent independent feasibility analysis in `past-arrivals-first-data/source-journey-feasibility.json` demonstrates the distinction at Red 344 Winchester -> Division / Prospect. For a frozen bus 55.406 seconds into its source stop:

- 75 fully connected comparable source-departure -> target-arrival trips: median 84.923 s, observed range 55.080–209.965 s.
- 74 of those source visits were still standing after 55.406 s: remaining-time median 437.442 s, observed range 89.717–784.748 s.
- These observations span nine dates and eight bus names. They are descriptive feasibility data, not a validated new forecast, and the min/max is not a prediction interval.

Thus “about 1.4 minutes after departure” and “about 7.3 minutes remaining once a bus has already waited roughly a minute” describe different events. Showing the former as “time from now” would be materially misleading.

For a moving bus, exact-position historical matching needs the same directed segment/occurrence and comparable along-route progress, reconstructed from GPS with a maximum time/space interpolation gap. One day's available GPS may yield only a few examples. Show those as sparse facts, or show explicitly anchored **“Past trips from A to B, measured from departure”** as background context. Do not prorate complete historical leg durations into “observed remaining times.” Broadening matches should follow declared tiers and expose the tier, not silently mix route directions, full laps, stopped and moving states.

Useful statistics are observed median, number of trips/service dates, dated examples, and a carefully labeled empirical central spread when sample support is adequate. Avoid confidence intervals on the mean in the rider flow. Keep “Following shuttle: about N minutes later” and last actual arrivals separate: headway is useful for deciding whether to wait for another bus, but does not explain the current bus's remaining travel time.

## Practical validation and release criteria

1. Define targets first: GPS-detected curb arrival, catchable boarding/departure, and class-destination arrival are different outcomes. Preserve service failures, missing observations, and censored waits as explicit outcomes; do not score only successful completed trips. Manually audit a small set of hard GPS/stop-occurrence cases; agreement with a second computation of the same GPS feed is not independent physical truth.
2. Create immutable forward-date folds. Fit models/tables only from outcomes actually available before cutoff; select features/hyperparameters on subsequent dates; calibrate the frozen final model on later dates; score the untouched following dates. Repeat rolling forward. Store source hash, parameter hash, detector version, topology/input hashes, cutoff, and runtime settings in every cached artifact.
3. Sample one prescribed observation per bus-target visit/horizon for statistical scoring, plus a separate realistic rider-arrival process for sequential UI evaluation. Do not let a ten-minute layover or many synthetic riders at nearby stops count as hundreds of independent trips. Bootstrap by service day, keeping each bus run and all its predictions together; report the number of days and runs. With few days, show the variability rather than a confident significance claim.
4. Measure signed bias, MAE, median absolute error, p90 absolute error, pinball loss at several quantiles, CRPS or weighted interval score, 50/80/90% interval coverage **and width**, and early/late miss rates. Use PIT/quantile reliability diagnostics for the whole distribution. Report route, horizon, source/target/occurrence, standing versus moving, layover elapsed, and missingness strata with hierarchical pooling where sparse.
5. Evaluate rider decisions separately: missed bus, arrival after class, false reassurance, unnecessary walking, unstable bus selection, 60/180 s jumps, and stale-feed behavior. Compare the current model against a simple historical conditional median/quantile baseline and a current-progress baseline. Calibrate the final displayed forecast after any smoothing or bias correction, not an intermediate raw model.
6. Predeclare practical tolerances before evaluating. For a nominal interval, require empirical coverage plausibly consistent with the target on multiple unseen days and no serious route/state undercoverage; accompany it with clustered uncertainty. For promotion, require an improvement in a proper accuracy score and no material degradation of missed-connection/late-arrival outcomes. Do not accept a shorter interval merely because jitter improved. Percentile-based class probability should remain blocked until the full journey target is modeled and prospectively assessed.

These recommendations follow the distinction between marginal conformal coverage and stronger conditional guarantees described by [Angelopoulos and Bates](https://arxiv.org/abs/2107.07511), and the use of proper distribution scores explained by [Gneiting and Raftery](https://sites.stat.washington.edu/people/raftery/Research/PDF/Gneiting2007jasa.pdf). The app-specific findings above come from its code and recorded data; neither reference validates this shuttle model.

## What should and should not block the next release

- **May proceed after ordinary correctness checks:** truthful UI wording, separate observed/model graphs, correct source/target timing labels, dated fleet facts, clear sparse-data states, and server-warm reliability maintenance.
- **Must block:** relabeling similar-ETA records as same-origin travel time; presenting full stop-to-stop durations as remaining-now observations; invented Gaussian/probability curves; exact on-time percentages; an asserted calibrated 80% window; model promotion relying solely on the current leaked/stale-cache-prone validation.
- **Requires measured follow-up, not an emergency speculative rewrite:** replace the standing clamp, add covariates, change cross-hop/lap dependence, or substitute an empirical conditional model. Keep the current service available while these are assessed.

No evidence from this review calls for rolling back persistent server ETA state or taking the app offline. The priority is to make the displayed quantity unambiguous, repair evaluation integrity, and then improve the model against rider-relevant outcomes.
