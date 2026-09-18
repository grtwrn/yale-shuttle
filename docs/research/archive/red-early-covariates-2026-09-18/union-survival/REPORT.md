# Own Union departure age: remaining-wait screen

**Verdict: a small additional predictive signal, but not enough standalone rider benefit to prioritize full ETA integration over the remaining episode-clock and departure-transition issues. Keep it as a possible low-cost feature for a later combined model. No model was deployed or application code changed.**

The matched supported-lap comparison improves WIS by about 0.9% over September 14–17 and 1.9% over nine September 18 holds. It narrows the average current-wait window by only four to six seconds. The larger all-case September 18 gain is concentrated in three unsupported-lap holds; production uses a different marginal fallback there, which this candidate must preserve. The two new early-bound crossings are two valid journeys with only 0.29 and 1.42 seconds of new shortfall. They are not a reason to discard the candidate, but the overall incremental benefit remains small.

## Prespecified model and causality

Two arms use the same 160 training holds on six dates, with outcomes available before September 14 at 00:00 ET. Each hold contributes one ordinary 15-second event-history likelihood. There are no repeated-landmark fitting weights, outcome trimming, hyperparameter search or calibration. The baseline is the existing nine-feature elapsed/lap/15-minute-clock hazard; the added arm includes only time since the bus’s own prior Union departure and a missing indicator, with fixed L2=4. The Union departure is known at least 120 seconds before pin, same-day and within two hours, then latched. Its age advances deterministically. Every source origin matches the parent classifier at all landmarks; none changes. The two parent peer-availability regimes are identical for these own-bus features, so fitting duplicate regimes adds no information.

This is a conditional known-rest component forecast. Historical pin availability is still proxied; there is no live state mixture, 30-second arrival pooling, route endpoint, pickup catchability or class-arrival evaluation. September 14–17 is reused development. September 18 was already inspected in the binary screen and is separate chronological follow-up, not untouched confirmation.

The Union-age coefficient is predictive, not proof of a dispatch rule. Advancing Union age includes elapsed time, which is already in the baseline; ridge can redistribute regularization between these correlated terms. A static bus identifier also does not identify a driver.

## Matched supported-lap results

Seconds; lower MAE/WIS is better. Counts are checkpoints, not independent journeys. Totals weight each visit equally across its eligible landmarks, a descriptive sampled-landmark population rather than calibrated live per-poll risk.

| Period | Cohort | Visits/checkpoints | MAE | WIS80 | Width80 | Early misses | Late misses |
|---|---|---:|---:|---:|---:|---:|---:|
| Sep14_17 | lap_supported | 100/343 | 69.45 → 69.18 | 44.26 → 43.85 | 298.1 → 292.6 | 21 → 23 | 8 → 8 |
| Sep18 | lap_supported | 9/41 | 85.13 → 80.51 | 58.46 → 57.35 | 377.8 → 373.5 | 1 → 1 | 8 → 9 |

Early means departure before the lower bound; late means departure after the upper bound. Supported-lap lower-quantile pinball loss changes 13.93→13.89 seconds on older dates and 27.87→27.66 today. There is no convincing fix to the problematic early-departure tail, and no reason here to raise a rider’s minimum waiting time.

## Exact runtime component and unchanged fallback

The unchanged runtime loader independently reproduces all 160 training rows. Baseline coefficients differ by at most 0.00000070; supported quantiles differ by at most 0.000176 seconds. The following comparison applies the added hazard only inside the existing lap support gate and preserves actual runtime marginal/lap fallback byte-for-byte outside it. Frozen pre-September-14 tables and fits are used; this is not a live six-hour refit replay.

| Period | Cohort | Visits/checkpoints | MAE | WIS80 | Width80 | Early misses | Late misses |
|---|---|---:|---:|---:|---:|---:|---:|
| Sep14_17 | all | 113/398 | 75.80 → 75.56 | 47.57 → 47.21 | 317.2 → 312.3 | 23 → 25 | 9 → 9 |
| Sep18 | all | 12/55 | 134.81 → 131.35 | 91.28 → 90.46 | 395.4 → 392.2 | 1 → 1 | 18 → 19 |

For contrast, applying experimental hazards even to unsupported laps would change today’s three fallback-hold MAE 242→197 and WIS128→106. That is not a measured production improvement and is excluded from the gate-respecting comparison above.

## Fixed-age equal-visit checks

Each row gives every surviving supported visit equal weight, avoiding the inverse-eligible-landmark weighting issue.

