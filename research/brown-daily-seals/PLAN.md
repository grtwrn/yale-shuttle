# Daily Brown K5 sealing: implementation and execution prespec

Pinned September22,2026, before new fitting or scheduling. This was the review
plan at e42bb7b/b7a823c. Implementation and hosted-only gates are now described
in RESULTS.md; no new-day request, fit or timer has been launched.
Branch `research/brown-daily-seals-2026-09-22` starts at the immutable Sep23
seal report `6546241`. Root requested this scope and commands before new fits.

## Fixed experiment

Preserve PROSPECTIVE-FOUR-ARM.json SHA256
`4d1e09bd3cb41762a11e19a7de49bcfb8d8c479b44b3354a845df1b6c8f82742`,
the original four arms, complete actually served comparator, all target groups,
K values, parameter/support/quality gates, reducer sources, physical labels,
knownAt, clocks, gaps, occurrence rules and outcome embargo. Frozen K8 and
Sep23 rolling K5 are already sealed and are not rebuilt/replaced by this task.
One daily K5 pool serves original/directed variants only after their required
physical/path/fit parity. No arm selection, new scoring, candidate activation,
frontend qualification, outcome adapter, production or recording change.

New seals are the six forecast days Sep24–29, plus the ALREADY LOCKED Sep30
00:00–00:30 ET context-only artifact. Sep30 introduces no evaluation day or
scenario start. All times below use America/New_York (UTC−04 on these dates).

| Forecast day | Strict trainBefore | Last raw day | Archive normally due | Valid interval, ET |
|---|---|---|---|---|
| Sep24 | Sep23 00:00 | Sep22 | Sep23 03:40 | Sep24 00:00–Sep25 00:00 |
| Sep25 | Sep24 00:00 | Sep23 | Sep24 03:40 | Sep25 00:00–Sep26 00:00 |
| Sep26 | Sep25 00:00 | Sep24 | Sep25 03:40 | Sep26 00:00–Sep27 00:00 |
| Sep27 | Sep26 00:00 | Sep25 | Sep26 03:40 | Sep27 00:00–Sep28 00:00 |
| Sep28 | Sep27 00:00 | Sep26 | Sep27 03:40 | Sep28 00:00–Sep29 00:00 |
| Sep29 | Sep28 00:00 | Sep27 | Sep28 03:40 | Sep29 00:00–Sep30 00:00 |
| Sep30 context only | Sep29 00:00 | Sep28 | Sep29 03:40 | Sep30 00:00–00:30 |

Upper validity endpoints and training cutoffs are strict. `D−1` means midnight
of the preceding calendar day, so the latest full training day is D−2. No
same-day context may close a visit into that fit. The fixed timezone-derived
schedule must equal the original JSON lock exactly; no caller-supplied cutoff,
expiry, K, parameter or alternate date is accepted.

## Observed readiness and concrete gaps

Read-only metadata audit: Sep21's version2 selected raw archive exists with
179,751 rows, 1,644,074 compressed bytes, SHA256
`e44f295cb525cfa38e7f9e19ea29efb5204d93b3b39f26ea04c2213b914386c6`,
table capturedAt `2026-09-22T07:40:12.293Z`, source=server. Its row count agrees
with the original Sep21 transport export but its format and bytes differ.
Sep22–28 daily manifests do not yet exist. No raw/archive body was opened for
this planning task. Collection-readiness evidence remains at `7eebbde`.

The existing 03:40 ET archive cron has about 8h20m before the oldest previous-day
GPS reaches 36-hour retention at noon ET. Transport success is not a census of
service. Historical gaps remain in the fixed base. A newly missing day cannot
be replaced by finalized visits, sampled predictions or 15-second public feeds.

The Sep23 prepare/build/replay files hardcode Sep21 input, Sep22 cutoff and
Sep23 validity. Their workflow is push-only and reuses replay output from
35695402601, whose complete job failed later at a provider assertion. That
specific unchanged replay evidence was valid for the separately successful
Sep23 seal, but cannot stand in for any expanded daily prefix. The workflow's
cancel-in-progress=true also risks canceling an active seal on another push.

The runtime loader already recognizes the exact rolling dates, including the
half-hour context artifact. Preserve it and its original fit AST, not a new
fitter. Generic daily I/O/schedule code and gates are still required.

Repository metadata lists only FLY_API_TOKEN, not an archive admin secret.
No new credential is needed for this design. A lightweight local publisher
copies/hashes already captured compressed raw evidence; hosted jobs do all
decompression, schema validation, reducer replay and fitting. Never print/read
an admin token or request private/rider endpoints.

## Immutable input packages and normalization

