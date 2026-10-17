# Prospective automatic learning

Run `TZ=America/New_York LEARNING_PUBLISH=1 node node_modules/tsx/dist/cli.mjs scripts/learning-loop/start.ts`.
`--once` probes one poll in a separate cache directory and cannot publish;
`LEARNING_PUBLISH` must be `1` to publish after validation. A PID lock prevents
two observers writing to the same artifact directory.
The default admin credential is `~/.config/yale-shuttle/admin-token`; override with
`SHUTTLE_ADMIN_TOKEN_FILE`. `BOT_BASE_URL`, `ARCHIVE_DIR`, and `LEARNING_DIR`
override production, training inputs, and the output directory.

This replaces the historical automatic-promotion path whose evidence was
unverifiable. The historical replay remains diagnostic and keeps its refusals.
`served-control-v2` uses an independent production ETA engine for each arm.
After training, an authenticated `/api/evaluation/seed` read captures the
producer's complete past belief/observation graph, before the cycle starts.
Both arms inherit that same past once and independently compute subsequent
forecasts. Neither takes its predictions from the champion's served answer.

`/api/evaluation/inputs` supplies immutable, checksummed inputs for every
production model observation, with an epoch and contiguous cursor. It includes
collector checkpoint evidence and the route-adjustment configuration that
ordinary `/api/buses` omits. GPS expiry, observation interning, eviction and
route adjustments run through the real production code. Polling every two
seconds drains this journal; it does not assume every public snapshot was seen.
The source buffer is bounded by 120 frames, 16 MiB including context, and ten
minutes, whichever is reached first. Expired required history is an explicit
refusal, never a jump to the latest payload.

Catchup advances estimator history only. A fresh caught-up HTTP response is
required for live samples and curb observations; historical frames never
become retrospective promises or retrospectively observed arrivals. Empty
service preserves the last actual model clock. An idle history fork may be
older than two minutes only when the current fleet is empty; no clock or
forecast is manufactured to keep an idle process looking active.
If a model is published while idle, the current model and the model that last
produced the historical state are recorded separately; the next real observation
computes the new forecasts.

The complete served output is checked after every exact input and at live
sampling. Sampled raw quantiles also attest the same vehicle, stop and future
traversal within the existing half-second wire-rounding tolerance.
Sampled records also keep all 50 internal model quantiles and their exact
probability grid, copied separately for each arm at model time. A secondary
mean pinball-loss diagnostic ages and clips those stored quantiles once and
compares paired observations by route and reference horizon. It reports the
whole cohort, including missing legacy distributions, malformed arrays,
unknown outcomes and unverified controls. The existing median/central-80%
WIS, support, coverage, route, tail, day/bus uncertainty and publication gates
remain unchanged. The diagnostic cannot authorize promotion. These are
retained internal model outputs associated with the source/model receipt;
interpreting a discrepancy still requires replay and outcome review.

Reference rows, raw quantiles, cache age and clocks accompany every sampled
control and are bound to the original retained HTTP input, frozen seed, full
source hash chain and runtime model identities. The chain is reconstructed
from retained bytes before fitting or validation. Any observed v2 protocol
failure refuses that cycle, including during calendar warmup; original packets,
pending predictions and refusals remain available for review.
Legacy evidence without this provenance cannot certify a new publication.

At cycle start, the observer verifies checksums and capture times of up to
14 archived dates (seven minimum), counts scalar parameters with the existing
fitter, and freezes the candidate and the currently published champion. A
historical row demonstrably present in a previously captured archive is known
at this present training cutoff; no historical insertion time is invented.
Existing route scales and horizon corrections remain fixed during this cycle.
Code bytes, parameter sets, training receipts and live input snapshots are saved.

`source-files.mjs` supplies the native source inventory, including the shared
`canary-metrics.mjs` helper used to match curb outcomes. An independent test
traverses the actual observer entry's literal relative imports to catch omitted
dependencies. Source checks re-enumerate files as well as comparing their bytes,
so changed, added or deleted executable files refuse the cycle. Older frozen
snapshots retain their original declared-file scope; missing helper bytes are
never retroactively attested. This inventory does not attest remote services,
dynamic filesystem reads or installed dependency bytes.