| Period | Age | Visits | MAE | WIS80 | Width80 | Early misses | Late misses |
|---|---:|---:|---:|---:|---:|---:|---:|
| Sep14_17 | 0 | 100 | 71.4 → 70.5 | 47.86 → 47.21 | 350.4 → 344.5 | 3 → 4 | 2 → 2 |
| Sep14_17 | 60 | 97 | 69.9 → 69.5 | 46.43 → 45.94 | 331.9 → 326.0 | 3 → 4 | 2 → 2 |
| Sep14_17 | 180 | 68 | 71.2 → 71.1 | 45.30 → 45.05 | 300.9 → 297.1 | 5 → 5 | 2 → 2 |
| Sep14_17 | 300 | 51 | 70.8 → 70.8 | 42.93 → 42.76 | 266.3 → 263.5 | 5 → 5 | 2 → 2 |
| Sep14_17 | 480 | 27 | 58.0 → 57.9 | 35.56 → 35.08 | 215.1 → 209.9 | 5 → 5 | 0 → 0 |
| Sep18 | 0 | 9 | 127.5 → 112.2 | 80.76 → 76.04 | 489.8 → 483.6 | 0 → 0 | 2 → 2 |
| Sep18 | 60 | 9 | 103.8 → 94.9 | 70.69 → 68.20 | 461.6 → 456.2 | 0 → 0 | 2 → 2 |
| Sep18 | 180 | 9 | 70.6 → 71.5 | 53.90 → 54.80 | 384.4 → 380.5 | 0 → 0 | 2 → 2 |
| Sep18 | 300 | 8 | 73.0 → 72.6 | 51.37 → 51.87 | 318.7 → 315.1 | 1 → 1 | 1 → 2 |
| Sep18 | 480 | 6 | 64.5 → 63.1 | 43.29 → 42.91 | 248.9 → 244.1 | 0 → 0 | 1 → 1 |

## Per-date supported visits

| Period | Cohort | Visits/checkpoints | MAE | WIS80 | Width80 | Early misses | Late misses |
|---|---|---:|---:|---:|---:|---:|---:|
| 2026-09-14 | lap_supported | 23/85 | 95.69 → 96.00 | 57.40 → 57.08 | 357.2 → 349.7 | 7 → 8 | 0 → 0 |
| 2026-09-15 | lap_supported | 19/66 | 46.33 → 47.50 | 33.75 → 34.03 | 264.0 → 261.0 | 4 → 4 | 0 → 0 |
| 2026-09-16 | lap_supported | 30/93 | 59.75 → 57.87 | 39.61 → 38.48 | 292.2 → 284.7 | 4 → 5 | 0 → 0 |
| 2026-09-17 | lap_supported | 28/99 | 73.98 → 73.97 | 45.58 → 45.40 | 279.1 → 275.4 | 6 → 6 | 8 → 8 |
| 2026-09-18 | lap_supported | 9/41 | 85.13 → 80.51 | 58.46 → 57.35 | 377.8 → 373.5 | 1 → 1 | 8 → 9 |

## Genuine regressions and threshold crossings

All reviewed visits remain. The new early misses are distinct journeys:

- **45643, #316, September 14, pin+0:** actual59.98 seconds; lower bound57.61→60.27, creating0.29-second shortfall. Complete non-gap stopped visit, three rest polls, one shuffle, closest69.5m. There are no raw fixes from this date in the two available archives; no positive error evidence justifies removal.
- **58717, #309, September 16, pin+60:** actual110.10 seconds remaining; lower105.67→111.52, creating1.42-second shortfall. Complete non-gap stopped visit, eight rest polls, three shuffles; raw-frame evidence is saved in the audit.
- **70719, #306, September 18, pin+300:** actual340.05 seconds remaining; upper342.25→333.02, creating7.03-second late shortfall. It was already a visit with late misses at other ages: today’s number of distinct late-miss visits stays two. Raw and adjacent-event evidence is saved.

The extra early crossings raise distinct affected supported visits from19 to21 across older dates, not just checkpoint counts. Existing difficult early cases64318 and65347 are retained: at+60 the former’s lower-bound shortfall increases33.72→35.14 seconds; at+480 the latter changes31.37→31.15 seconds. This feature does not explain away those genuine early releases.

`regression-audit.json` includes the top five supported WIS regressions in each evaluation period, original visit records, neighboring leg records, raw continuity/plateau summaries where available, and all new bound crossings. Real waits range well beyond the early cases; no removal is based on residual, shortness or model disagreement.

## Reproduction and next action

Run `screen.py`, `runtime-comparator.mts` from the v2 app cwd, then `finish.py`, each computational step under `overnight-2026-09-17/heavy.lock` with one BLAS thread. `PLAN.json` preserves the frozen definition and input hashes; `fits.json`, `predictions.jsonl`, `scores.json`, `runtime-gated-scores.json`, `runtime-comparator.json` and `regression-audit.json` retain every arm and subgroup.

The incremental feature is cheap enough to retain in the research backlog. The present four-to-six-second narrowing and nearly unchanged lower-tail score do not justify claiming a useful new rider ETA improvement. If later combined with a causally corrected wait-origin model, evaluate its incremental contribution with the same support gate, true short holds, continuous warm state, departure transitions, both target occurrences and new service dates.
