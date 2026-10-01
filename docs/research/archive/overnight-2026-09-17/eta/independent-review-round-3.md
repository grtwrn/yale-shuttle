# Independent ETA research review — round 3

Verdict: **research_only**. The completed screen supports making no service-role integration change. No blocking finding prevents moving to the Red-versus-walking decision audit. This is not approval of production coefficients or a measured improvement in rider arrival times.

Exact supplied base and independently observed HEAD are both `948712e153cea1017e9471ce84851a41fae4508a`. The candidate diff, working-tree diff, index diff and porcelain status are empty. Review began at2026-09-18 03:52 UTC. Reviewer scripts, outputs and logs are in `review-round-3/`; the builder's frozen artifacts remain unchanged.

## Independently verified

Read the handoff/backlog/first task, current progress/checkpoint/review notes, cycle3 plan/code/results, prior service-role and follower evidence, current Red release documentation and CLAUDE's v2/data/ETA/verification guidance. Read UX progress/requests through23:51: feedback/reply accessibility work has no ETA interface conflict.

- Fifteen frozen input/code hashes and three fit-provenance hashes match. All24 builder artifact hashes and nine cycle4 inventory hashes match. Current-code component inputs remain the previously audited inputs at the supplied new base; no runtime comparator regeneration is claimed in this review.
- Independently rebuilt all1,070 per-visit/contract phase states directly from read-only SQLite, without using the builder's state implementation. Same-day stable bus identity, completed-history timing, all-route reset anchors, gap/opposite/innovation resets, confidence, missingness and fallback agree. All14,864 selected history-event uses and1,070 landmark weight sums agree.
- Independently rebuilt191 training-only adjacent-departure pairs. Their95th-percentile reset thresholds match Winchester358.049050sec and Union467.685600sec. New coefficient objectives use only training outcomes available beforeSep10. Calibration outcomes are unused.
- Independently checked all eight saved penalized objectives and gradients without refitting. Maximum gradient is2.925e-6. The core coefficients exactly equal the frozen cycle1 core. Unsupported state falls back to that core, not to a newly selected arm.
- Independently reconstructed all4,332 candidate quantile triples with separate design and cumulative-hazard inversion. Maximum difference is1.14e-13sec. Recomputed all480 aggregate/stratum score rows, including empirical weighted median/p90 brackets, both tails and both weightings.
- Checked every one of3,898 inherited landmark rows against the original cohort. All535 visits and the102/58/99 Winchester and112/61/103 Union partitions remain. Every arm/contract has exactly the same722 development checkpoints and current-comparator timestamps/outcomes. All1,949 primary/delayed feature states match after removing known-time provenance; identical sensitivity scores are therefore not independent confirmation.
- Independently recomputed1,212 paired visit comparisons and all12 top-five selections. All ten selected regressions have completed non-gap rest records and matching outgoing legs. All ten earlier audited development IDs remain. No new exclusion is supported.
- Independently rescanned recorded coordinates for the ten selected regressions: six have raw coverage and four do not. Union62056 retains its15.002sec pin hold and60.006sec pre-pin interval,39 polls,maxgap5.260sec and first changed coordinate5.060sec after recorded departure. Winchester65621 retains its21.259sec recording gap. The other measured first changed coordinates agree as well. Repeated coordinates remain deadband-censored evidence, not proof of stationary doors or driver intent.
- Executed all six builder contract tests successfully, including unsupported zero features, resets, delayed histories, phase wrap and an uncapped beyond-horizon tail. Maximum actual training remaining hold is924.526sec; the1800sec likelihood-censoring branch is not exercised by this historical cohort.

## Interpretation and limits

The modest Union signal survives the matched-core comparison, but almost none is incremental to the matched two-history phase: primary MAE101.82→101.74sec and WIS64.22→64.12. Recursive-versus-two-history WIS improves only onSep14 and slightly worsens on the other three inspected dates. The larger comparison against Union's current marginal component mainly measures the previously known different hazard/core. It is not new evidence for deploying longer history.

Winchester recursive MAE/WIS74.10/46.33sec are worse than current-code component71.72/44.52 and two-history73.75/46.23. Its primary late rate is9.5% versus current1.0%, while early misses decrease; neither tail alone establishes calibration. Equal-checkpoint results preserve the no-integration conclusion. The earlier neighbor results remain score/weighting-dependent, including log-loss gains with flat/slightly worse Brier and date-confounded identity groups.

One interpretive qualifier should travel with future summaries: the two-history arm uses the **same recursive reset/support mask** as the longer-memory arm. In `role_state.py`, innovation resets compare each next departure with the accumulated phase before selecting `chain[-2:]`. Thus the ablation isolates longer phase averaging/confidence under shared eligibility; it is not a completely independent state machine retaining only two records. This matches the frozen plan's shared eligibility and does not undermine the bounded negative result, but cannot establish that all information in older departures is useless.

