# Independent review 13 — cycle-14 cache outcome and restart research

**Verdict: research_only. No application proposal or production approval.** Exact supplied head/base and independently read HEAD/merge-base are `98e535b99649e74ca599d2e33bcfdc46df83d30d`; tree `d0ab5a7678483e956bd1e4072abe92b18a464218`. Candidate, working-tree and index diffs are empty. Reviewer scripts/data are in `review-round-13/`.

## Required artifact correction

**cycle-14/fixture.mts:10 retains mutable ModelEntry references instead of poll-time snapshots.** `[...server.store]` copies the map entries but not their values; `beliefFor` replaces `e.belief` and pricing mutates floors/release memory on those same objects. JSON serialization happens after all polls. In both builder normal runs, poll 0 and poll 10 entries contain poll 39 belief timestamps; all first/last entry arrays are identical. There are 585 future-dated entries per arm. Consequently the submitted fixture does not establish its claimed 60 separate poll-time ModelEntry comparisons, although its separately captured wires and final-state comparisons remain useful.

I preserved all original artifacts and wrote a reviewer-only immutable-capture fixture: `structuredClone` the poll record immediately after `contribute`. No estimator, candidate, calibration, input or acceptance condition changed. Fresh independent builds and three fresh-process restarts per arm now verify actual poll-time entries, maps, typed arrays and seenAt. **The diagnostic matches all 60 restart polls; current code matches 0/60.** All immutable-capture wires exactly equal the original builder wires. Neither immutable arm has future-dated entries, and first/last states now differ. Thus this is a real defect in the submitted evidence capture, not a demonstrated failure of the cache diagnosis.

Before reusing this fixture as a validation gate, carry the immutable capture into the next experiment and annotate the old state proof as superseded by `review-round-13/immutable/` and `independent-audit.json`. Preserve the originals. This is the outstanding artifact finding; it does not call for an application change or another full Red replay.

## Independently supported results

Inspected the actual production kernel and exact single build-time replacement. Production rounds the cache key but computes the gamma kernel with the first caller's unrounded mean. The diagnostic computes at the same rounded tenth used by the key. No new coefficient, threshold search, interval cap, exclusion or neighbor feature is present. Separate fresh processes run both arms with current release ON, the same pre-period marginals/fit and previously declared causal refresh. No future neighbor path or retrospective outcome enters forecast generation.

The locked independent rerun completed all 16,253 original Red polls and 150,020 forecast rows per arm. Twelve substantive outputs, including both raw forecast/tracking streams, paired forecasts, tail audits and export checks, are byte-identical to the builder files. Three full checkpoint-score files match after removing only the input-path metadata. The current arm reproduces all 150,020 archived current-release-ON values after existing rider zero normalization; this is not an old release-OFF comparison. The 151 server target-row assertions per arm are periodic parity checks, not 151 different replay polls.

The independent physical-key join preserves 93,380 first and 56,640 second forecasts, with no differential availability. All 202 hop differences are exactly one hop and leave the traversal classification unchanged. The 3,251 h==29 boundary rows remain explicitly limited by the inherited occurrence contract. Raw negative lower bounds remain 137 current / 136 diagnostic; scoring uses the existing adapter normalization and does not erase the raw evidence.

The rerun verifier checks 327 connected journey uses, 6,674 exact historical leg uses and 3,309 checkpoint truths against the read-only database. My additional verifier joins every scored arm directly to its raw forecast, independently recomputes database truth and checks physical bus/stop identity. Cohorts are 1,908 earlier first checkpoints (78 sources / 94 targets), 600 reused-afternoon first checkpoints (24 / 26), and 801 second checkpoints (54 / 65). Passed/stopped and date counts agree; 318 second checkpoints remain absent in both arms. These share visits and dates and are not independent observations.

| Cohort | MAE current → diagnostic, seconds | WIS current → diagnostic | Early / late misses |
| --- | ---: | ---: | --- |
| Earlier first | 129.11694 → 129.11667 | 91.14196 → 91.13142 | 56 / 61, unchanged |
| Reused afternoon first | 106.36251 → 106.43022 | 79.71868 → 79.74034 | 5 / 13, unchanged |
| Second | 206.18766 → 206.15410 | 145.48338 → 145.48330 | 23 / 16, unchanged |

The practical accuracy evidence is negligible and slightly mixed; there is no demonstrated ETA or walk-versus-bus decision gain. “Early” means actual bus arrival before the forecast lower bound; “late” means after its upper bound. No normality, nominal coverage, boarding guarantee or calibrated on-time percentage follows.

All-poll results also reproduce: 83,757 deduplicated poll-targets from 115,088 source contexts, with unequal repeated-poll weighting. The largest point-error regression is 39.299 seconds. Introduced and resolved tail misses, extra downward jumps, and the 63 lead / 36 rest-stop differences remain. The bounded modulo-29 backward-lead audit reports zero in each arm; it is not an all-route monotonicity proof or permission to constrain ETA increases.

