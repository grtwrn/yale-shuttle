# Red window and old-outlier review — September 17, 2026

Decision: retain the current forecast rather than remove valid slow trips or force a narrower interval. No raw records or model coefficients were changed.

The watcher reproduced 23 `<1–15 min` windows in the recorded Red replay. For one Winchester → Division/Prospect forecast, the underlying window was approximately 2–13 minutes; the existing calibrated widening produced <1–15. Removing that widening makes a display narrower but does not establish better predictive accuracy. This replay uses a fixed parameter/table snapshot and is a width decomposition, not historical validation of the served model.

The 75 matched real trips span nine service dates. The 19 trips completed in the preceding 48 hours still ranged from 2.17 to 12.67 minutes; their 10th/90th percentiles were 2.60/11.14 minutes. A standard 1.5-IQR outlier rule removes none of these 75 trips. The remaining wait at Winchester is the main source of variation; median subsequent travel was about 85 seconds.

The worker reconstructed connected journeys from SQLite and matched the 75-trip production fixture exactly. Its chronological comparison trained only on prior service dates with known outcomes completed by the cutoff, protected all observations younger than 48 hours, and scored 110 later trips. I inspected the code and independently reran it; the checks and figures reproduced.

| Historical comparison | Mean window | Within window | Later than upper end |
| --- | ---: | ---: | ---: |
| 30-day empirical 10th–90th percentiles | 470.60 sec | 76/110 | 22/110 |
| Exclude old IQR outliers | 469.67 sec | 76/110 | 22/110 |
| Seven-day window plus old-outlier filter | 479.14 sec | 76/110 | 20/110 |
| Narrow to 20th–80th percentiles | 358.88 sec | 51/110 | 35/110 |

These are descriptive trip-level empirical comparisons, not the live model's coverage. Trips share buses and dates, the sample is small, and legacy data lacks exact ingestion times. They support rejecting this particular shortcut, not a calibrated-probability claim.

A separate read-only production audit at 13:59:54 UTC found 250 completed Red Winchester stands; 57 were completed in the last 48 hours, with a maximum near 13.92 minutes. Using the recent sample's IQR fence removes one older stand and changes the pooled 90th percentile from 10.33 to 10.27 minutes. Those measurements are total stand durations, not remaining pickup times.

Evidence: `history-screen.py`, `history-screen.json`, `screen-pairs.json`, `independent-review.log`, `replay-summary.json`, `standing-replay-rows.json`, `production-history-check.json`, and `production-red-stand-summary.json`. The worker also passed 126 focused tests including server/browser parity. It hit its ten-minute limit before emitting its final JSON; this decision is the manager's review of preserved artifacts, not a fabricated worker approval. Its worktree has no source changes.

## Live 8–25-minute report

Captured at 2026-09-17 14:14:59Z: Red #300 near Trumbull/Hillhouse, seven stops before Division/Prospect. Issued median 922 s, low 452 s, high 1442 s (15.37 min; 7.53–24.03 min, before client countdown/rounding). The same snapshot predicts arrival at Winchester at 388 s, 236–580 s; after the Winchester hold, the next stop is 849 s, 385–1360 s. The future hold is the dominant point at which the window broadens.

The published widening factor is 1.236 here. Inverting that final calculation yields a pre-widening interval of 541.74–1342.71 s (9.03–22.38 min). Therefore disabling widening alone would still leave a 13.35-minute interval; it is not a sufficient or validated fix.

A separate read-only query of the recorded connected journeys found 40 complete Trumbull/Hillhouse-departure → Division/Prospect trips on eight dates near the same time of day. Empirical order-statistic q10/median/q90: 629.991/839.712/1065.5 s (10.50/14.00/17.76 min), min/max 560.001/1215.17 s. These are full departure-to-arrival durations, not a calibrated current-position forecast. They show narrower historical variation in this context and justify investigation of conditional future-hold uncertainty rather than claiming every broad window is unavoidable.

A later 14:19:39Z warm checkpoint restored all 19 vehicle states for local replay. Current and no-widening diagnostic arms are preserved. They are not historical accuracy validation; replay differs slightly from the issued snapshot because the checkpoint is saved every 30 seconds. No production model or data was changed. Evidence: live-wide-report.json, live-warm-capture.json, live-width-diagnostic.mts/json, trumbull-division-history.json.

Later read-only production outcome: this same Red #300 reached Division/Prospect at 2026-09-17T14:34:56.568000+00:00, 19.95 minutes after the captured forecast. The 15.37-minute point was early by 4.59 minutes; the issued 7.53–24.03-minute band contained this outcome. The bus stood at Winchester for approximately 11 minutes. This single observed outcome would exceed the descriptive historical q90 of 17.76 minutes if it had incorrectly been substituted for the live upper bound. Evidence: live-wide-outcome.json and live-wide-score.json. One trip does not validate coverage.
