# Compact timing history

Run `node --import tsx scripts/trajectory-history/poll.mjs` every fifteen
minutes under one supervisor. This operator reads the existing native gzip
recordings and collector witness SQLite database locally. It does not make
production requests, execute the ETA engine, fit parameters, publish a model,
change report/incident status, or signal either rider or learner.

When there are no buses and no server ETA, the archive retains a fresh original
empty-feed receipt instead of inventing a new model timestamp. Its independent
supervisor requires that actual receipt; an idle flag alone is insufficient.
An empty GPS feed is not proof that a vehicle physically finished its service.

A model observation may also legitimately contain no arrival forecast while
GPS observations remain available. Such an original frame retains its actual
model timestamp, with `forecastAvailable: false` and no invented anchor,
distribution or entry clock. Forecast loss and recovery both break the entry
clock context, including within one minute.

When the current HTTP feed contains fresh GPS but no ETA, a separate
`forecast-unavailable-feed-receipt` preserves the original response identity
and whitelisted observations. This receipt advances capture freshness, never
the model timestamp, and never claims an empty fleet or physical service
status. The independent supervisor verifies the actual GPS observation clocks
and locations; an unavailable flag or count alone is insufficient. Original
feed receipts remain ordered across forecast loss, empty feeds and recovery,
so replaying an older cached response cannot undo a newer state.

The independent private output defaults to
`scripts/.bot-artifacts/trajectory-history/`. Configure `TRAJECTORY_HISTORY_DIR`,
`TRAJECTORY_HISTORY_LEARNING_ROOT` and `TRAJECTORY_HISTORY_COLLECTOR_FILE` when
needed. Output overlapping either input is refused before creating files.
Catch-up uses original fifteen-minute intervals. Each verified interval commits
its projections and cursor atomically before the next begins; a later failure
preserves earlier progress. Native files are selected for that interval rather
than rereading completed earlier hours into the same compressed-input budget.
The recorder keeps the inspected time frontier separately from its current
heartbeat. A prefix may contain later, unprocessed frames: an unchanged gzip
file is rescanned when that frontier moves, so those frames are not skipped.

Collector queries and projections use the same upper time frontier. Historical
source holes are explicit `history-source-gap` records and reset the affected
derived clocks. They never become invented movement or departure evidence.
This includes past outage intervals with no native input files after a trial
handover. Catch-up records the missing coverage and proceeds to later original
inputs; a current interval without native files still fails capture.
Current missing sources still fail capture. Pending associations expire against
the inspected historical interval, rather than being discarded immediately
because a backfill runs hours later.

One invocation attempts at most thirty-two intervals and stops after its
two-minute work budget at an interval boundary. `backfill_pending` remains
unhealthy until original inputs reach the current capture window; the next
invocation resumes the committed cursor. Private progress and a bounded failure
reason make stalls diagnosable. These limits leave the existing per-file,
compressed read, raw record/batch and physical storage caps in place.
After an actual successful capture, configure `LEARNING_WATCH_HISTORY_STATUS`
on the independent learning-health supervisor. It checks the fifteen-minute
archive's heartbeat against twenty minutes and uses its existing three spaced
checks before emitting an operational incident. Missing or failed capture is
not an accuracy verdict.

Every complete original model frame is inspected for causal adjacent lead
transitions. The archive keeps minute samples and transitions, with the next
stop's original forecast rows and all available fifty public quantiles. Missing
distributions remain missing. Entry clocks are first observed model transitions,
not physical departure times. Bus/provider/route, source epochs, model
continuity and the exact original indexed stop sequence qualify the clock;
gaps reset it. Public anchors index the published list, while the collector
can reorder or duplicate stops in its repaired ring. Entry clocks therefore
remain unknown whenever those full sequences differ or the original published
sequence is missing. A matching length or a +1 public-slot change is insufficient.
Qualified entries carry their index-space name and original stop-sequence hash;
resumed legacy contexts without that qualification start fresh. Forecast rows,
public quantiles, collector evidence and posterior capture remain available.
Earlier records are preserved unchanged; readers must treat unqualified legacy
entries on repaired routes as unknown, rather than interpret published indices
as collector-ring positions.

Collector capture uses a bounded read-only transaction, then validates and
decodes copied original pages after committing that read. It preserves selected
observations, the corresponding detector/visit projections, exact returned
leg/visit mutations, available model associations and actual original topology
bytes. Delayed model/source associations may attach an older original frame;
they do not reconstruct a past clock from later state. Unavailable associations
remain pending for two hours, then become explicit unknown records.

These timing and collector rows are verified projections at capture time,
with original frame/context hashes. They are not complete original forecast
payloads or collector reducer inputs. The existing full recordings and protected
incident/report evidence keep their separate policies. Repeated polls, a projected collector row and a
GPS-correlated virtual pickup do not establish independent physical truth or
authorize promotion. Full source replay and all support/held-out quality gates
are still required.

Set `TRAJECTORY_HISTORY_POSTERIORS=1` to retain one fresh, already-computed
champion posterior per archive invocation. The recorder verifies the native
checkpoint identity and checksums, finds its exact original model frame, and
compares the complete original served answer and bus inputs with the saved
champion cache. A sample keeps the complete original input/context JSON and
a lossless V8 projection of the champion's posterior store, observations and
parameters. It does not construct, restore, step or sample an estimator.
The previous fresh checkpoint is preferred to avoid an unflushed current
recorder tail; a rotated previous file can fall back to the current checkpoint.
Node/V8 versions and original model and capture clocks are recorded separately.

Model entry context is attached only when the archive processes that exact
new original frame. Enabling capture against an unchanged prefix may retain
the posterior with unknown entry context; it never substitutes native last-rest
state or a later clock. Already-sampled status prevents duplicate records and
does not promise an older sample survived rolling retention. Missing/corrupt
state or input, identity mismatches and size bounds retain an explicit
`posterior-unavailable` record while ordinary timing capture can continue.
An idle/unavailable feed does not turn an old posterior into a fresh model.

After enabling capture, set `LEARNING_WATCH_POSTERIOR_REQUIRED=1` on the
independent supervisor. It requires actual posterior reference fields and
fresh model clocks, or a separately validated original idle/unavailable feed
receipt. Posterior records use the same existing physical/age limits below;
they have no separate unbounded store. The projection omits engine caches and
is not a complete forecast runtime or an independent accuracy qualification.

The archive records the hashes of its five implementation modules and the
collector protocol/codec. Changes to that projection identity reset derived
clock contexts and add an explicit archive boundary, while preserving earlier
records and cursor provenance. The live estimator source identity is separate.

SQLite commits projections and cursors together with FULL synchronization,
DELETE journaling and FULL auto-vacuum. The physical budget is 256 MiB,
including its rollback reserve and bounded logs/status; only one third is
available to the database. Routine history rolls after thirty days or earlier
when that budget requires it. Actual retained chronology must be inspected;
thirty days is a maximum age, not guaranteed coverage. Existing incident stores
are read-only inputs and are never cleaned by this job. Unknown files, invalid
prefixes, corrupted commitments, low free space or oversized batches hold new
capture. Export any evidence needed for an active investigation into its
separate protected case before routine history rolls away.