1. Retain the original Sep3–20 raw history hash
   `3990d06ebdab596cfebdd7f03c528f7efcbb46fd3f6af68a9d64ede648e220b9`
   and original Sep21 header/trailer export hash
   `250494e8bbc09794da6df73b772ba1f78addf83c4511e186e34ffee1c4c05381`.
   Never replace these with later archive exports or reuse their gate results
   for the new suffix. Canonical topology/waits remain the original artifacts.
2. For each NEW day Sep22–28, freeze the first eligible selected raw snapshot
   encountered by the fixed publisher attempts. Read its small manifest once,
   resolve the selected relative file under that day, reject symlinks/escapes,
   and copy the untouched gzip plus the original selected manifest and its
   corresponding immutable snapshot manifest. A later manifest replacement
   cannot retarget a packaged file. Use exclusive creation and immutable commit
   IDs, hash copied bytes, and record actual packaging time and archive-script
   source hash. Copy no arrival/visit/prediction/scorecard/rider table bodies.
3. Check the RAW TABLE's complete/error/integrity fields and per-table capture
   time/build, not only global ok/generatedAt/lastAttempt. Other tables failing
   do not invalidate an intact selected raw snapshot. Require full ET day
   boundaries and capture completion strictly before the earliest raw-retention
   deadline (noon ET on the next day), or separately preserved earlier raw-only
   provenance proving that interval. A late transport-complete empty/partial
   export cannot certify that expired raw evidence was captured.
4. Pin format `archive-v2-normalized-raw-v1`: eight columns, in order
   `[bus_id,bus_name,route_id,lat,lon,heading,last_stop_id,collected_at]`.
   These are normalized JSONL rows, NOT original HTTP headers/trailers. Preserve
   the original compressed bytes and manifest declarations; do not fabricate
   a transport wrapper, database row ID or raw hash the archiver did not save.
   Distinguish its provenance from `original-http-raw-v1` used for Sep21.
5. Initially accept server-only provenance, or a merge provably containing no
   capture-only rows: the pinned archiver rejects duplicate server identities,
   server rows replace capture rows at identical keys, and manifest server
   count equals merged/table row count. Otherwise mark causal raw provenance
   unavailable; never silently accept a Pi sample as an original server poll.
   Keep source/capture counts and the archived script proof in the package.
6. Hosted validation checks gzip hash/size/trailer, declared raw bytes and rows,
   strict JSON (duplicates/nonfinite rejected), exact schema, finite/ranged
   coordinates, integer provider/route/time identity, nonempty bus name,
   nullable finite heading/last_stop_id, and each timestamp inside its ET day.
   Raw `(bus_id,collected_at)` keys must be unique; conflicts halt instead of
   last-write deduplication. No invented IDs are needed by the fixed reducer.
   Preserve source row order; create a separate deterministic merged input
   sorted by actual collected_at then provider, matching the original replay.
7. Each request names the exact cumulative Sep22-through-D−2 input selections
   and their immutable input/package hashes. It cannot skip an absent day,
   change an earlier packaged selection, or look at a future suffix. An explicit
   valid zero-row export differs from an unavailable file and does not prove
   zero service. Record coverage unknowns without adding a new support rule.

## Generic hosted builder and unchanged gates

Implement a separate daily driver. Preserve the original Sep23 scripts/report
and all frozen manifests. Parameterize only paths and the exact schedule entry;
reuse the unchanged canonical fit, fixed topology/wait preparation, provider
span audit and exact AST loader. Record all wrapper/source/parameter hashes.
The source hash allowlist covers the four-arm lock's entire pinned production
reducer/network closure, guard, fitter and helpers; do not rebase onto current
production while adding daily automation.

Before any fit, rerun both original and Brown-only guarded reducers on the
ENTIRE immutable raw prefix with original poll grouping and no EOF closure.
Compare the original canonical historical prefix, all non-Brown event bytes,
Brown physical arrival/departure/actual-knownAt multisets (including unresolved
pinned events), strict source ledgers and explicit anchor/metadata changes.
Never use database finalized visits as new reducer input.

Delete future suffixes at the existing Sep16 midnight, Sep21 midnight and
Sep21 noon controls, plus the newest admitted day's midnight and noon, for
both arms. Retain every original control; duplicate cutoffs may be evaluated
once with both labels recorded. Require exact earlier emissions and knownAt.
Run these controls against each day's new input hash; no Sep23 replay reuse.

