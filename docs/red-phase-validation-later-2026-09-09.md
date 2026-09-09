# Later Red Line phase comparison, September 9, 2026

Across eight Winchester holds, the unchanged phase model with fresh causal history reduced first-total error from **205.02 to 67.54 seconds** and Winchester-to-Division ETA error from **159.23 to 83.88 seconds**. Seven of eight holds improved on each measure. The same model using the older archive-observed history improved much less. Both comparisons use identical eligible baseline observations; none were dropped to choose a favorable result.

This extends the [earlier September 9 evidence](red-phase-validation-2026-09-09.md). It is a newly scored raw-data replay, not recorded prospective rider forecasts. History reconstructed from reducer emissions is explicitly separate from history proven available in archived server snapshots. The [compact JSON](data/red-phase-validation-later-2026-09-09.json) contains exact metrics, all eight examples, clocks, hashes and exclusions; raw inputs and predictions remain in the ignored [local archive](../services/shuttle-v2/store/red-validation-20260909/phase-0955-1359/).

## Both frozen comparisons

Scoring includes issues strictly after **09:55:53.271 Eastern through 13:59:55.364 Eastern**. All earlier Red GPS remains as client-state warmup. The three arms share the same frozen source, fit, production calibration, model parameters and physical scoring targets:

- **Baseline:** no analytic phase context.
- **Archive history:** unchanged phase model with first-archive-observed completed server history. The 158 earlier histories remain available under their original clocks. Another 228 completed histories were first archived at 14:00:03.145, after the last GPS observation, so they cannot influence this window. They are never backdated. This policy does not imply the live server lacked newer history.
- **Causal history:** the same phase model with complete, immutable visits emitted by the existing production reducers while processing the raw GPS stream. `knownAt` remains the emission poll clock. Current or future visits cannot enter history before that clock and the runtime's existing visit-origin gates. This reconstructs availability; it does not establish what was served live.

| Measure | Paired population | Baseline MAE | Archive-history phase | Causal-history phase |
| --- | ---: | ---: | ---: | ---: |
| Winchester first total estimate | 8 holds | 205.02 s | 195.29 s | **67.54 s** |
| Winchester remaining time | 118 moments / 8 holds | 123.43 s | 125.60 s | **81.36 s** |
| Division ETA during a complete Winchester hold | 120 moments / 8 arrivals | 159.23 s | 130.21 s | **83.88 s** |
| All Red ETA, secondary | 4,644 moments / 228 arrivals | 75.53 s | 73.09 s | 67.79 s |

The causal-history first-total MAE change is −137.49 seconds, with a paired visit-bootstrap 95% interval of **−220.91 to −59.67 seconds**. Its Division ETA change is −75.36 seconds, with a paired arrival-bootstrap interval of **−111.67 to −39.83 seconds**. Both buses improve on average for both measures. These are eight visits from two buses on one service day; the intervals do not establish reliability across service days.

Archive-history first totals improved on only 2 of 8 holds, and remaining-time error slightly increased. Its first-total and Division ETA intervals both cross zero. The causal arm changes both availability and the representation of completed visits, so this comparison does not isolate receipt latency alone. It supports the complete causal-history policy in this window, without identifying the earlier live delivery failure or validating a new model.

## Every first-total estimate

Values below are rounded to the nearest second. They are total estimates from `shown.typicalSec`, **not transcriptions of the current UI**, which presents ranges. The actual duration uses the reconstructed complete pinned hold.

| Bus | First recorded time, Eastern | Actual hold | Baseline | Archive-history phase | Causal-history phase |
| --- | --- | ---: | ---: | ---: | ---: |
| #306 | 09:56:23.365 | 5m 00s | 4m 50s | 5m 53s | 5m 53s |
| #119 | 10:21:47.666 | 12m 05s | 4m 50s | 15m 22s | 15m 22s |
| #306 | 10:52:17.794 | 8m 40s | 4m 50s | 4m 21s | 8m 40s |
| #119 | 11:27:18.140 | 7m 30s | 4m 50s | 4m 21s | 9m 03s |
| #306 | 11:54:18.289 | 7m 20s | 4m 50s | 4m 21s | 6m 50s |
| #119 | 12:22:03.222 | 11m 50s | 4m 50s | 4m 21s | 13m 06s |
| #306 | 12:55:03.513 | 5m 50s | 4m 50s | 4m 21s | 6m 02s |
| #119 | 13:32:24.539 | 1m 55s | 4m 50s | 4m 21s | 3m 14s |

The causal model's sole worse first estimate is the first #306 hold: baseline error was about 10 seconds, versus 53 seconds with phase history. For the 12-minute #119 hold, phase is substantially closer than baseline but still overestimates by about 3m 17s. These examples remain in the primary results.

## Overestimation and uncertainty

The causal model removes many large underestimates, but it shifts average errors above the observed durations. Mean signed error changes from −161.25 to +60.21 seconds for first totals, from −41.27 to +76.87 seconds for remaining time, and from −132.70 to +56.71 seconds for Division ETA.

| Error more than 2 minutes | Baseline | Archive-history phase | Causal-history phase |
| --- | ---: | ---: | ---: |
| First totals overestimated | 1 / 8 holds | 2 / 8 | 1 / 8 |
| First totals underestimated | 5 / 8 holds | 4 / 8 | 0 / 8 |
| Division arrivals with any overestimate | 1 / 8 arrivals | 2 / 8 | 3 / 8 |
| Division overestimate rate, equal target weights | 3.13% | 21.38% | 13.92% |

