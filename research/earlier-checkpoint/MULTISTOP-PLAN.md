# Does anchoring before the wait avoid a ten-stop discontinuity?

Added at the user's request while the first hybrid run was still executing, before reading its scores. Freeze this extension before scoring it. Keep the original Division experiment, no changes to its cohort, and label this as additional exploratory evidence.

Compare Red's14 downstream pickup stops, route indices15–28, from Winchester/Division through Amistad/Church Street South. This covers the important boundaries: a pickup-relative ten-stop origin reaches 344 Winchester at pickup index24 and moves beyond it at25; a bus-relative ten-stop origin crosses it when the current anchor reaches24/25. No loop wrapping or other routes are claimed. In this downstream section, the usual preceding major wait remains344 Winchester, so K=5 and K=10 retain their origin across pickup changes.

Use the same public raw positions, visit/leg histories, eight training dates, and September16-only interval calibration at80% and90%. Export the other available public vehicle prediction logs from the same captures. No new rider information. Some additional destinations have very few logged forecasts; report target-by-target sample sizes and do not equate dense synthetic origins with independent trips or actual production comparisons.

Use one pooled padding per base across the downstream targets, inherited unchanged by its hybrid. Do not introduce target-specific fitted padding that could itself cause a destination boundary jump.

Bases: K=5, K=10, ten behind bus, ten before pickup. For each, compare no switch with the same causal344-departure switch. Use the original hybrid's long-Canal sensitivity only in its original Division comparison; do not multiply boundary variants further here. Preserve the existing departure clock, weighting and support rules. Candidates without a source fall back to an actual production log when one exists; otherwise forecast missing. After switching, a missing production log likewise remains missing.

Assess two distinct discontinuities:

- **Bus movement:** adjacent30-second origins for the same physical pickup visit, particularly when bus-relative origin crosses index14/15. Measure changes in absolute arrival time and show whether confirmed departure had already activated the switch. A missing production forecast is not a numerical proof of a smooth hybrid.
- **Pickup choice:** adjacent route targets at the same forecast time and bus. Measure support/fallback transitions, predicted-order reversals, and changes in predicted incremental travel time compared with actual incremental travel time. Focus separately on target pairs23→24 and24→25, where pickup-relative origins cross the wait. Count only matched forward outcomes from the same approach; do not join a later loop. Report dense candidate-only diagnostics separately from paired logged-production evidence.

Report point error, width, coverage, interval score and missingness per destination, plus clearly labeled pooled journey-weighted comparisons. Use actual logged production as the comparator, not a proxy current-stage model. Check strict labels, prefix replay, future-training deletion, exact production after switching, and known-time release gates. Use the original hybrid's full15-second and daily-refresh tests for that experiment; this destination extension is a frozen-history boundary audit. Preserve valid misses and sparse-sample limitations.
