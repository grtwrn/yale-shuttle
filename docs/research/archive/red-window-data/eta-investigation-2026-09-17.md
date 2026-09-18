# Red ETA investigation, September 17

The useful next model change is a lap-conditional hold distribution with consistent clocks, evaluated together with stop/departure state and the displayed ETA rule. Forward route progress and nonincreasing remaining ETA are different requirements. The user confirmed they meant forward route progress. No production model or data was changed in this investigation.

## Short journeys by hour

The earlier ten-shortest audit used time-matched history queries, so its morning examples could not establish an hour restriction. The replacement all-day audit follows exact connected visits and legs from Winchester, with distinct source/target journeys counted separately at each clock. It finds 182 qualifying stopped Division arrivals and 120 Rosenkranz arrivals over nine service dates, September 3–16. Missing/ambiguous chains, non-stops, incomplete sources, and distant sources are accounted for in the report; this is a selected completed-journey cohort, not every operating trip.

- After 55 seconds at Winchester, only 1 of 180 eligible Division journeys had at most two minutes remaining. It occurred in the 10 a.m. hour.
- After 405 seconds at Winchester, 9 of 76 had at most two minutes remaining. Those occurred in the 9, 10, 11 a.m., and 2, 3, 4 p.m. hours. A short remainder after a long wait is not a short whole trip.
- After departure, 168 of 182 reached Division within two minutes, with qualifying short rides in every sampled departure hour from 7 a.m. through 5 p.m.
- At 55 seconds, the five Rosenkranz journeys with at most seven minutes remaining occurred in the 10 a.m., 3, 4, and 5 p.m. hours.

These data do not justify discarding short trips by age or treating all short trips as tracking failures. Endpoint times are collector stop proxies, not verified door-opening times. The prior GPS audit's two roughly 25–30-second endpoint discrepancies remain relevant but do not explain the large forecast windows.

Reproduce with `python3 short-trip-hours.py`. Tables and exclusions are in [short-trip-hours.md](short-trip-hours.md); exact observations are in [short-trip-hours.json](short-trip-hours.json).

## Covariates: studied, not exhausted

The [reviewed inventory](covariate-inventory.md) distinguishes descriptive associations, chronological component tests, older replay experiments, and live behavior. Lap is the strongest tested hold predictor. Hour, weekday, bus identity, previous departures, projected physical spacing ahead/behind, recency, recent traffic, and own-bus pace have been examined with different methods and limitations. The earlier physical-spacing screen's `137 features` means **137 visit observations**, not 137 predictors. Its 103 later-day observations showed average error 119.1 seconds with lap alone versus 121.2 with added spacing, although a tail measure improved.

The modern hold tests did not find a convincing extra benefit from additive smooth hour or bus identity. That does not establish that hour is irrelevant to the riding portion, or that all nonlinear forms and interactions have been tested. Passenger load, dispatch decisions, driver identity, traffic/weather inputs, and several joint interactions have not been established as usable predictors.

A new exploratory ride-only screen separates the journey after Winchester departure from its hold. It fits before September 10, calibrates on September 10–11, and scores September 14–16:

| Target | Test journeys | Pooled point MAE | With smooth hour | With bus identity |
|---|---:|---:|---:|---:|
| Division | 49 | 28.5 s | 28.0 s | 28.9 s |
| Rosenkranz | 37 | 72.4 s | 64.6 s | 73.1 s |

The hour benefit for Rosenkranz appears on all three dates, but the largest changes occur on the later two. Only one bus qualifies for a fitted identity effect there; this is weak evidence about bus identity, not proof of no effect. The experiment was prompted by already inspected data, conditions on a stopped destination and connected chain, and does not evaluate uncertainty in the future departure hour while the bus is still waiting. It does not authorize a model rollout. See [journey-hour-screen.json](journey-hour-screen.json) and its reproducible Python script.

## Why forward progress does not resolve these jumps

The recorded complaint's bus can remain on the correct route occurrence while its probability of still waiting changes during a yard movement. A separate running-minimum remaining-ETA rule then retains an unusually low point estimate and translates the entire interval and forecast quantiles downward. Subsequent evidence of continued waiting cannot restore the earlier estimate during that rest identity. This explains part of the reported persistent low point; it does not explain every source of excessive interval width.

The older EMA and constant-velocity Kalman experiments do not support replacing route tracking with generic smoothing. The tested EMA delayed departure updates and introduced changes during repeated raw coordinates. Those are results about particular implementations, not a proof that every possible state estimator fails. Forward-only route selection also needs recovery from an incorrectly selected route branch.

