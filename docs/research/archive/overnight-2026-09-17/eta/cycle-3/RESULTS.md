# Same-day service-role persistence: no integration candidate

The longer-history state adds almost nothing beyond a matched two-departure state. Winchester remains worse than the current-code component, with more departures after the upper bound. Union improves modestly over the lap/elapsed/clock core, but nearly all of that extra gain is already obtained with two departures; the recursive state's small additional gain is concentrated on one development date. No application change or full rider replay is justified by this screen. This rejects this bounded feature family, not all possible operating structure.

Baseline HEAD is `948712e153cea1017e9471ce84851a41fae4508a`, supplied by the controller after PR282. Its ETA/calibration files and all saved comparator inputs match the cycle-1 hashes exactly. Branch and HEAD were preserved. All outputs are ETA artifacts; no application, shared planner/wire, database, controller or publication change occurred.

## Frozen question and causal contract

`PLAN.json` predates new extraction, fitting and scoring. Reused the completed cycle-1 cohort, landmark weights, exact core coefficients and current-code component forecasts. No earlier experiment was rerun and no penalty/phase/stop search was performed. The matched core contains lap, elapsed, deterministic 15-minute clock and landmark-origin elapsed. The new feature is based on earlier modern same-stop departures keyed by stable bus name, stop and ET date; there is no fitted vehicle-ID effect.

The recursive complex phase discounts previous information with a two-hour departure-time half-life. Its strength is shrunk toward zero by two pseudo-observations and decreases with circular dispersion. A minimum of two confirmed histories is required. Three jointly fitted columns are confidence times hourly sine, hourly cosine, and confidence. Future clock time is deterministic; histories and phase stay frozen at pin throughout a forecast. The same three-column hazard using only the latest two departures is an architecture-matched ablation. It is **not** the previously tested calibrated slot-center/residual-survival predictor, and it is not a previous-departure-plus-one-hour rule.

Resets cover ET date, known route reassignment, 30–90-minute history gaps, missing confirmed opposite-terminal evidence and excessive phase innovation. Innovation thresholds are the training-only 95th percentiles of adjacent hourly phase changes: Winchester 358.049 seconds from 92 pairs; Union 467.686 from 99. No development outcome chose these thresholds. Current missing/unsupported lap, stale history or absent opposite evidence gets exact core fallback. Twenty-nine distinct historical reset events appear in the evaluated histories; these are missingness/state changes, not outcome exclusions or proved physical role changes. No observed route reset is needed in this cohort; synthetic fixtures exercise that branch.

Departure availability is the existing conservative proxy `max(departed+120 seconds, first_moved+confirm_sec)`. A sensitivity delays it another 120 seconds. Route anchors use anchor+15 seconds. Both are assumptions, not recovered publication receipts. The added delay changes known-time provenance but no selected history/features here, so the two arms' results are identical; this is not independent corroboration. Only outcomes completed before the fit cutoff contribute coefficients/reset scales. Earlier completed development-day departures may update state after their declared known time.

## Cohort, support and results

Original 535 completed true-rest episodes remain: Winchester 102/58/99 and Union 112/61/103 training/calibration/development. Calibration outcomes are not used for new fitting or correction. The four repeatedly inspected development dates remain development, with no later-afternoon or prospective holdout. Both latency contracts retain 722 identical development landmarks and all three candidate/core arms (4,332 forecasts total). No new case was removed; the established restart truncation 65237 remains quarantined. Previously audited genuine regressions remain.

Usable role state exists for 67/99 Winchester and 77/103 Union development visits; 55/65 have three or more departures. Training support is 69/102 and 74/112 visits. Unsupported visits receive the exact core forecast in both added arms. L2 remains 10; eight bounded fits include the identical latency sensitivity and took 1.63 seconds under the shared heavy lock with one BLAS thread.

Primary scores give every visit total weight one across its observed eligible landmarks. Seconds; early means departure before the lower bound, late means after the upper bound:

| Stop / arm | MAE | p90 absolute | WIS80 | Width80 | Early / late weighted rates |
|---|---:|---:|---:|---:|---:|
| Winchester current-code component | 71.72 | 136.36 | 44.52 | 297.38 | 6.1% / 1.0% |
| Winchester matched core | 74.18 | 160.58 | 46.77 | 309.31 | 2.0% / 7.2% |
| Winchester two histories | 73.75 | 160.11 | 46.23 | 301.38 | 2.0% / 8.6% |
| Winchester recursive state | 74.10 | 160.38 | 46.33 | 299.45 | 2.0% / 9.5% |
| Union current-code component | 135.30 | 313.28 | 77.86 | 359.32 | 11.5% / 13.0% |
| Union matched core | 103.37 | 279.78 | 65.24 | 329.33 | 14.0% / 4.8% |
| Union two histories | 101.82 | 282.40 | 64.22 | 323.01 | 13.5% / 5.0% |
| Union recursive state | 101.74 | 282.21 | 64.12 | 322.49 | 13.5% / 5.0% |

Union's recursive improvement over its matched core is 1.63 seconds MAE / 1.12 WIS, versus only 0.08 MAE / 0.10 WIS beyond two histories. Its large comparison with current Union mostly belongs to the already-known different hazard/core, not service-role memory. Winchester recursive MAE worsens by 0.35 seconds versus two histories and by 2.38 versus current-code component. Wider or narrower empirical misses alone do not establish calibrated nominal coverage.

| Date | Winchester WIS core / two / recursive | Union WIS core / two / recursive |
|---|---:|---:|
| Sep14 | 58.03 / 57.38 / 57.36 | 81.79 / 79.56 / 78.95 |
| Sep15 | 42.34 / 41.70 / 41.84 | 51.92 / 51.20 / 51.34 |
| Sep16 | 39.33 / 38.54 / 38.63 | 59.48 / 59.19 / 59.29 |
| Sep17 | 48.14 / 48.37 / 48.69 | 66.13 / 65.38 / 65.41 |

Union core-relative WIS improves on all four dates, but recursive versus two-history improves only Sep14. Winchester recursive beats current component WIS only narrowly on Sep16. The three-or-more-history subset tells the same story: Winchester WIS core/two/recursive 47.22/46.48/46.64; Union 69.80/68.56/68.36. This is not merely a lack of historical support.

Equal-checkpoint WIS also retains the conclusion: Winchester core/two/recursive/current 51.89/51.19/51.34/46.06; Union 59.80/58.58/58.34/77.97. Winchester late misses are 34/39/42/5 of 352 checkpoints; Union 24/25/25/64 of 370. Both weightings, each elapsed checkpoint, date, support, history-count and same-neighbor stratum remain in `scores.json`. Restricted original-cohort rows keep inverse original-landmark-count weights; at a fixed elapsed checkpoint the equal-checkpoint row gives equal visits. Same-neighbor groups remain date-confounded. No significance or calibrated-coverage claim is made from these dependent samples.

## Regressions and continuation

`paired-visits.json` retains every visit comparison; `top-regressions.json` preserves five worst visit-mean WIS regressions per stop, contract and comparator. `verification.json` checks the ten primary recursive-versus-core regressions against complete stopped, non-gap records and outgoing legs. Six have archived raw coverage; four do not. Missing raw coverage does not invalidate their outcomes.

