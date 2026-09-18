# Red Winchester bunching: frozen exploratory screen

**Verdict: no production change and no forced narrowing.** A close-leader correction helped on the reused September 14–17 data but became worse on the reused September 18 data. The untouched afternoon extension contained only one hold where this correction applied. Neither approaching-follower nor same-stop cases had enough training support for a learned gated correction. This does not disprove a driver spacing policy; the available causal snapshot features did not produce a reliable remaining-wait improvement.

All fitting, extension scoring, validation, and runtime-component generation had already finished when the user requested reducing load on the Pi. No owned compute processes remained. Work stopped without running the prepared aggregation/regression script. No application, production, watcher, or repository changes were made.

## Frozen design and data

`PLAN.json` was frozen at **2026-09-18 19:56:13 UTC**. `fits.json` froze coefficients, support, and route travel proxies at **20:00:03 UTC**. The afternoon capture was first opened at **20:06:30 UTC**, after the fits were saved. Its capture time follows the plan freeze. `extension-meta.json` records hashes and timestamps.

Training used 160 Winchester holds on six dates before September 14. The already-inspected comparison set contains 113 holds from September 14–17 and 17 from September 18. The untouched afternoon extension adds eight completed holds: **72874, 73143, 73267, 73480, 73580, 73702, 73860, 73978**. Seven of these have runtime-supported lap times. No new outcome exclusions or residual trimming were introduced. All 298 source holds, including 138 evaluation holds, remain in the emitted forecasts.

At elapsed ages 0, 60, 180, 300, and 480 seconds, while the focal hold continues, each other bus's latest known anchor is selected across **all routes**. A peer must currently resolve to Red, the same day, a valid canonical stop occurrence, and a physical anchor no older than 300 seconds. Same-zone co-anchors make ordering unknown; equal-distance ties are unknown. A single peer can be ahead and behind around the loop and is explicitly flagged. These are observed zone anchors, not proof that both buses are stopped or exact continuously tracked positions.

Primary availability is anchor time plus 15 seconds. The identical fitted coefficients and support rules are also applied with a 120-second delay. Neither proxy establishes exact receipt time. Ahead/behind distances are sums of training-only median inter-stop travel times, excluding future holds: they are **travel-time distance proxies, not actual time headways or predicted peer arrivals**. No future peer path or future realized departure enters a forecast.

The three prespecified arms are:

1. A ten-feature landmark control: elapsed time, lap, 15-minute clock, missing lap, and elapsed age at the forecast origin. L2 penalty 4, except the intercept.
2. Compact spacing: seven supported snapshot terms added as a fixed-control hazard correction, L2 penalty 10 and no correction intercept.
3. A supported bunching gate: close leader/follower/co-anchor and a small balance/freshness correction, with the same fixed-control offset and L2 penalty 10. Outside the supported gate the entire forecast exactly equals control.

Each eligible landmark origin has equal training weight. Its remaining-time risk sequence overlaps other origins from the same hold; longer holds contribute more origins. This is a dependent composite likelihood, **not one independent event-history likelihood per hold**. Neighbor conditions remain the observed origin covariates throughout the learned residual hazard, while own elapsed time and deterministic clock advance. This is a conditional remaining-time model, not a claim that a peer physically stays still.

## Training support

The support rule required at least 20 distinct focal holds and three training dates. Only the close-leader regime qualified:

| Regime | Training holds | Dates | Origins | Learned gate |
|---|---:|---:|---:|---|
| Leader within 180-second travel proxy | 31 | 6 | 72 | Yes |
| Follower within 180-second travel proxy | 7 | 5 | 9 | No |
| Same-zone co-anchor | 6 | 3 | 9 | No |

The distinct-peer balance term had 28 training holds; the close same-peer interaction had only three and was excluded. Unsupported follower and co-anchor regimes receive exact control fallback in the gated arm. Insufficient support is not evidence that these interactions do not matter.

## Primary checkpoint results

All values below are seconds. Lower WIS and MAE are better. Width is the central 80% interval. Counts refer to forecast origins, not independent buses. The control is the matched landmark model, **not the production estimator**.

| Data | Arm | WIS80 | MAE | Width80 | Early / late origins |
|---|---|---:|---:|---:|---:|
| Sep14–17, 113 holds / 398 origins | Control | 43.84 | 68.57 | 295.26 | 23 / 13 |
| Same | Compact spacing | 43.95 | 67.29 | 299.27 | 26 / 9 |
| Same | Bunching gate | 43.73 | 68.16 | 295.35 | 23 / 13 |
| Reused Sep18, 17 / 78 | Control | 66.39 | 105.19 | 372.16 | 1 / 23 |
| Same | Compact spacing | 68.21 | 116.76 | 373.10 | 1 / 16 |
| Same | Bunching gate | 68.67 | 112.06 | 370.93 | 1 / 23 |
| Fresh afternoon, 8 / 26 | Control | 47.19 | 60.45 | 404.46 | 1 / 0 |
| Same | Compact spacing | 46.92 | 61.97 | 393.93 | 0 / 0 |
| Same | Bunching gate | 46.99 | 59.87 | 404.36 | 1 / 0 |

