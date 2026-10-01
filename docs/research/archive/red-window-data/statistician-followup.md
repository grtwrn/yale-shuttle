# Red forecast width: statistical follow-up

The evidence supports investigating a better conditional hold model. It does **not** support immediately narrowing the live forecast, removing older long holds, or reducing the displayed quantile range. A simple chronological prototype became narrower but introduced additional late misses. All work here is offline analysis; no production code, coefficients, data, or services changed.

## What the wide live interval establishes

The captured Red #300 forecast near Trumbull/Hillhouse to Division/Prospect was 922 seconds, with bounds 452–1442 seconds (7.53–24.03 minutes). Winchester's future hold accounts for much of the uncertainty. Inverting the final 1.236 widening gives approximately 9.03–22.38 minutes: the distribution was already broad before widening. Removing that final factor alone does not address the underlying source of dispersion.

The 40 same-time connected Trumbull-departure to Division-arrival trips span eight service dates. Their descriptive q10/median/q90 are approximately 10.50/14.00/17.76 minutes. They start at an observed departure, rather than the exact current GPS position and latent model state. They are selected completed journeys and cannot establish live forecast coverage or justify directly replacing the model's interval.

Earlier experiments in [review.md](review.md) already reject two quick fixes: excluding older IQR outliers barely changed width, while reducing q10–90 to q20–80 raised late misses from 22 to 35 among 110 chronological standing journeys. Those are empirical journey comparisons, not a randomized or full live-model comparison.

## Two separate modeling issues

1. **The stand distribution is pooled before it is scaled.** `web/src/eta/lap.ts:120–136` applies a lap-dependent multiplier to the entire unconditional stand distribution. That adjusts location and dispersion together, preserving its coefficient of variation. If variation in lap explains part of the original spread, scaling this pooled spread does not explicitly remove that explained component. It is plausible that the conditional stand distribution is unnecessarily broad. This is a model assumption to test, not a mathematical guarantee that every current interval is too wide.

2. **Future lap correction uses one nominal trajectory for every sample.** `web/src/eta/arrival.ts:405–444` advances a scalar nominal time, calculates one future lap factor, and applies it to all sampled stand durations. An approach that takes longer can cause a shorter regulated hold. The current factor does not represent that sample-specific relationship. This differs from the first issue: replacing a pooled stand distribution with a residual distribution addresses conditional spread; allowing each simulated arrival to change its own future lap addresses covariance between future components.

For illustration, let approach duration be A, previous-departure age known now be U, and hold S = a + b(U+A) + residual. Then A+S = a+bU+(1+b)A+residual. If b is around −0.5 and residual is independent, approach variance enters with multiplier approximately 0.25 rather than 1. The actual service need not obey a linear or independent-residual model. Applying a path-specific factor to the same pooled stand samples does not, by itself, solve both issues.

## Read-only joined evidence

[statistician-followup.py](statistician-followup.py) joins the existing 40 connected journeys to their unique Winchester stopped visit in `red-eta-data/replay-lap.db`, opened read-only. It checks chronological endpoints and the total duration. Approach is Trumbull departure to Winchester **pinned** time; stand is Winchester pinned time to departure; lap is the previous Winchester departure to the current pinned time. These clocks must remain aligned in any fitted replacement.

- Approach and stand correlation: **−0.439**, across 40 trips on eight dates.
- Observed variance of approach plus stand: **28,694 s²**. The sum of the two marginal variances is **45,549 s²**, about **59% higher**. That is a comparison within this selected sample; it is not an estimate that the deployed ETA variance is 59% too large.
- Among 39 observations within the currently served lap validity band, lap/stand correlation is **−0.749**, with fitted stand slope **−0.493 seconds per extra lap second**.
- Raw stand standard deviation is **185.8 seconds**; residual standard deviation around that fitted line is **123.1 seconds**. This is in-sample descriptive evidence and overstates what may be achievable out of time.

Trips share dates and bus runs; 40 trips are not 40 independent operating environments. Physical previous-departure timestamps lack exact legacy ingestion availability. Missing journeys, pass-throughs, dispatch interventions, and non-completed trips are absent. The association is consistent with layover regulation but does not identify a causal effect of traffic on holding.