Sampling waits for each arm's first actual post-seed computation rather than
an arbitrary cold-start delay. Calibration uses the next two full ET dates to fit
candidate interval factors. A horizon needs 200 sampled visit forecasts and a
factor inside the existing 0.5–4 bounds. Insufficient calibration extends the
calibration phase; test data is never used to tune intervals. After interval
freezing, only later observations enter the untouched test phase.

Interval fitting uses model-time quantiles and converts the observed outcome
to that same origin. Only calibration intervals whose two bounds are affected
by the base widening parameter fit that parameter. Fixed route adjustments and
conditional release bounds stay in the full original cohorts and all scoring
gates. Fit scope and support are recorded explicitly.

After interval freezing the candidate engine runs its actual final parameters.
Scoring ages and clips that produced interval without widening it again.
This preserves route adjustments, per-bound exemptions and stateful interval
smoothing. A new source computation is required after a parameter freeze;
cached predictions cannot be relabeled as the final model. Missing or
pre-receipt outcomes remain missing. Comparison cells still use the common
champion horizon; the original route, support, tail and proper-score gates stay.

Sampling is one forecast per `(route, bus id, bus name, target stop, future
visit ordinal, champion horizon)`. Identity is allocated before the outcome.
Both models are scored on the same samples and reference horizons; an absent
challenger prediction is retained as missing, not removed from its cohort.
A curb-service outcome requires two fresh stationary observations at the
feed's named stop, within 75 m, nine seconds apart. The stop re-arms beyond
150 m. Observation time and actual evidence-receipt time are recorded separately.
No outcome within 47 minutes becomes missing; interruptions also become missing.
These are feed-correlated observations, not independent physical arrival truth.

Promotion requires at least three later test dates, every original route and
every observed route/horizon cell to pass the existing support, coverage,
tail, MAE, matching and proper-score gates, and at least 30 day/bus service
blocks with a negative one-sided 95% bootstrap upper bound on paired WIS change.
Uncertainty groups each service day by connected provider-ID and normalized
bus-name aliases, across route changes. A tracking-ID reissue cannot create
independent support. Alias evidence on missing-outcome rows also joins blocks;
scored rows with missing identity refuse the uncertainty gate. This conservative
grouping does not join forecast visits or fill missing outcomes. Per-route
support and all other gates remain unchanged.
Weekend-only routes may require additional test weeks. Poll counts do not stand
in for visit support. The current champion is checked immediately before posting.
Model, production build or producer-epoch changes invalidate the cycle after
confirmation against the current source head. Source changes cause a
supervised restart and a new cycle. Successful promotion starts a fresh cycle.

Artifacts default to `scripts/.learning-loop/`: `status.json`, `state.json`,
`events.jsonl`, cycle-local forecasts, compressed hourly input journals, source
copies, the immutable seed, and validation/submission receipts. Each paired
runtime checkpoint contains each arm's own posterior and raw served forecasts,
with gzip/content hashes. Runtime bytes are durable before the atomic state
pointer changes; current and previous generations are retained. Restarts
restore that pair rather than reseeding the candidate from the champion.
Corrupt/missing recovery state refuses the cycle. JSON outbox writes remain
recoverable. The calibrated candidate is frozen before the state points to it.
Closing a cycle resolves pending samples as missing and saves
its complete `closed-state.json` before replacing the active state. Input
receipts and any protocol refusals remain with the original cycle. Identical
journal receipts are deduplicated; conflicting ones
fail validation. Launchd supervises the live observer on the team Mac with
`com.grtwrn.yale-shuttle-learning`. `com.grtwrn.yale-shuttle-archive` exports the
previous day at 03:40 local time through `archive.mjs`, keeping credentials private.

Tests: `npm test -- scripts/learning-loop scripts/reestimate-validation.test.mjs scripts/reestimate-lib.test.mjs`.
