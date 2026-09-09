# Merged-master client integration replay

Artifact report updated 2026-09-09T13:04:42.469829+00:00

Full manifests, commands and scores are preserved under `services/shuttle-v2/scripts/.eta-replay/overnight-2026-09-08/integration-master-93aa45d/`; artifact paths below refer to that directory.

This local check compares the duration baseline and the already selected general standing model on the same merged client at `5d9e112` (master `93aa45d`). Both arms use the new filter and unchanged frozen fits, historical features, physical labels and scoring code. No refit, tuning, model selection, production action, or morning-data scoring occurred.

| Cohort | Served arrivals | ETA MAE, seconds | First recorded displays | First TOTAL MAE, seconds | Remaining wait MAE, seconds |
|---|---:|---:|---:|---:|---:|
| 2026-09-08 | 4,937 | 123.93 → 122.50 | 2,472 | 46.21 → 43.71 | 33.74 → 32.19 |
| 2026-09-05 | 2,172 | 207.41 → 206.82 | 597 | 100.31 → 97.74 | 55.75 → 53.42 |
| 2026-09-06 | 1,952 | 197.42 → 194.17 | 471 | 120.70 → 118.69 | 62.37 → 56.78 |
| 2026-09-07 | 28 | 92.02 → 92.02 | 6 | 12.88 → 12.88 | 10.45 → 10.45 |
| Reserved combined | 4,152 | 201.94 → 200.10 | 1,074 | 108.76 → 106.45 | 58.40 → 54.65 |

All metrics use equal physical arrivals/visits. First TOTAL retains each arm’s original first display and pairs only identical original issue keys; later issues never replace a missing original first. Separate coverage artifacts retain unmatched rows. The route guard requires at least 30 visits and an MAE increase above both 10 seconds and 10%. Three displayed quantiles support point/interval checks, not a proper-loss improvement claim.

## 2026-09-08

Material route regressions: `{"eta": {}, "firstTotal": {}, "remainingStand": {}}`.
- ETA: overprediction >120s 10.73% → 11.03%; underprediction >120s 10.47% → 9.69%.
- Remaining wait: overprediction >120s 4.51% → 4.26%; underprediction >120s 2.80% → 2.29%.
- First TOTAL: overprediction >120s 1.86% → 1.86%; underprediction >120s 7.08% → 5.99%.

Red Winchester first TOTAL: 134.86 → 71.17 seconds across 25 visits. All Red queries targeting Prospect/Division, across every current bus state: 106.57 → 78.79 seconds across 27 served arrivals. This broad diagnostic is separate from the Winchester-hold subgroup.

## 2026-09-05

Material route regressions: `{"eta": {}, "firstTotal": {}, "remainingStand": {}}`.
- ETA: overprediction >120s 16.17% → 16.43%; underprediction >120s 19.34% → 19.08%.
- Remaining wait: overprediction >120s 6.96% → 6.22%; underprediction >120s 7.06% → 6.73%.
- First TOTAL: overprediction >120s 1.34% → 1.34%; underprediction >120s 17.09% → 16.75%.

## 2026-09-06

Material route regressions: `{"eta": {}, "firstTotal": {}, "remainingStand": {}}`.
- ETA: overprediction >120s 16.18% → 16.55%; underprediction >120s 18.63% → 17.55%.
- Remaining wait: overprediction >120s 7.41% → 7.21%; underprediction >120s 9.84% → 8.40%.
- First TOTAL: overprediction >120s 1.27% → 1.27%; underprediction >120s 21.66% → 20.59%.

## 2026-09-07

Material route regressions: `{"eta": {}, "firstTotal": {}, "remainingStand": {}}`.
- ETA: overprediction >120s 21.90% → 21.90%; underprediction >120s 0.00% → 0.00%.
- Remaining wait: overprediction >120s 0.00% → 0.00%; underprediction >120s 0.00% → 0.00%.
- First TOTAL: overprediction >120s 0.00% → 0.00%; underprediction >120s 0.00% → 0.00%.

## reservedCombined

Material route regressions: `{"eta": {}, "firstTotal": {}, "remainingStand": {}}`.
- ETA: overprediction >120s 16.21% → 16.52%; underprediction >120s 18.87% → 18.23%.
- Remaining wait: overprediction >120s 7.12% → 6.62%; underprediction >120s 8.24% → 7.42%.
- First TOTAL: overprediction >120s 1.30% → 1.30%; underprediction >120s 18.99% → 18.34%.

## Exact Winchester-hold → Prospect/Division subgroup

The unchanged physical-hold predicate is `routeId == 3 && currentStopId == 11 && stopId == 48`. It gives 269 paired forecast moments across 25 served arrivals: MAE **105.81 → 62.71 seconds**. Whole-arrival 95% interval for the paired difference: -69.45 to -17.56 seconds; vehicle/day interval: -71.24 to -15.33 seconds across 3 blocks.
The exact predicate reproduces all 273 previously saved original subgroup rows and the previous 103.654→61.636s score. Frozen repaired physical hold labels retain 269 of those keys, remove four and add none; both merged arms have zero unmatched subgroup rows. This subgroup check only joins completed replay outputs; it does not regenerate their queries, targets or predictions, and does not refit the model. Current hold is a scoring-only stopped episode whose pin precedes issue and whose departure follows it; it is not the client’s inferred stop.
Overprediction >120s: 5.20%→6.05%; underprediction >120s: 27.21%→5.16%. `2026-09-08-paired/red11-to48-score.json` records cohort, exact old-row/metric controls, source hashes, coverage and intervals.

## Provenance and limits

**There is no held-out Red validation in these results.** September 8 supplied the Red regression measurements; September 5–7 contain no Red observations. The separately registered September 9 prospective scorer stopped on duplicate query/target keys without producing a validation result.

- `run-manifest.json` freezes dependencies, model and corpus before emission; `source-controls.json` proves selected analytic body and label geometry equality.
- `replay-commands.json` contains exact replay argv/environment; `commands.jsonl` and `reserved-paired/commands.json` record unchanged scorer invocations.
- Sep8 uses its published model parameters. Reserved Sep5–7 uses the original compiled defaults and cutoff Sep5 04:00Z. All candidate runs load the same frozen Sep3+4 fit. Sep8 remains a previously examined regression day; it is not new holdout evidence.
- Warm state consumes every original GPS poll; queries use the original stride of six. ETA targets preserve current-target 50m exclusion, continuous tracking, unique served occurrences and 30-minute horizon. Standing truth uses the already frozen prediction-blind rebuild with exact replay geometry.
- Sep8’s first baseline attempt exited 143 without an exception or completion manifest. Its partial files remain under `baseline-interrupted`; they are excluded. The exact command was retried and only completed manifests permit scoring.
- Historical training-label limitations, sparse service days, first-loop fallback, and operational rolling-fit policy remain unchanged. This bounded check validates compatibility with the merged client, not universal accuracy or prospective performance.
