# K=5, K=10 and switching after the wait

Written before scoring these combinations, following the user's explicit request. Reuse the same data, eight training dates, September16 calibration, three evaluation dates, original outcome cohort, historical mean implementation, support requirements, and weighting. These are exploratory comparisons on reused dates, not newly held-out evidence. Heavy work runs on hosted CI; no production changes.

The reference wait is 344 Winchester, route index14. K=5 means Whitney/Audubon, index9; its unswitched departure mean must exactly reproduce the initial `fixed_mean`. K=10 means Chapel/Church, index4. Include the prior ten-stops-behind-bus model as the third base. Do not search other offsets or fit separate bus parameters.

Compare each base under three modes:

1. No switch, the historical whole-duration mean minus elapsed time.
2. Switch point and both bounds exactly to the logged production estimator after a confirmed 344 departure belonging to the current approach.
3. Sensitivity: the same switch can also happen after Canal when its causally recorded completed stand is at least300 seconds. The threshold is declared here, not selected from scored outcomes.

Use only finalized departure events actually emitted by the production reducer by the forecast's available-data time. Never use the later label's final departure to trigger the switch. A valid event must follow the latest causally confirmed upstream origin, excluding a previous lap. The replay already clears histories after gaps over60 seconds. Once a current-approach departure is observed, use production through the pickup, including any observed repositioning/return to the wait area. If an upstream route occurrence is later observed, its timestamp prevents reusing the older departure. This is an observed-departure rule, not an oracle saying the bus will never return.

Calibrate unswitched bases on September16 at nominal80% and90% using the same nonnegative interval-padding rule. Hybrid methods inherit their base's padding before the switch and use production exactly afterward. Do not recalibrate hybrids separately: that isolates the effect of switching. Unsupported historical means use the existing production fallback; after switching, a missing logged production forecast remains missing rather than inventing a current-model replay.

Report all three bases and modes, both interval levels, exact paired cohorts, support/switch counts, point error, coverage, width, interval score, early/late misses and severity, false-now rates, recorded-stop departure diagnostics, per-day and pre/post-release phases, and jumps at the switch. Retain valid closing-hour fast approaches. Check 15-second extra input delay, prior-day refreshed history, and strict labels. Audit representative early, late, fast-approach and noon Canal cases against raw continuity.

Required checks include K=5 exact equivalence; unchanged earlier numerical results; no switch before event emission; rejection of stale previous-lap events; no switch on Canal's completed short stand; a switch on a completed long Canal stand only in the sensitivity; exact production point/bounds after switching; original outcome-cohort identity; prefix replay and future-training deletion.

Post-score implementation sensitivity: the first run showed that the completed-visit gate sometimes remains absent even after the causal phase has advanced beyond344, particularly on fast pass-throughs. Retain that strict gate's results. Add an `after_observed_exit` mode: use its confirmed release, or a current causal drive stage from344 / stage beyond344. A mere nearest-stop change while the stage still holds at344 is insufficient. This is a separate rule added after seeing the first scores, with no parameter fit or fabricated departure timestamp. Test the same rule in the downstream destination extension.
