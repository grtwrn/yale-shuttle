# PR 184 rider replay review

This follow-up addresses [the September 9 review](https://github.com/grtwrn/yale-shuttle/pull/184#issuecomment-5604222448) from a separate worktree based on `281672a`. It changes replay coverage and regression tests, then integrates the newer pause display to resolve PR conflicts. The selected model, fitted weights, ETA/filter mathematics, and arrival-frozen history guards remain unchanged.

## What the review established

The full-day `red-cand` report used a clean `281672a` client with the stock rider simulator, which had no standing-context injector. Its fallback predictions matched the baseline. The context and lookup counters came from a separate, modified midday run (`red-mid-cand`), using 33,185 positions and 2,129 polls from 11:00–14:00 Eastern on September 4. Both reports used `PAYLOAD_PATCH=null`.

The simulator's default calibration reconstructs legacy arrival-to-arrival `avg` and `med` fields. It does not supply the current production standing `q`, driving `dq`, or pace distributions. In that fallback, a hop already contains the stand (`includesStand=true`), so the client correctly avoids adding a separate standing distribution to the arrival forecast. The standing display also lacks the measured duration quantiles it requires. Adding a context hook alone does not reconstruct the current production inputs.

Payload acceptance and current-stand activation are separate measurements. A bus carries contexts for multiple route occurrences; accepting a context at another stop does not make it usable for the inferred current stop. Nor is server/client clock equality required: `forecastForStand` only requires that the source history and fit predate the client's retained visit origin. Moving those guards to query time would change the selected model's information policy.

## Exact midday reproduction

The isolated run reproduced all 1,869,124 bytes of the reviewer's midday waits file: SHA-256 `41fe768c2e0b3e19a08c4cb3ccfe9a71fc5d206e8fa81dc6505f3d607212a4b3`. Instrumenting the unchanged client in memory recorded **1,129,800 accepted contexts, 8,731 lookup calls, and zero hits**. Every failed call had an empty or absent context map; **zero failed a clock guard**. These are whole-run counters; the review quoted its intermediate poll-2,000 counters.

The full-day fallback files also match: 6,641,458 bytes, SHA-256 `fe8ad5d0f93f44013c0b40c2363ca29c9ea45cbd2131f996775e3d5031252e74` in both arms. That comparison did not enable standing contexts.

Changing **only the calibration payload** in the reproduced midday run produced **70,400 successful lookups, including 21,528 at Red stop 11 / occurrence 14 (344 Winchester)**. Both runs had zero clock-guard rejections. The replacement tables came from the actual production calibrator and serializer at the frozen September 4 04:00 UTC cutoff. The model, context hook, server clock fields and client code stayed identical. This isolates the missing calibration as the cause of the zero-hit result; it is not an isolated accuracy comparison, because the tables changed too.

## Reproduce with the revised rider simulator

Run from `services/shuttle-v2` with Node 22.15 or later. Supply the immutable capture, standalone SQLite snapshot and original development fit identified in the accompanying [audit data](data/pr184-rider-activation.json). The fit timestamp is a retrospective training cutoff, not a claim that the model was published on September 4. Its recorded training day is September 3; September 4 remains development data.

```sh
export TZ=America/New_York
export CLIENT_ROOT="$PWD" SOURCE_ROOT="$PWD"
export REPLAY_DB=/path/to/snap-0904-2205.db
export CAPTURE=/path/to/cap-midday-0904.jsonl
export EVAL_DATASET=/path/to/dataset-v2 EVAL_DAY=2026-09-04
export ANALYTIC_FIT=/path/to/remaining-objective-corrected/fit.json
export REPLAY_CALIBRATION=production REPLAY_FIT_AT=2026-09-04T04:00:00Z
export REPLAY_OUT="$PWD/store/rider-activation"
export ROUTES=Red HOLDOUT= CHAIN=none POP=none STANDING_AUDIT=1
export RIDER=Red@48@2026-09-04T15:00:01Z,Red@48@2026-09-04T15:30:00Z,Red@48@2026-09-04T16:00:00Z,Red@48@2026-09-04T16:30:00Z,Red@48@2026-09-04T17:00:00Z,Red@48@2026-09-04T17:30:00Z

OUT_NAME=baseline node --import tsx scripts/eta-replay/rider-sim/run.ts
OUT_NAME=candidate \
  STANDING_HOOK="$PWD/scripts/eta-replay/general-eval/models/analytic-client-hook.ts" \
  STANDING_HOOK_ROUTES=3 STANDING_REQUIRE_CELLS=3:11:14 \
  node --import tsx scripts/eta-replay/rider-sim/run.ts
```

Production mode uses complete split tables at a single causal cutoff, shared by both arms and required to equal the immutable fit's timestamp. It rejects a later cutoff, a patched mixture of tables, a live WAL-backed snapshot, changed inputs, and output overwrites. The feed now includes production's `last_moved_at`; it does not add the absent `seen_at` field. Cross-worktree parameter overrides apply to the client being tested.

The hook automatically enables an offline loader that counts real post-guard lookups without editing client files. Each `*.standing-audit.json` separates accepted contexts, missing occurrences and individual clock rejections, with per-cell counts and bounded bus/clock examples. Counters count calls, not independent visits. The loader verifies both the source hash and transformation anchors; changed client code requires reviewing the instrumentation before scoring it. Tests compare instrumented and uninstrumented distribution outputs exactly.

A hooked candidate with zero hits exits **2**, and `STANDING_REQUIRE_CELLS` can require the particular route/stop/occurrence under review. `STANDING_ALLOW_UNUSED=1` permits an explicitly labeled unused-model diagnostic; it does not waive required-cell failures. To reconstruct the review's original wire, use `REPLAY_CALIBRATION=legacy LEGACY_BUS_CLOCKS=1`, unset `REPLAY_FIT_AT`, and use a new output name. Such a run still lacks production split tables unless `PAYLOAD_PATCH` supplies them.

The six recorded waits above passed with **1,724 successful lookups, including 1,067 at Winchester**, and changed all six display sequences. A recorded hit for bus `#304` has a positive 0.3082 Winchester weight, matching server `at_stop_id=11`, and a client origin 5.158 seconds earlier than the server origin; its prior history predates both. The same six waits with the original legacy inputs correctly exited 2 with `candidate_unused`. Both successful arms passed the immutable-input checks.

This small development-day smoke test is not an accuracy acceptance cohort. At 15-second sampling, strand flags rose from one of six waits to two of six. The complete paired summaries are retained in the audit data rather than presenting changed forecasts as a universal improvement.

## Regression coverage

`web/src/eta/standingForecast.client.test.ts` exercises `computeUpcomingArrivals`, per-browser state, `resolveStandingStop`, and `shownStandSec` together. It checks that:

- A positive-weight context changes an actually standing bus's downstream ETA and its total/remaining standing display, with a successful lookup required.
- The contextual departure probability affects a fresh GPS fix at the predicted release.
- An accepted context for another occurrence gives zero current-stand hits and unchanged predictions.
- Legacy arrival-to-arrival tables retain their fallback behavior without double-counting the stand.
- An earlier retained client clock still activates the context when its sources predate both clocks.
- History available after the client's visit began is rejected even if payload decoding at query time succeeds.

These tests establish activation and fallback behavior, not accuracy on an independent service day.

## Compatibility with the newer pause display

While this review was underway, master added the remaining-wait interval and running-long indicator (#185/#186), plus the operator visualizer (#187). Master was merged into the PR branch to resolve its conflicts and allow CI to run; master itself was not changed by this work.

The new shared `standWaitFor` display helper must receive the same visit context as ETA pricing. The merged code forwards that context through the helper and returns contextual q10/q50/q90 from one remaining-time distribution. It preserves the new interval and running-long presentation. Display sample counts use the standing quantiles' `qn` when supplied, with legacy `n` as fallback. Regression tests check contextual interval/ETA consistency, fallback parity and sample-count gating.

On the combined source, all 2,281 tests, backend/frontend typechecks and the frontend build pass. The six recorded rider waits were rerun in both arms; each waits file is byte-identical to its pre-merge counterpart, and the candidate still records 1,067 Winchester activations. These compatibility checks do not add an independent accuracy cohort.

The later evidence-only update triggered CI against master's new server-ETA foundation (#188). Its static server imports reach this PR's `standingForecast.ts` and `standingDistribution.ts`, so both modules must also be copied into the backend image, even when the server-ETA flag is off. The image's import-coverage test caught the first missing module but its line-based parser missed the second module's multiline import. The PR now packages both and uses the existing TypeScript parser in that test to follow multiline imports and re-exports. All 20 focused dependency tests pass. The separate replay worktree remains pinned to `e332cba`; this packaging integration does not alter those recorded experiments.

## Limits of the accuracy evidence

At the original review, there was no independent Red Line confirmation cohort. September 4 was used for development. The strong Red Winchester first-total result, 134.86 → 71.17 seconds across 25 visits, comes from the previously inspected September 8 regression cohort. The separate September 5–7 confirmation contains no Red observations. Its component remaining-time MAE was 46.87 → 44.42 seconds, with a descriptive vehicle/day interval of −5.51 to −0.69 seconds for the difference. The September 9 network scorer initially stopped on duplicate rider-query/physical-target keys; Red had no such duplicates and was subsequently scored with the unchanged registered scorer. That early recorded window delivered no Winchester contexts and left Winchester estimates unchanged. A later September 9 raw-data replay, newly scored with the unchanged phase fit, improved first-total MAE from 188.53 to 40.10 seconds across three holds and Winchester-to-Division ETA MAE from 119.24 to 48.70 seconds across three arrivals. One arrival worsened and the ETA interval crosses zero. These are paired replay results from two buses, not recorded phone forecasts or a strictly held-out claim: an earlier operator example may describe the same long hold, and its identity remains unresolved. See the [September 9 Red evidence report](red-phase-validation-2026-09-09.md) for provenance, activation, exclusions and all three examples.

The saved general client replay maintains browser state from the beginning of the capture and queries every stop, retaining approximately every sixth poll for scoring. The rider simulator opens a Trip once, retains that rider's state, and follows plan-time pins and subsequent display changes. The former demonstrates persistent-client ETA and standing-display effects; it does not by itself validate the complete Trip sequence.

Rider-simulator first-promise median absolute miss uses displayed minute buckets and a 45-metre curb target. The general client report uses point-forecast MAE and independently corroborated 50-metre served-arrival targets. Their absolute scores must not be compared as interchangeable measurements.
