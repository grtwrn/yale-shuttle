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
The prospective observer uses an independent production ETA engine for each
arm. This shares the real server's 45-second GPS expiry, cached-observation
interning, belief eviction and snapshot handling. Polling every two seconds
captures distinct collector snapshots; duplicate responses do not advance
belief or add samples. Both arms compute at the recorded server forecast time,
then account for the cache age at receipt. Neither arm takes its predictions
from the champion-only served field. An optional diagnostic callback exposes
unrounded base quantiles; the normal production engine has no callback.

The actual served field attests the control for the same vehicle, stop and
future traversal within the existing half-second wire-rounding tolerance.
Reference rows, raw quantiles, cache age and clocks accompany every sampled
control and are bound to the original retained input receipt. Warmup does not
prove parity. Any observed protocol failure or unmatched control during
calibration/test refuses that cycle; all rows remain available for review.
Legacy evidence without this provenance cannot certify a new publication.

At cycle start, the observer verifies checksums and capture times of up to
14 archived dates (seven minimum), counts scalar parameters with the existing
fitter, and freezes the candidate and the currently published champion. A
historical row demonstrably present in a previously captured archive is known
at this present training cutoff; no historical insertion time is invented.
Existing route scales and horizon corrections remain fixed during this cycle.
Code bytes, parameter sets, training receipts and live input snapshots are saved.

Collection warms for two minutes, then uses the next two full ET dates to fit
candidate interval factors. A horizon needs 200 sampled visit forecasts and a
factor inside the existing 0.5–4 bounds. Insufficient calibration extends the
calibration phase; test data is never used to tune intervals. After interval
freezing, only later observations enter the untouched test phase.

Interval fitting uses model-time quantiles and converts the observed outcome
to that same origin. Scoring selects the runtime interval factor at the raw
model horizon, widens, then ages and clips the result as the app does. Aging
first can change the blended factor or lose information at zero. Missing or
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
Weekend-only routes may require additional test weeks. Poll counts do not stand
in for visit support. The current champion is checked immediately before posting.
Model or production build changes invalidate the cycle; source changes cause a
supervised restart and a new cycle. Successful promotion starts a fresh cycle.

Artifacts default to `scripts/.learning-loop/`: `status.json`, `state.json`,
`events.jsonl`, cycle-local forecasts, compressed hourly input journals, source
copies and validation/submission receipts. JSON checkpoint and outbox writes
are recoverable. Closing a cycle resolves pending samples as missing and saves
its complete `closed-state.json` before replacing the active state. Input
receipts and any protocol refusals remain with the original cycle. Identical
journal receipts are deduplicated; conflicting ones
fail validation. Launchd supervises the live observer on the team Mac with
`com.grtwrn.yale-shuttle-learning`. `com.grtwrn.yale-shuttle-archive` exports the
previous day at 03:40 local time through `archive.mjs`, keeping credentials private.

Tests: `npm test -- scripts/learning-loop scripts/reestimate-validation.test.mjs scripts/reestimate-lib.test.mjs`.