All four development dates were already inspected. Repeated checkpoints, overlapping histories and shared bus/day operating conditions are dependent evidence; no significance, fresh-holdout or nominal-coverage claim follows. Visit-normalized weights depend on the observed count of eligible landmarks. At a fixed elapsed stratum, original-cohort weights are not equal visits; the report now labels this correctly and supplies equal-checkpoint rows.

Timing proxies are not recovered publication receipts. True-rest episode selection and inherited lap support are not an exact reconstruction of what a live request knew. This screen omits refreshed production calibration, GPS state mixtures,30sec pooling, approach/departure transitions, future waits, both rider target occurrences, catchability and class deadlines. The component-continuation implementation and preserved counts were inspected, but its full15sec scan was not independently rerun here. It is neither live stability nor proof of one coherent total-duration CDF. No arbitrary cap, legitimate-case deletion or new forward-tracking rule was introduced.

## Most useful next experiment

Advance backlog5 using `cycle-4/INPUTS.md`; do not retune this family or rerun completed cycle1/2 experiments. I independently counted12,654 archived frames,36,516 Red observations and four bus names, with no other route present. This supports an explicitly selected **Red versus modeled walking** diagnostic, not an all-route ranking claim.

Freeze geometries, session start times, checkpoints and usefulness criteria before scoring. Capture all observed Red vehicles' continuously warm server state; the five focal-only snapshots cannot stand in for a warm fleet. Retain connected first/second occurrences, unavailable predictions and missing outcomes. Previously selected difficult windows remain selected diagnostics.

Two exact shell semantics deserve explicit tests before interpreting ranking churn:

1. `TransitMap.tsx` fixes the route/board/alight candidate set in `stableOptions`; it does not call `planTrip` afresh every poll. Reproduce endpoint/refresh resets and the empty-plan roster recovery separately, then keep live timing/ranking state across polls. Preserve `plannedRideSec` when live ride time changes.
2. The countdown `match` and the catchable `boardable` bus can differ. The card's `busName` follows `match`, while `journeyArrival.busName`/destination time follow `boardable`. Save both identities and exact boarding/alighting occurrence positions; assign outcomes to the bus priced for the journey, not merely the countdown label.

Exact-stop origins are a useful first slice, but often have zero access walk. Do not claim they validate nonzero-walk catchability. Add a prespecified nonzero-access fixture or later geometry if making that claim, and distinguish hypothetical walking time from an observed rider trajectory. Validate an extracted shell path against a bounded actual-shell fixture before labeling it displayed behavior. No walking threshold, hysteresis or suppression change is supported yet; shared planner/arrival changes require coordination through REQUESTS.

## Executed commands

All commands use the ETA worktree unless stated otherwise. Logs are reviewer-only.

- `OPENBLAS_NUM_THREADS=1 python /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/cycle-3/test_role_state.py` — exit0; six tests.
- `flock -w 900 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/heavy.lock env OPENBLAS_NUM_THREADS=1 python /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/review-round-3/verify_evidence.py > /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/review-round-3/evidence.log 2>&1` — exit0; state, training-objective, forecast, metric and record checks above. No fit was performed.
- `OPENBLAS_NUM_THREADS=1 python /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/review-round-3/verify_regressions.py > /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/review-round-3/regressions.log 2>&1` — exit0; paired selection, frozen artifacts, raw coordinates and Red-only inventory.
- `OPENBLAS_NUM_THREADS=1 python /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/review-round-3/verify_cohorts.py` — exit0; original rows, identical arm cohorts, latency equivalence and maximum training hold.
- `git diff --check && git diff --exit-code 948712e153cea1017e9471ce84851a41fae4508a HEAD && git diff --exit-code && git diff --cached --exit-code && git status --porcelain && git rev-parse HEAD && git rev-parse 948712e153cea1017e9471ce84851a41fae4508a` — exit0; empty diffs/status, exact base/HEAD.

No application proposal required typecheck, full Vitest, Vite build, Docker, browser or staging checks; none was run or claimed. No model refit, dependency installation, network/analytics request, screenshot, server/browser/watcher action, database mutation, source edit or publication action occurred. Shared heavy lock was released after the objective check.

Final temporal check: `OPENBLAS_NUM_THREADS=1 python /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/review-round-3/verify_temporal.py > /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/review-round-3/temporal.log 2>&1` — exit 0. All 1,070 real state queries remain identical after removing unknown events, shuffling input order, then injecting unavailable same-stop/opposite-stop departures and a contradictory route anchor with tempting earlier physical timestamps. All 191 reset-training pairs/thresholds also remain identical when every post-cutoff event is removed. This tests the declared availability contract, not original receipt-time accuracy.

All review command sessions have completed. No owned process or heavy lock remains. Final checkout and artifact-integrity checks remain recorded in the closing progress entry.