Simply removing the minimum rule is not a validated fix. Its previous diagnostic produced larger upward revisions and worse departure forecasts, but used same-day tables and observer resets, so those numbers are not causal accuracy or calibration evidence. See [stability-review.md](stability-review.md) and [ratchet-screen-review.md](ratchet-screen-review.md).

## A conditional hold model shows progress

The production-style baseline for this screen was rebuilt with the real calibrator at September 14 midnight, before all scored visits. The reviewer independently reproduced the Red stand tables and lap fits: no test-date stand durations entered them. The experiment uses the real distribution interpolation, lap factor, and survival conditioning, but intentionally isolates a known ongoing stop visit from route/state uncertainty, display floors, final bias, and widening. Therefore these are **hold-component windows**, not displayed route ETA windows.

Two candidates were specified before reading their scores: an additive lap prediction with a separate calibration residual distribution, and a distribution of prior holds normalized by the existing lap factor. Each uses a full nonnegative duration distribution, conditions on elapsed time, retains missing/out-of-band-lap visits through the same baseline fallback, and falls back when fewer than five historical calibration values support the surviving tail. Test visits are not discarded. The additive candidate's lower tail was less attractive.

After the first results, a matched marginal control was added to separate normalization from differences in the selected cohort, pass zeros, and class shrinkage. That control uses the same valid-lap stopped visits and quantile construction as the normalized candidate. It is a diagnostic control added after inspection, not a new untouched test.

At Winchester, 60 seconds into a surviving visit:

| Hold model | Visits | Mean interval width | Point MAE | Inside interval | Earlier than lower bound | Later than upper bound |
|---|---:|---:|---:|---:|---:|---:|
| Reconstructed current component | 55 | 449 s | 132 s | 53 | 1 | 1 |
| Matched marginal control | 55 | 441 s | 134 s | 53 | 1 | 1 |
| Lap-normalized candidate | 55 | 375 s | 114 s | 49 | 2 | 4 |

The matched comparison narrows by about 66 seconds and improves point error and weighted interval score. At arrival, the candidate's 47/58 coverage is about 81%, compared with the baseline's 56/58, or 97%, for an intended central 80% interval. A reduction in overcoverage is not itself a failure. However, the candidate also produces more points that predict departure over two minutes later than observed (9 versus 3 at arrival). That is a risk indicator to evaluate in full rider simulations, not a measured count of missed rides.

Results vary with stop and elapsed time. Union's main gain is correcting a low center; its window is sometimes wider, not uniformly narrower. Later checkpoints have fewer surviving visits (only eight Winchester visits at 600 seconds), and repeated checkpoints are not independent observations. All test dates were previously inspected. These findings are exploratory, not a nominal coverage guarantee.

## Center and clock mismatch

The legacy fit's reference lap is 3,035 seconds at Winchester and 2,825 at Union. Valid modern prior visits have median laps around 3,218 and 3,159 seconds. Applying the legacy-pivot factor to the already modern pooled hold table therefore multiplies a typical visit by about 0.83 or 0.66. Normalizing the distribution changes its center substantially as well as its spread.

Matched contemporary clock records support part of the discrepancy: modern Winchester hold duration is about 35 seconds shorter and its lap about 35 seconds longer than the legacy clocks. The selected Union pairs differ by about 145 and 150 seconds. But only 114/173 Union visits met the strict overlap/departure matching rule; previous-departure events are not independently paired, and the full pivot gap also includes cohort and service-period differences. Do not attribute the whole mismatch to one clock bug. See [lap-clock-audit.json](lap-clock-audit.json).

## Deployment decision and concrete next validation

**Promising candidate; no production model change yet.** Do not replace the full marginal stand table with stopped-only normalized quantiles: future-stop pricing samples zero/pass mass from that distribution directly, so retaining a separate `pstop` field alone would not preserve behavior.

The next implementation must preserve pass-through probability for future stops, use consistent lap/hold clocks, apply the conditional distribution continuously on approach and during the visit, and distinguish a momentary movement within an unfinished visit from a completed departure. It must evaluate pricing-only changes separately from changing the filter's departure hazard. Full chronological replay needs prior-only table vintages, real five-second observations, warm state, preserved departure-event availability, visit/date grouping, both interval tails, weighted interval score, absolute arrival jumps, and actual rider missed-connection outcomes. It must include the urgent September 17 example without using that example to fit its own forecast.

The independent [conditional-model review](conditional-hold-review.md) reproduced the scores and baseline inputs and reached the same decision. The user-facing production model was not changed, so this investigation introduced no app-code regression. Watcher and guardian services were active with fresh samples at 16:00 UTC.