Winchester 48370 (#310, Sep14) has a genuine 120.077-second pin hold and eight prior histories; its mean absolute error worsens about 40 seconds and WIS about 12.83. No archived raw GPS is available for it. The other Winchester cases include 440–509-second holds and a 155-second hold. Union 62056 (#309) retains its **15.002-second** pin hold and 60.006 seconds from anchor to pin. Its 39 surrounding recorded polls have a maximum 5.260-second gap; coordinates change 5.060 seconds after recorded departure. Other Union regressions include 95–245-second holds. There is no new positive measurement-error evidence and no exclusion/clock repair.

For six raw-covered cases, first changed coordinates follow recorded departure by 4.705–5.060 seconds. Five have maximum surrounding gaps 5.113–5.903 seconds; Winchester 65621 has a 21.259-second gap, preserved explicitly. Repeated coordinates are deadband-censored movement evidence, not observed doors, precise physical stillness or driver policy. Original first-receipt pin provenance remains unresolved.

Conditional component continuation at 15-second steps through min(observed hold,900 seconds) has 2,256 Winchester and 2,432 Union adjacent pairs per arm. Winchester has zero median absolute-departure increases above60 seconds in all arms. Union has10 in core and8 in each added arm. No arm has a backward median absolute-departure step exceeding1 second in this diagnostic. These are **not** actual served rider-arrival jumps: there is no GPS state mixture, approach/pin switch or departure transition here. The reused landmark-origin elapsed feature is not a proof of a coherent single total-duration CDF. Legitimate increases were not clamped. Training maximum remaining hold is924.526 seconds, so the1800-second exposure censoring is not exercised by real training data; a synthetic test verifies uncapped continued-tail quantiles.

## Verification and reproduction

All commands below exited0, from the ETA worktree. Logs live beside their scripts. No dependency installation, application typecheck, full suite, Vite build, browser or staging run was needed or claimed for unchanged application code.

```sh
OPENBLAS_NUM_THREADS=1 python /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/cycle-3/run_role.py extract
OPENBLAS_NUM_THREADS=1 python /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/cycle-3/test_role_state.py
flock -w 900 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/heavy.lock env OPENBLAS_NUM_THREADS=1 python /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/cycle-3/run_role.py fit
OPENBLAS_NUM_THREADS=1 python /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/cycle-3/score_role.py
OPENBLAS_NUM_THREADS=1 python /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/cycle-3/audit_results.py
git diff --check && git diff --exit-code && git diff --cached --exit-code && git rev-parse HEAD && git status --porcelain
```

- Six meaningful contract tests passed: causal prior-only selection, delayed confirmation, day/gap/opposite resets, role/route changes, unsupported zero features, circular wrap and uncapped tail.
- All1,070 visit/contract snapshots agree after future primitive events are removed; all1,070 weight sums equal1.
- All1,444 reused-core comparisons match saved forecasts exactly (722 unique checkpoints under two contracts);1,206 fallback checks pass (including core rows).
- Builder verification independently recomputes24 overall metric rows, matches14,864 historical event uses to read-only SQLite, verifies15 unique hash references, ordered quantiles, identical arm cohorts and ten retained earlier audited cases. These are builder checks, not an independent-review approval.
- The inherited current-code comparator remains the exact Winchester release component with frozen preSep10 fit and preSep14 marginal tables, and actual Union marginal/lap fallback. It does not reproduce current six-hour refresh, full live mixture,30-second pooling, future layovers, rider catchability, deadline decisions or both target occurrences. No full-path improvement is claimed.

## Next bounded work

Independent reviewer: inspect this frozen feature/state contract, training-only thresholds, all metric/weighting/date results, original comparator hashes, fallback and the retained15-second Union outcome. Reuse outputs; no reason to rerun cycle1/2 replay or search new hyperparameters. If the negative conclusion stands, advance backlog5's rider decision audit with UX coordination.

The next builder should capture actual current planner/ranking inputs around real wait/departure transitions, separating ETA destination forecasts from pickup catchability and total walking burden. The five cycle2 warm snapshots contain only the focal bus's full state, so they cannot establish complete fleet rankings by pretending other buses are warm. The completed `cycle-4/input-inventory.json` confirms the raw archive contains only Red:12,654 frames,36,516 bus observations,four names. Begin with an explicitly Red-versus-walk diagnostic; all-route comparisons require other existing authorized recordings. Reuse source chains/outcomes; extend continuous replay output only for all observed Red vehicles' required planner state. Predeclare trip geometries/checkpoints and retain both target occurrences/unknown forecasts. `cycle-4/INPUTS.md` gives exact code paths and avoids treating initial `planTrip` output as final live card ranking. No route suppression, hysteresis or walking threshold change is supported yet.