The old compact-spacing early misses affect 22 distinct holds versus 20 for control; its late misses affect three versus four. On reused September 18, compact spacing and control both miss late on six distinct holds despite different origin counts. The gate preserves those overall early/late counts. Individual crossing identities and residual changes have not yet been aggregated or audited; these totals must not be described as a count of newly harmed buses.

Inside the supported close-leader gate:

| Data | Gate support in evaluation | Control → gate WIS80 | Control → gate width80 |
|---|---:|---:|---:|
| Sep14–17 | 20 holds / 39 origins | 52.17 → 51.01 | 436.90 → 437.80 |
| Reused Sep18 | 8 / 20 | 63.79 → 72.69 | 558.57 → 553.77 |
| Fresh afternoon | 1 / 4 | 48.37 → 47.07 | 553.29 → 552.69 |

Thus even the better old gated result did not narrow the interval. The roughly five-second narrowing on reused September 18 accompanied worse forecasts. The one fresh gated hold is insufficient confirmation.

The 120-second availability sensitivity leaves the same conclusion. Overall gate WIS is 43.84 → 43.37 on September 14–17, **66.39 → 69.55** on reused September 18, and 47.19 → 46.67 on the fresh extension. Compact spacing's fresh WIS becomes **49.60**, worse than 47.19 control, despite its small primary-timing improvement. Actual input availability and selected identities therefore matter.

## Prespecified forecast-range subgroups

The bands use the **control-predicted median**, never the realized remaining time. For the supported gate, the 3–8-minute band improved old WIS 40.72 → 39.29 but worsened reused September 18 WIS 57.36 → 62.88. The >8-minute band similarly improved old WIS 62.25 → 61.32 but worsened September 18 WIS 68.08 → 79.24. The ≤3-minute gated band had only one old origin and no reused September 18 origins. There is no demonstrated reliable forecast-range subgroup to promote.

The full prespecified per-date, fixed-age, lap-support, peer-identity, regime, and forecast-band results are preserved in `scores.json` and `extension-scores.json`; unsupported or empty cases must not be presented as positive evidence. No subgroup or coefficient was selected after examining these results.

**Weighting label correction:** saved `weighting="visit"` means the original whole-visit origin weight, 1 divided by that hold's total eligible landmarks. After filtering to a subgroup it is not equal-visit weighting within that subgroup. Those saved results are retained unchanged and should be labeled accordingly. Primary `weighting="checkpoint"` is unaffected; at a single fixed elapsed age, it gives each eligible hold one vote. No refit is needed for this clarification.

## Validation and remaining work

`validation.json` passed before the stop request: 6,426 emitted-arm quantile/probability checks, 6,426 continued-tail checks, 1,826 exact gated-fallback checks, and 226 future-delete/future-perturbation checks across a deterministic sample plus all co-anchor origins and the known early-hold cases. The source/plan hashes match the frozen fits. No future trajectories enter prediction.

`runtime-comparator.json` also completed before the stop request. It contains the unchanged nine-feature runtime component and actual marginal/lap fallback for all 1,071 origins. Its 1,045 previously computed origins match exactly. **It has not been aggregated against these new arms.** This component does not simulate continuous warmed state, live mixtures, route movement, departure recognition, or pickup endpoints; no production accuracy improvement is claimed.

`summarize.py` was prepared but **not run** after the load instruction. Its intended outputs—runtime aggregate comparisons, per-visit WIS changes, all individual early/late crossings, and a bounded raw/source regression audit—do not yet exist. There is no new affirmative measurement-error finding from this screen and no basis to discard any valid short or long hold. Existing difficult cases such as 64318 and 65347 remain in predictions.

The current negative and under-supported result does not justify a full ETA replay or deployment. A later investigation, if authorized and run away from the overloaded Pi, could collect more reliable receipt-timestamped close-follower and simultaneous-stop episodes and test actual observed progress or departures at causal landmarks. It should retain the current frozen results, explicit missing identity states, and genuine regressions. More accurate spacing measurements may be useful; these sparse zone anchors do not establish the driver's decision rule.

## Reproduction status

Completed under the shared heavy-job lock: `screen.py`, `extend.py`, `validate.py`, and `runtime-comparator.mts`. Model and support must remain frozen when reproducing evaluation. The raw capture and source cohort hashes are in `PLAN.json`, `fits.json`, and `extension-meta.json`. No jobs should be relaunched on the Pi under the current stop instruction.
