# Independent review of the Winchester release candidate

Reviewed the uncommitted application changes in `release-integration-2026-09-17`, final paired replay and scores on September 17, 2026. Application and production were not modified by this review.

**Updated verdict: the reviewed blocker is fixed; the forecast behavior supports a limited Winchester rollout once the normal deployment checks pass.** The evidence supports better typical forecasts and stability; it does not establish calibrated probabilities or fewer missed rider connections.

## Release blocker found

`services/shuttle-v2/src/collector/collector.ts:1457` calls `calibrate(this.db, rebuilt)` during `refreshStaticIfNeeded`. That creates a replacement network without the cached lap fits or new release fit, although `runCalibrate` supplies both at lines 1360–1367. A successful periodic static refresh or retry can turn the new forecast and stabilization off until the next five-minute calibration, then turn them back on. This is outside the fixed-table final replay. Calibrate the replacement network with the cached fits before swapping it, and test that static refresh preserves the release model. The parent was notified immediately; this finding describes the tree at review time.

## Statistical and numerical implementation

- `src/calibrator/releaseFit.ts:186–252` uses completed modern pinned holds, prior legacy same-bus departures, and an intervening opposite regulator on the same service day. Current eventual departure is the outcome, not a lap/clock feature. Prior departures must precede pin by 120 seconds; labels must be ready before the fit cutoff. This matches the actual legacy-departure lap clock more closely than the earlier modern-departure component experiment.
- The 120-second rule is a conservative historical availability proxy, not a stored receipt timestamp. `first_moved_at` can be an early shuffle. Historical backfills or very delayed confirmation are not proven available at exactly this proxy. Runtime fitting reads only records already present, so it cannot use future records; retrospective causal claims still need this qualification.
- `releaseFit.ts:60–86` requires 60 holds, three dates and 40 plausible laps; longer completed holds contribute censored exposure through 30 minutes instead of being removed or labeled as departures. These are minimum support checks, not independent calibration guarantees. The audited restart-truncated #316 visit is excluded explicitly; legitimate short and long holds remain.
- The fit is refreshed on the server at most every six hours over a trailing 30-day window. A failed solve/read retains a recent fit and eventually falls back; the fit is attached only to `3:11`. `releaseFitOf` independently rejects other stops, thin/malformed fits, and nonfinite coefficients. Pricing additionally requires Red and matching current rest/pin, with supported lap range. Union and future holds retain their existing distributions.
- `web/src/eta/release.ts:74–152` avoids CDF saturation by retaining finite survival knots and inverting residual survival in log space. Beyond the fitted knots it uses a bounded positive exponential tail. A very long wait therefore does not automatically collapse to zero remaining time. The tail is extrapolation, not evidence that extreme waits are accurately modeled.

## State, distributions and transport

`web/src/eta/index.ts:164–203` retains the lap measured at the actual pinned episode and pools absolute arrival quantiles with a 30-second time constant. Pooling is active only while the belief remains resting at supported Winchester, and stops once that rest ends. It does not alter position beliefs or impose a nonincreasing ETA ceiling. It also stabilizes Winchester's marginal fallback when the lap is missing; this is intentional scope, not evidence that the conditional fit is available in every stopped episode.

Convex pooling of ordered quantiles preserves their order. The piecewise lower-side widening and unchanged upper side in `arrival.ts:906–918` is monotone and preserves a valid ordered forecast representation. Neither transform establishes conditional probability calibration. The point still follows the lead route cluster while the displayed distribution can include route alternatives: it must not be described as universally equal to that distribution's median. The recorded test checks ordered distribution values and that the displayed interval encompasses their central range.

The server requests distributions on every computation and memoizes each collector version, so its normal path pools points, intervals and the distribution together. `serverEta.ts:117–137` serializes the whole store with V8, including the new Map and cached pin. The recorded release test verifies warm restoration and wire equality. Mixed distribution/no-distribution calls sharing a local store are not covered by that server guarantee; avoid adding a new client-only fallback that changes this contract without testing it.

