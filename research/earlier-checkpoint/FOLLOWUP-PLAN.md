# Ten-stop and wait-relative anchors

Requested after reviewing the original experiment: the user values saving roughly three minutes of window width even at roughly twenty seconds additional point error. Evaluate that tradeoff explicitly rather than reject candidates solely on mean point error. This plan is written before scoring the new anchors. These are reused evaluation dates, not a new holdout.

The user's clarified definition is **K stops BEFORE the usual significant wait stop preceding the pickup**. For Division/Prospect, that wait stop is 344 Winchester (route index14): K=1 is Canal/Munson (13); K=2 is Winchester/Sachem (12). The latter departure-based model must reproduce the existing `five_before_mean` exactly. The same northern wait stop precedes the secondary Prospect Street pickup.

Test six explicitly named alternatives, without searching additional offsets:

- Ten stops behind the bus's current detector anchor, without wrapping to a previous lap. Missing origins use the same production fallback as before.
- Ten stops before the pickup: Wall/Church for Division, Trumbull/Hillhouse for the secondary target.
- K=1 and K=2, timing from confirmed departure, as in the initial experiment.
- K=1 and K=2, timing from observed arrival instead. This boundary sensitivity includes Canal's own hold; a departure-only origin cannot be used during that hold. An active stop arrival can enter only once the replay reducer has observed it. Historical arrival definitions match those reducer records.

Keep the same mean-minus-elapsed rule, clock weighting, support thresholds, raw continuity rules, eight training dates, September16 calibration, and September17/18/21 evaluation. Keep the original forecast origins, outcome matches, journey weights, and production fallback fixed. Expanded source histories must not alter the baseline cohort. Apply the existing 15-second delay sensitivity and prior-day-history sensitivity to all six candidates. Predictions must use only causal replay features and history completed before the appropriate cutoff.

Report point error, window width, interval score, coverage, early/late misses and severity, false-now counts, genuine-stop departure diagnostics, stability and support. Show fallback-inclusive, support-only, per-day, and Canal/Winchester/current-phase results. Audit the largest actual-window and point regressions against raw tracks.

Because production's existing windows cover about94% of this sample while candidate intervals target80%, include September16-only calibration at both80% and90% for the new candidates. As a separate interval-only control, symmetrically recalibrate production bounds to each nominal coverage using September16 signed bound errors (allow contraction), preserving its point estimate. Do not adjust intervals based on test-day coverage. Wider/narrower windows are a rider preference tradeoff; interval scores and miss timing measure the cost. Report that cost and let the user assess it.

All calculations run on hosted CI. No application or deployed-model changes are included.
