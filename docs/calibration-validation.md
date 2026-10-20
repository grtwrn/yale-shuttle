# Calibration research and promotion gates

Updated 2026-10-11: automatic learning now has a prospective path in
`scripts/learning-loop/`. It freezes the currently published champion and a
candidate fitted from already captured archives, records both forecasts on the
live production input before outcomes, and assigns bus/stop visit identity
before arrival. Two full ET calibration dates precede interval freezing and at
least three untouched later test dates. Promotion checks paired route/horizon
coverage, tails, error, matching and WIS, plus hierarchical day/bus bootstrap
uncertainty. Every training route needs test support, including weekend lines.
Read [the observer workflow](../services/shuttle-v2/scripts/learning-loop/README.md)
for supervision, receipts and the exact feed-based truth definition. The legacy
historical replay described below still refuses automatic publication because
its original provenance limitations have not been retroactively solved.

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

## Exact calibration reads

The production collector now gives the main calibration and each independently
cached lap, release and hour-stand fit its own read receipt. A receipt records
the exact query cutoff (`asOf`), runtime timezone, observed read wall clocks, a generation UUID,
and the committed input revision read inside the same SQLite transaction as
the queries. A fixed-size revision row advances through triggers on every
insert, update and delete of arrivals, segments, stop visits and legs; a rolled
back write does not advance it. Reads are query-only. Calibration tables are
published after the read transaction and receipt have succeeded.

A cache hit preserves its original receipt. A failed refresh that keeps a fit
also keeps that original generation; clearing a failed fit clears its receipt.
Private production replay contexts retain the main receipt, all three cached
sources, and a hash of the network actually used for that calibration. Later
cache rebuilds cannot overwrite an already recorded model observation.

These revisions identify committed contents within that database lineage.
They are not source-row hashes, wall-clock commit times, or a reconstruction
of an earlier database state. Copying a database can fork its revision history.
Full SQLite backups preserve the ledger and triggers; older archives lacking
the ledger, incomplete trigger schemas, and reads inside an uncommitted outer
transaction are explicitly marked unavailable. Existing rows still have unknown
historical write availability and observation topology. The current calibration
network hash must never be assigned to those old observations as their topology.
Daily table exports are not complete SQLite backups and cannot reconstruct a
past revision from this receipt alone.

This first provenance step changes no sample eligibility, fitted coefficient,
probability rule or promotion gate. A causal stop-pass correction still needs
immutable row/witness hashes, topology at observation, versioned resolution
availability, and validation against the original service and accuracy gates.

The prospective collector witness journal adds bounded exact poll input,
actual observation topology, detector/visit state and returned row-mutation
receipts. Its read-only operator watcher can retain these locally and associate
them with reported model inputs. See [the capture and retention contract](../services/shuttle-v2/scripts/collector-witness-watch/README.md).
This captures new evidence only. It neither reconstructs missing historical
availability nor resolves the original stop-pass anomaly. Statement receipts
are committed individually; whole-poll atomicity and versioned causal row
resolutions remain separate work. The production eligibility and promotion
gates above are unchanged.

## First-rest collection clocks

The collector's first resting plateau must still be within the existing 75 m
pin radius and belong to that stop. The detector can retain a stop's stationary
anchor out to 125 m; that retained anchor does not turn a later outside repeat
into the stop's first rest. A roll-through keeps its closest-approach clock,
and sufficiently long outside freezes remain leg holds under the existing
stillness rule. A first pass without an inbound leg buffers those frozen runs
until its onward leg is confirmed. Outside fixes do not extend its recorded
time inside the stop radius. These are source-clock definitions, not physical
door or service truth. Historical rows are unchanged, and legacy warm states
cannot recover missing earlier hold history. No calibration eligibility or
promotion gate is relaxed by this collection correction.

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
