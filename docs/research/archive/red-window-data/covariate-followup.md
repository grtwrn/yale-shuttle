# Bus number and time of day: Red covariate follow-up

**The tested bus-number and clock-time additions do not improve Red hold predictions enough to justify deployment or priority full replay.** Lap time remains the substantially stronger feature. Time of day may still help particular road segments or operating regimes, but this component-level screen does not establish such a benefit. A bus number can proxy a driver, shift, or assignment; it is not a stable explanation of how long a future hold will last.

## What already uses time of day

- Past trips history uses the same weekday/weekend category and a ±2-hour clock window (`src/server/journeyHistory.ts`). This selects descriptive historical records; it does not fit a time-of-day live ETA effect.
- The live calibrator computes some legacy segment/dwell statistics using the same day of week and hour ±1 (`src/calibrator/calibrator.ts:135–139`).
- The main stand quantiles, drive/leg distributions, and stop probabilities used by the ring estimator are pooled over 30 days. `calibrator.ts:62–74` explicitly documents that split; `web/src/eta/tables.ts:8–30,206–237` consumes the pooled `q` and `dq` fields. Those primary distributions are not hourly conditional distributions. Lap correction changes the holds; GPS progress and rest state also affect each live forecast.

It would therefore be inaccurate to say either that the entire live model ignores time or that the current layover uncertainty is already fully conditioned on hour.

## Reproducible chronological screen

[covariate-followup.py](covariate-followup.py) reads the local DB and a previously inspected 90-day Red arrival archive. It fits separate models for Winchester (11) and Union Station (121). The modern labels are actual detector resting-plateau durations from `stop_visits`; the older labels are closed geofence visits from the prior study and should not be treated as interchangeable ground truth.

The feature arms were fixed before scoring: pooled baseline; lap; lap plus smooth clock time; lap plus bus intercepts; lap plus both; lap plus clock time and weekday. Clock time is represented by sine/cosine terms. Bus and weekday effects receive fixed ridge shrinkage; bus effects also require at least ten training visits on two training dates. Those are conservative prototype guards, not sufficient production sample sizes. The penalty values were not tuned on test results.

The feature sweep reads only departures available before each observation, with an assumed delay of at least 120 seconds, and requires a same-day return via the opposite Red layover to identify a lap. The lap validity reference comes from training data only. Missing or out-of-band laps use the same pooled fallback; all test visits remain in the score. Duplicate/overlapping same-bus visits are checked. Labels must complete before their fit/calibration cutoff. Exact legacy receipt times remain unknown, so the assumed delay is a sensitivity safeguard, not proof of original online availability.

For modern labels, fit dates are September 3, 4, 8, and 9; residual interval calibration uses September 10–11; testing uses September 14–16. For the old archive, fitting ends before August 15, interval calibration uses August 15–28, and testing starts August 29, matching the prior independent audit's split. No test date tunes coefficients, thresholds, or interval residuals. These records have already been inspected in other investigations, so this is an exploratory chronological comparison rather than untouched confirmation.

Intervals use separately calibrated residual q10–90. Scores include MAE, early/late misses, width, and weighted interval score (WIS; smaller is better), with paired differences bootstrapped by whole service date. Three modern test dates are far too few for a stable uncertainty interval; reported bootstrap ranges are diagnostic rather than strong inferential claims.

## Results

| Hold cohort | Test visits / dates | Lap MAE s | + clock time | + bus number | + both | + time and weekday |
|---|---:|---:|---:|---:|---:|---:|
| Modern Winchester | 58 / 3 | 111.8 | 110.9 | 111.9 | 111.3 | 111.7 |
| Modern Union Station | 62 / 3 | 119.8 | 117.8 | 119.2 | 118.9 | 119.8 |
| Legacy Winchester | 197 / 8 | 151.0 | 153.6 | 156.3 | 158.1 | 151.2 |
| Legacy Union Station | 212 / 8 | 158.8 | 160.4 | 159.5 | 161.5 | 159.6 |

The modern Winchester fit has 102 training and 58 calibration visits. Lap alone reduces pooled-baseline MAE from 174.6 to 111.8 seconds. Clock time adds less than one second of average improvement, with a paired day-block bootstrap range of **−3.5 to +8.4 seconds** for its MAE change. Bus number changes MAE by +0.06 seconds. Neither is a convincing improvement.

The interval metrics do not rescue the additions:

| Modern component | Covered | Early / late misses | Mean width s | WIS |
|---|---:|---:|---:|---:|
| Winchester, lap | 48/58 | 6 / 4 | 344.3 | 71.7 |
| Winchester, lap + time | 45/58 | 9 / 4 | 348.3 | 71.2 |
| Winchester, lap + bus | 48/58 | 6 / 4 | 350.1 | 72.3 |
| Union, lap | 47/62 | 12 / 3 | 369.8 | 78.6 |
| Union, lap + time | 45/62 | 12 / 5 | 324.0 | 78.4 |
| Union, lap + bus | 48/62 | 11 / 3 | 385.2 | 78.6 |

At Union, the slightly smaller point error from time conditioning comes with two more late misses. At Winchester, time conditioning raises early misses. These are small component samples, not deployed rider forecasts; neither table proves calibrated 80% coverage.