All five raw band changes over 60 seconds remain. The connected second Rosenkranz case increases its upper bound 66.618 seconds with the actual target inside both windows. Four other rows are current/following pairs near two detector arrival labels: targets 61959 and 67028 were recorded 10.034 and 15.077 seconds before their polls. The largest upper-bound increase is 3,753.209 seconds. They remain visible despite lying outside the inherited pre-arrival scoring window. Nearby timestamps are not relabeled as truth, and these changes have not been shown harmless for riders. Previously audited legitimate sources remain; older cases outside this replay are not newly validated. The prior 38 pickup uncertainties, 1,400 older connected outcomes and 442.827-second regression remain separate historical evidence, not resolved by this cache experiment.

The immutable eight-route fixture includes folded/repeated-stop routes 9/10. Each of six restart processes restores 15 vehicles. Diagnostic restart comparison covers 35,066 rows across overlapping windows. Current code changes 2,293 matched rows and 13,085 quantile vectors, replacing 123 hop-qualified keys with 123 others; these are not 123 lost total arrivals. Reversal matches both arms for all 40 polls, consistent with existing server ordering. This captured-payload fixture tests repeatability, not chronological all-route outcome quality or every possible process state.

## Input preparation and next experiment

Independently executed the read-only export verifier, without extracting raw data again: all 197,354 fresh rows in the saved 20,199-poll, 12-route export exactly match original coordinates, identity, time, heading and last-stop fields, with no extras/missing rows and unchanged database hash. At the original Red clocks, projecting lap maps onto the old 11/121 keys reproduces all 46,790 Red bus rows. Expanded lap maps must be shared by both future arms. Collector clocks remain causal reconstructions, not recovered publication/receipt times.

Continue with one fixed diagnostic and current-production comparator in separate full-fleet processes using the saved export. Preserve original ordering, causal calibration, gaps, stale/empty handling and warmup. Keep all routes in the same process because cache population is global; route-isolated replays cannot substitute. Bound the work chronologically if required by the Pi/time budget, saving continuation state rather than selecting easy routes or tail cases. Use repaired stop sequences and explicit stop positions on routes 8/9/10; do not transplant Red's `seq.index`/h>29 join onto repeated-stop routes.

Measure complete connected outcomes for both visits, availability, per-route/date passed/stopped errors and tail misses, forward progress, jumps and the largest legitimate regressions. Add current planner pickup/walk/deadline/ranking decisions on declared cases; neither Red-only target scores nor repeatability establishes those rider effects. Preserve the large post-label tails as a distinct transition audit, without changing thresholds or outcome labels. Reuse the immutable reviewer fixture and existing export; no restart of completed model screens, Red runs or extraction is needed. All inspected dates are reused evaluation. Prior neighbor/service-role evidence remains exploratory and score-dependent, with date-confounded identity groups; no production coefficients are authorized.

## Commands actually executed

From the assigned worktree unless the script changes to `services/shuttle-v2`; `O=/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/review-round-13`:

- `flock -w 900 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/heavy.lock bash $O/run-independent.sh` — exit 0. Fresh two-arm Red builds/runs, original eight-route builds/order/restarts, paired first/second scoring, connected-leg/truth verifier, all-poll/tail audits, raw-export and Red-input checks all pass. Wrapper uses `set -euo pipefail`; exact subcommands are retained in it.
- `flock -w 900 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/heavy.lock bash $O/immutable/run-fixture.sh` — exit 0. Immutable capture, two arms, five fresh processes each; all six restart processes restore 15 entries.
- `python3 $O/immutable/compare_fixture.py` — exit 0. Diagnostic 60/60 actual state/wire restart matches, current 0/60; both reverse runs 40/40.
- `python3 $O/independent_audit.py` — exit 0. Twelve byte-identical outputs, three score-file comparisons, independent occurrence/raw-forecast/3,309 database-truth checks, five retained tails and immutable-state provenance verified.
- `python3 $O/final_integrity.py` — exit 0. Exact head/base/clean tree, all 90 builder files and seven frozen inputs preserved; 299 shared images / 14,159,729 bytes, zero reviewer additions.
- `git diff --check`, `git diff --exit-code 98e535b99649e74ca599d2e33bcfdc46df83d30d HEAD`, `git diff --exit-code`, `git diff --cached --exit-code`, `git status --porcelain` — exit 0 and empty. Exact HEAD/base/merge-base verified independently.

One read-only `rg` invocation returned 127 (tool unavailable); `grep` completed the inspection. No application test failed. No application typecheck, full suite, Vite/browser, Docker, staging, CI or deployment was run or claimed for this empty application diff. No new screenshots, dependency installations, feedback access or external contacts. Latest UX progress/requests through its 05:22 ET independent recovery review were read without modification; its separate map teardown work has no ETA interface dependency.

All owned sessions 56173, 98844, 15872 and 6691 completed. No owned process, browser, server or lock remains. Existing watcher, historical inputs, original builder outputs, tracked files, index/branch and controller/other-team files were not changed. Final integrity evidence is `review-round-13/final-integrity.json`.