The causal Division overestimate-rate increase has a paired target-bootstrap 95% interval of −7.21 to +36.83 percentage points, so its size is uncertain. Remaining-time overestimate rate rises from 13.89% to 18.55%, also with an interval crossing zero. Smaller mean absolute error does not establish improvement for every wait or error tail.

For Division ETA, the nominal 80% interval covers 89.82% of baseline targets' issue moments versus 98.50% with causal history, using equal target weights. Average interval width rises from 587.15 to 668.41 seconds. The higher coverage comes with wider intervals and positive bias. These are ETA quantile intervals, not measurements of the standing chip's literal screen text.

## Source, history and cohort safeguards

The replay source is **`e332cbaa9cfc4911bc97776d8103b64cb5437084`** in `/home/gwarren/wt/pr184-feedback/services/shuttle-v2`. The PR worktree subsequently merged newer master changes and is **not** the replay source. No runtime source, fit or coefficient changed during this comparison.

The shared source database is the copied `production-2026-09-09-0046.db`, SHA-256 `3497051dda04ab85d46949573b96605dcb5e1f9fe708450fddc926a544e773fa`. The table/fit cutoff is `2026-09-09T04:47:00Z` (00:47 Eastern). The unchanged operational fit hash is `207a38440ecea00d54409365ce29999df2d43869c08de63d2b4aa15aca9d1de8`, and published parameter hash is `13dfdd9743d91f0f4c7eac675578ec0f6c34da31bb2db1aa418a74b521639ff9`. The fit contains no September 9 service-day training. Earlier source/UI decisions may reflect operator examples, so this is not a claim of globally untouched outcomes.

The new raw capture contains 5,720 Red rows across 2,892 polls; the warmup union contains 9,539 rows. The retained 09:55 and 14:00 geometry agree exactly on canonical pattern `3:643d62cc87a5f1be71b3cfef`, its 29 occurrences, stop coordinates and route path. There is no per-GPS geometry version to prove that no intervening change occurred. A #119 bus-ID handoff near 13:58 has a 124.879-second gap; the physical builders keep track boundaries. No continuous-track gap over 30 seconds occurs within either main bus-ID track.

The causal-history dataset contains 386 complete emitted visits; 8 censored records are excluded. Features use a whitelist of visit identity, occurrence, observed clocks, completion, pattern and emission provenance. Original-label matches, later revisions and future target fields are excluded. The existing runtime requires history known by the server-observed rest origin and a departure before that origin; the browser separately checks source clocks against its retained origin. Prefix-invariance checks passed for 62 synthetic and 5 already examined warmup prefixes: complete histories available by a prefix boundary were unchanged when later GPS was appended.

The original scoring functions remain unchanged, with only the predetermined issue window updated. They select the original first valid recorded estimate across the full capture before window and pairing exclusions. Five earlier first estimates are excluded without promoting later rows. All eight eligible first estimates pair in both comparisons; no first or eligible standing moment is unmatched. Each arm records 140 Winchester stand rows after the cutoff: 118 associate with complete holds, and 22 outside complete holds are counted as exclusions.

Division targets are the first future corroborated served 50-metre crossing while the query bus is uniquely in a complete Winchester hold: same continuous track, current GPS outside the radius, within 30 minutes, and one of the next five served occurrences. Both comparisons retain exactly the same baseline primary keys. Every primary first-total estimate and all 120 Division vectors change in each phase arm. The archive and causal arms record 2,141 and 2,030 successful Winchester lookup calls respectively; these repeated function calls establish activation, not independent observations.

All 168 frozen source/input hashes and the copied prediction artifacts passed checks after scoring. An independent audit reproduced the primary arithmetic, original-first selection, complete emitted-history projection and all 120 physical target associations. This persistent-client replay is distinct from the [completed full-day Trip/rider simulations](red-rider-full-days-2026-09-09.md), whose opening state, target radius and scoring units differ. Those runs improve the targeted first ETA on both days, but later estimates and sequence diagnostics remain mixed.

## Reproduction

The ignored archive preserves `registration.json`, `launch-manifest-v3.json`, both history datasets, source hashes, prefix proof, all three runs and both score reports. The original two-arm registration remains preserved. The frozen v3 launch manifest has SHA-256 `60cfc4203d2890b0c76f25a07e6c85e296fb2a3cf94f3bf9c97b4b0309713d99`.

From the repository root, reproduce both scores from the saved predictions using fresh output directories:

```sh
phase_artifacts=services/shuttle-v2/store/red-validation-20260909/phase-0955-1359
PYTHONDONTWRITEBYTECODE=1 python3 "$phase_artifacts/score_three.py" archive "$phase_artifacts/rescored-archive-v3"
PYTHONDONTWRITEBYTECODE=1 python3 "$phase_artifacts/score_three.py" causal "$phase_artifacts/rescored-causal-v3"
```

`score_three.py` verifies the frozen hashes and imports `original_study_score.py` unchanged. Its pair-specific manifests retain both comparisons, original-first rules and the same baseline observations. It requires the pinned source checkout and local raw artifacts. The launcher and complete per-arm commands are preserved in `launch-v3.py` and `launch-manifest-v3.json`; they reject existing run outputs. Regenerating forecasts requires a fresh registered output location and the pinned e332 source, rather than the current PR runtime. No new model or parameter selection follows from these scores.