In the larger old Winchester cohort, the bus-effect model is worse on **all eight test dates**, increasing MAE by 5.3 seconds; its paired day-block range is +3.8 to +6.6 seconds. Adding time also fails to improve point accuracy. Some old Winchester interval scores improve slightly under time/day terms, but that pattern does not carry through the modern tail metrics. There is no consistent win to promote.

Bus identity also has a practical generalization problem. In the modern Winchester test set, **39/58 visits lack a bus effect with adequate training support**. Fleet and assignment changes mean that an apparently bus-specific pattern learned earlier may not be usable later. Adding a per-bus table without shrinkage and explicit fallback would make this worse.

## Previous/next shuttle spacing

The existing chronological analysis at `docs/data/eta-evidence-audit/lap-headway-delay120.json` already tests elapsed time since another bus departed the same stop, with a 120-second availability delay. Winchester MAE changes from 151.0 to 148.9 seconds beyond lap, but the day-block interval for the incremental change is **−4.8 to +0.1 seconds**, and nominal interval coverage drops from 80.2% to 78.7%. At Union, the change is 158.8 to 159.0 seconds. This is a weak and inconsistent signal, not evidence for deployment.

That covariate is past departure spacing, not synchronized physical distance to the bus ahead or behind. The latter requires correct route occurrence, direction, same-time GPS, and censoring when a neighboring bus is absent. No ready, validated next-shuttle covariate was constructed here. Substituting its future realized arrival would leak the outcome.

## Decision and next evidence needed

None of these specific additions earns a production change. Bus number should remain a weak, shrinkable diagnostic unless it survives changes in dates and operating assignments. Smooth time effects could be retained as a low-cost ablation in a larger conditional-hold experiment, but the present gain is too small and inconsistent to prioritize a standalone rollout.

The higher-priority experiment remains the previously identified conditional hold residual distribution and sample-wise future lap propagation: those address a concrete source of unnecessary dispersion. The earlier simple age-only shortcut failed its tail checks; a proper replacement still requires full warm-server replay and final-candidate recalibration.

Before promoting additional covariates, satisfy the existing minimum-date/provenance gates and obtain enough independent dates to evaluate several later operating blocks. For a per-bus effect, require observations across multiple shifts/dates and hold out future assignments; ten visits on two dates is only this prototype's entry guard. Avoid one table per exact hour/bus combination. Track effective sample size and use pooled fallback. Evaluate current and candidate predictions on identical bus-target journeys, grouped by service date and trip, including point error, WIS, both interval tails, jumps, and rider missed connections. Component MAE alone cannot settle the rider decision.

Full coefficients, splits, per-date scores, predictions, data hashes, and limitations are in [covariate-followup.json](covariate-followup.json). Reproduce with `OPENBLAS_NUM_THREADS=1 python3 red-window-data/covariate-followup.py`. The script writes only the analysis JSON; no model was fitted for publication and no app or production state was changed.

## Separate urgent finding: report 115's standing ceiling

The production prediction records in `report115-predictions.json` and diagnostic `urgent-replay.json` describe a different problem from bus/hour covariates. The recorded Red #309 point falls to 149 seconds and remains there while its upper bound changes. The warm diagnostic reproduces a trough and subsequent binding ceiling, with somewhat different values because its observations are ten-second snapshots and its calibration tables are frozen. It is a mechanism reproduction, not exact production replay or accuracy validation.

`web/src/eta/arrival.ts:817–823` takes the running minimum of the previously shown and newly modeled point, then translates every distribution quantile by the same negative difference and clips at zero. A downward fluctuation can consequently affect later uncertainty after the current evidence has recovered. Preserving the ordering of quantiles does not make this translated distribution a valid current conditional forecast. Adding a bus intercept or hour effect cannot fix that structural issue.

For a genuinely continuous stand with duration S and elapsed time r, the residual distribution is based on survival: `P(S−r≤x | S>r) = [F(r+x)−F(r)]/[1−F(r)]`. Its median need not decrease with r for a heterogeneous or heavy-tailed population. Evidence that a bus is still waiting can legitimately move its predicted arrival later. A blanket requirement that every remaining-time forecast never rises is therefore not a statistical calibration requirement.

The narrowly defensible next **experiment** is to separate the current predictive distribution from the running-minimum presentation rule while holding belief transitions, tables, lap features, and all coefficients fixed. Compare the current estimator with its unshifted current quantiles through complete warm replay; measure both interval tails and proper scores, plus point reversals, departure collapse, and missed connections. If a smoothed point is retained for presentation, it must not be called the distribution's median when it is no longer that median, and its presentation policy needs separate validation. Do not hide discrepancies by translating the uncertainty interval to agree with it.

This is not an instruction to restore a rejected switch. `docs/eta-ring-posterior.md` documents failures of display restoration and shuffle/departure gates, including increased reversals and delayed true-departure collapse. Those failures remain relevant and must be included in the replay comparison. The measured overlap between repositioning and departure supports maintaining uncertainty; the finite set of failed heuristics does not mathematically prove that every possible sequence model is incapable of improvement. No revised shuffle gate or monotonicity rule has earned deployment here.

If unchanged-belief, unshifted forecasts still contain unacceptable troughs, the next change belongs in a properly scored state/hold model with uncertainty over repositioning and departure, rather than another irreversible display minimum. Conditional hold residuals and per-path future lap handling remain promising modeling experiments, but none of the present evidence supports an immediate cosmetic interval clip or a new calibrated-probability claim.