The Dockerfile now explicitly copies `release.ts`; the closure test passes. Fit duration is included in `releaseFitMs` and total event-loop timing. New release coefficients enter the dwell-content fingerprint, so changing fit content invalidates priced tables.

## Final replay and valid regressions

`final-meta.json` reports 16,253 raw frames, 46,790 identical movement-belief comparisons, 302 full-server parity checks and zero lost forecast availability. The first-occurrence score uses exact connected source-target journeys and a 600-second warm requirement; repeated checkpoints share visits and are not independent trials.

| Held-out Winchester checkpoint | Baseline → candidate |
| --- | --- |
| Division, standing +60 seconds, 13 holds | MAE 216.2 → 81.0 seconds; WIS 110.5 → 62.2; width 549.6 → 492.2 seconds |
| Rosenkranz, standing +60 seconds, 13 holds | MAE 125.6 → 105.5 seconds; WIS 96.1 → 76.6; width 813.6 → 621.7 seconds |
| Division, departure +0 | MAE 22.9 → 43.2 seconds; no early interval misses in either arm |
| Division, departure +15 seconds | MAE 25.4 → 36.0 seconds; forecasts identical by +60 seconds |
| Rosenkranz, departure +0 | MAE 114.4 → 117.6 seconds; early interval misses 1 → 2 of 13 |
| Upward jumps exceeding 60 seconds | Division 4 → 1; Rosenkranz 9 → 2 |

Development standing improvements and jump reductions agree with the afternoon result. The departure penalty is real, concentrated around movement confirmation, and modest compared with the standing improvement; it must not be dismissed as corrupt data. Earlier valid short holds 64318/58224 and report115 hold65347 remain valid. The final raw audit of 67957 and 68304 shows continuous five-second GPS, one pin, final 40-second plateaus, movement roughly five seconds after the last frozen poll, and exact onward chains. Retain both. A passed Division target is physical-arrival truth, not proof of a boarding opportunity.

The next-occurrence score excludes ambiguous occurrence boundaries and requires the recorded next physical target through connected legs. It includes unavailable/right-censored cases in accounting. Held-out paired next-occurrence evidence is smaller (172 checkpoints, 12 sources, 14 targets); typical changes are modest and widths can grow. It does not support a claim that every downstream/later-lap interval narrows.

Only one afternoon remains outside earlier development exploration. The refresh policy was declared before reading it; the final Winchester-only restriction followed reviewing Union regressions. This is useful held-out evidence for the frozen Winchester behavior, not an untouched confirmatory test of every final release decision. Future monitoring should retain the same visit-level standing and departure checkpoints, early and late tails, proper scores, missing forecasts and jump counts across new service dates.

## Verification performed independently

`git diff --check` passed. All 28 focused assertions passed across `releaseFit.test.ts`, `release.test.ts`, `serverEta.release.test.ts`, `serverEta.closure.test.ts`, and `collector.fitClock.test.ts`. The test process then failed while writing Vitest's cache through the shared `node_modules` symlink to a read-only path; this was an environment/cache error after the assertions, not an application test failure. The parent's complete test/build and deployment checks remain the release gate.

## Follow-up: refresh blocker resolved

Reviewed the subsequent uncommitted fix in `collector.ts` and regression in `collector.test.ts`. A common `calibrateNetwork(network)` now obtains and times both cached fits, passes them into calibration, and returns the complete timing/count record. Both periodic calibration and topology replacement use it. `ref.replace(rebuilt)` remains after successful calibration; a thrown calibration does not expose the replacement network.

The new regression seeds an actual stopped Winchester record and injects cached release/lap fits. It asserts both fit fields after initial replacement, preserves the old network identity on failed topology fetch, then asserts both fields on successful retry. This directly covers the missing-fit path identified above. `git diff --check` passes on the amended tree. The updated full test run remains the parent's completion gate; the previously inspected 2,733-test success predates this added regression.

Also reviewed `docs/red-current-release.md`. It accurately discloses the post-afternoon site restriction, one-afternoon sample size, stopped-versus-passed endpoints, temporary departure penalties, lack of second-occurrence narrowing, retained legitimate regressions and the separate exploratory predecessor hypothesis. No further release-blocking issue was found within this bounded review.