Only after physical/source gates pass, run fixed Brown K5 fits for all nine
cells and whole groups. Require exact original/guarded physical path identities,
support and numerical fits, strict source/intermediate/target/raw-knownAt
cutoffs, physical-cut-prefix equivalence, unchanged provider quality interval
and original fit AST reload. Use every admitted source clock and the original
fixed hourly Sep23–30 clock grid, including unsupported queries; do not shift
the grid with the daily validity start or inspect forecast-error labels.
Reload the frozen K8 seal and reproduce its 167 saved numerical controls.

The known Sep16 closing-provider mismatch stays documented. Source departure
through target arrival must have the original one-provider quality bracket;
a different closing provider is accepted only under the already proven
post-arrival transition audit. Unresolved discrepancies HALT, never discard
paths, relax speed/gap rules, or choose a convenient subset.

Use one hosted job at a time, 60-minute job timeout, aggregate process RSS
limit 6GiB and scratch limit 12GiB, measured over parent plus children. Fit and
replay run sequentially. Resource-limit failure is explicit unavailability;
do not shrink history, remove parity gates, or sample paths to make it pass.
Retain bounded progress/resource summaries and full required compressed
evidence on hosted storage for90days. Download only compact catalogs locally.

## Sealing, publication and operational state

Generate actual builtAt only after all model/reload/gate checks. Hash every
pool, raw/causal-visit prefix, model source, parameters, input package, physical
path/fit/provider audit and manifest. Upload with day/run/attempt-specific names;
never overwrite a previous seal or assign a historical builtAt from the plan.

The existing builder writes builtAt before its final reload checks/upload.
Those old exports were completed well before their validFrom and stay immutable.
The daily driver must finish those checks first. Record upload completion and
subsequent verification in a separate immutable publication catalog, including
artifact ID/digest, builtAt, actual publication/acceptance time, source/request
commit, attempt and exact validity. Final availability is no earlier than both
builtAt AND verified publication. A model not yet delivered/accepted is absent,
even if a later artifact reveals an earlier builtAt. No catalog backfilling.

Catalog states distinguish waiting_archive, transport/provenance_invalid,
queued, running, operational_failure, scientific_halt, sealed_pending_publish,
available, available_late and expired. Missing/late/expired artifacts mean the
exact served row at that forecast clock; never extend yesterday's validity.
A late artifact may become eligible only after its true publication within
its fixed validity. No artifact may be built/activated after expiry. A physical,
path or numerical parity discrepancy remains scientific_halt and stops the
guarded comparison, not an ordinary fallback or automatic retry opportunity.

The first valid published artifact for a day is authoritative. A success is
idempotent; later scheduler ticks do not refit it. Operational retries use the
same immutable source/input request, actual new run/attempt and new timestamps.
Never retry by silently selecting a different raw snapshot or source revision.

## Automation and prelaunch gates

Use a root-owned lightweight persistent publisher/controller on the Pi only
for metadata, gzip byte copying/hashing, Git push and hosted status/catalog
handling. No local decompression/replay/fitting. Proposed fixed attempts are
04:10,06:10,10:10 ET on Sep23–29, each targeting the following calendar day;
Sep29 targets the separate Sep30 context seal. Add a daily17:10 ET status
check and stop at the fixed schedule end. Missing raw at10:10 leaves time for
root's separate archive retry before noon; this controller never runs the
archive exporter or starts another collector.

A push of one immutable request file triggers a dedicated hosted workflow on
the research branch. Code-only pushes run synthetic fixtures but never fit.
Keep a single global sealing concurrency group with cancel-in-progress=false;
the controller allows at most one pending/running request and records locks,
crashes, GitHub admission failures and eventual run identity explicitly.
Do not rely on a branch-only cron or dispatch event: GitHub scheduled runs use
the default branch and may be delayed/dropped, and workflow_dispatch must be
registered on the default branch. [GitHub schedule documentation](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule),
[manual-run documentation](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow).
No default-branch workflow/deployment edit is needed for a push request.

Before activating publisher timers or requesting a real seal, run hosted
synthetic fixtures for all exact date/embargo/context boundaries, malformed and
mixed archive provenance, duplicates/conflicts, immutable manifest races,
missing days/retention deadline, strict cutoff and incomplete visits, changed
source/topology, first-success/idempotency, queue/crash/retry reconciliation,
true publication availability and scientific-halt handling. Include a hosted
normalization/reducer parity check using ONLY already opened Sep21 originals
versus its eight-column archived representation. No new-day fit is part of
these implementation gates. Any required old numerical-fit control is already
opened development evidence and must be labeled separately from a new seal.

Root reviews this plan/commands first, then the concrete implementation and
hosted gates before enabling timers/requesting new fits. Until then this task
has created no request, fit, schedule, artifact replacement or prospective score.
