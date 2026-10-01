# Calibration research and promotion gates

Updated 2026-09-17 after the statistical review. The existing served model stays
active. No coefficients were fitted or published by this change. Ordinary live
calibration-table refreshes and warm bus tracking remain active.

`services/shuttle-v2/scripts/reestimate-params.mjs` now separates these date
blocks, in this order:

1. At least seven earlier complete archived dates for scalar parameter fitting
   (up to fourteen by default).
2. Two later dates to fit route and horizon corrections.
3. One later date to select those corrections.
4. Two later dates to fit interval widening to the **final candidate's raw
   output**, with state/centre parameters already frozen.
5. At least three untouched later dates for the final comparison.

The default therefore needs fifteen complete dates. `--days` controls the
earlier training window; `--replay-days` defaults to eight later evaluation dates
and cannot reduce it below eight. Incomplete manifests/missing required tables
do not count. Insufficient dates produce a local refusal record and leave the
live champion untouched. No final test date is passed to candidate fitting or
selection. Sparse research parameters fall back to fixed compiled constants,
not today's champion, which may have learned from those historical test dates.

Candidate fitting still uses the existing arithmetic; it does not introduce a
new state model, remove the standing clamp, add covariates, or validate a full
probability distribution. Today's live champion is scored as a counterfactual
comparator, not represented as the model that was known on each historical day.

## Outcomes must have finished before the cutoff

Stopped-visit tables require a completed departure, plus a lower bound on any
recorded confirmation delay, before `MODEL_NOW`. Stop-probability denominators
retain legitimate unpinned passes whose departure timestamp is absent, using
their known anchor time as an explicitly incomplete availability lower bound;
dropping those passes would inflate the stopping probability. Drive/leg tables
require arrival and any later pin to be at/before that cutoff. Legacy segment
and dwell priors also exclude future starts/completions.

For stop visits, `confirm_sec` is measured from the **final** departure
candidate's movement, whereas `first_moved_at` can be an earlier shuffle.
`max(departed_at, first_moved_at) + confirm_sec` is therefore an earliest possible
availability time, not always the true confirmation timestamp. Passes and legs
also lack exact insertion/confirmation times. The filters remove known future
outcomes without pretending these legacy records provide complete historical
availability. That remaining limitation is an explicit promotion blocker.

## Artifact integrity

Replay database, table patch and pairs caches include hashes of actual source
bytes (including uncommitted changes), dependency/configuration files, snapshot
and WAL contents, relevant archive file contents, parameters and explicit
runtime settings. Pair files are keyed by their actual raw parameter set, not
just the names “champion” or “challenger.” Archive content used by the database
builder is included even when an older date is incomplete.

Artifacts are produced to a temporary path, validated, renamed, then given an
atomic completion receipt containing their content hash. A receipt-less file,
interrupted write, malformed output, changed dependency, or changed output is
not reused. Old day/arm-only caches are never accepted by the new code.

## Statistical gate and current refusal

The new diagnostic evaluator includes every route/horizon cell, including
pooled and route-wide summaries. It reports coverage, late/early tail misses,
missing outcomes, mean absolute error, width and weighted interval score (median
plus central 80% interval). Unlike width alone, the proper interval score also
penalizes misses outside the band.

Operational thresholds are declared in `reestimate-validation.mjs`: at least
thirty sampled trips across three test dates per compared cell; coverage at
least 78% and no decline over two percentage points; early and late misses each
at most 15% and no increase over two points; interval-score deterioration at
most 5%; MAE deterioration at most three seconds; no matching-rate loss over two
points; and a pooled interval-score improvement. These are conservative research
release tolerances, **not a proof of nominal 80% or conditional coverage**. Once
sampling provenance exists, they should be accompanied by day/bus-run clustered
uncertainty and rider missed-connection/late-class validation before stronger
claims are made.

Three additional gates currently refuse automatic promotion unconditionally:

- Replay pairs omit the bus/target-arrival identity needed for prescribed
  per-visit sampling and clustered evaluation. Repeated polls are descriptive
  evidence, not independent trips.
- Legacy records cannot establish exact outcome availability.
- The current champion is not a verified pre-test model vintage.

Neither `--allow-drift` nor a short replay setting bypasses those gates. Refused
runs write `latest-validation.json` in the chosen work directory and do not
POST to `/api/model-params`. Non-dry runs may still post explicitly descriptive
replay scorecard rows. The existing parameter set remains served. Restoring
automatic promotion requires a reviewed exporter/evaluation change with actual
trip sampling, availability and model-vintage evidence; it is not a flag to
turn on because a correlated-poll score looks good.

Tests cover chronology, final-candidate calibration, test-date exclusion,
incomplete input refusal, cache corruption/interruption/content changes,
real-SQL completion cutoffs and route/tail/proper-score refusals. This repair
does not itself establish a new model's accuracy or a rider's on-time probability.