## Fixed chronological exploratory screen

The script uses September 3/8/9 for fitting (17 trips), September 10/11 for residual quantiles (12), and September 14/15/16 for testing (10). One trip lacks a previous departure. The continuity band is calculated from training dates only; all 39 trips with nonmissing lap pass it. The common cohort is still defined using the later stopped visit, so this is a selected endpoint screen rather than a valid operational test over every origin forecast.

Each comparison has a pooled-location baseline and a linear conditional-location model. Only training data fit the location; only the calibration dates set residual q10/q50/q90. Test results did not select coefficients or quantiles. All dates had already contributed to the descriptive association above, so this is an exploratory temporal screen, not a pristine confirmatory holdout. Bounds are clipped at zero. Weighted interval score (WIS) uses the median and nominal central 80% interval; lower is better. Twelve calibration observations cannot establish reliable 80% coverage, especially with shared dates.

| Question and model | Mean width, seconds | Covered | Early / late misses | MAE, seconds | WIS |
|---|---:|---:|---:|---:|---:|
| Hold at Winchester: pooled | 440.2 | 4/10 | 6 / 0 | 190.1 | 109.7 |
| Hold at Winchester: realized-lap residual model | 174.5 | 5/10 | 4 / 1 | 122.9 | 99.4 |
| Whole journey at Trumbull: pooled | 310.3 | 4/10 | 6 / 0 | 138.9 | 101.4 |
| Whole journey at Trumbull: known departure-age residual model | 119.4 | 3/10 | 4 / 3 | 140.5 | 118.1 |

The realized lap is available **after reaching Winchester**, not when departing Trumbull. Its apparent improvement therefore cannot be transplanted into a Trumbull forecast. Even there, the naive line extrapolates below zero on one test trip, producing a zero-width interval after clipping; a production candidate needs a nonnegative model and a fallback outside training support.

The origin-available age model is the relevant simple shortcut for the earlier forecast. It narrows the interval but worsens late misses and WIS. It fails this small screening comparison. This does not reject a properly specified conditional simulation; that model was not tested here. Neither pooled baseline represents the deployed estimator. Poor coverage in both arms also shows why pooled sample quantiles should not be presented as calibrated live confidence bounds.

Full joins, per-date results, and every test prediction are in [statistician-followup.json](statistician-followup.json). Reproduce with `python3 red-window-data/statistician-followup.py` from the workspace root. It reads existing captures and a read-only SQLite connection and rewrites only its JSON analysis artifact.

## Recommended next experiment and promotion decision

Build one offline conditional hold candidate using the same pinned/departure clock as live standing state. Fit a nonnegative conditional location and residual distribution with shrinkage toward a pooled fallback, preserving the distinction between probability of stopping and positive hold duration. Time of day and operational context may matter, but sparse hard buckets will worsen estimation; retain explicit fallback behavior. For an already standing bus, condition on having survived its elapsed stand using the same clock.

For future holds, each simulated path should propagate its own arrival time, compute its own lap from a departure genuinely known at prediction time, and draw from the corresponding conditional hold distribution. Subsequent departures must also propagate separately by path. Avoid simply shrinking pooled draws or treating a future realized lap as a covariate already observed at the origin.

Compare four frozen variants: current estimator; conditional residual distribution only; sample-wise future lap correction only; both. This separates the two hypotheses. Validate full warm-server forecasts at fixed origin/progress and horizon checkpoints, with entire bus-target arrivals kept together. Use chronological fit, tuning, final-candidate calibration, and untouched test blocks; enforce artifact provenance and availability cutoffs. Report route/horizon coverage, early and late misses, width, WIS, point error, and jumps, with uncertainty clustered by service date and bus trip. Measure selection and missing/pass-through cases instead of silently evaluating only successful stopped journeys. Refit interval calibration on the final candidate's actual raw outputs.

Existing provenance, independent-date, and grouped-observation promotion gates should remain in force. The current evidence permits truthful historical context and clearer labels, but **does not permit a narrower production interval or a claimed calibrated coverage level**. The strongest next modeling target is conditional hold residuals plus future lap covariance; the simple age-only shortcut has not earned promotion.
