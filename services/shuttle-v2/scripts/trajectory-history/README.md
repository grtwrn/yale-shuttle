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

The independent private output defaults to
`scripts/.bot-artifacts/trajectory-history/`. Configure `TRAJECTORY_HISTORY_DIR`,
`TRAJECTORY_HISTORY_LEARNING_ROOT` and `TRAJECTORY_HISTORY_COLLECTOR_FILE` when
needed. Output overlapping either input is refused before creating files.
After an actual successful capture, configure `LEARNING_WATCH_HISTORY_STATUS`
on the independent learning-health supervisor. It checks the fifteen-minute
archive's heartbeat against twenty minutes and uses its existing three spaced
checks before emitting an operational incident. Missing or failed capture is
not an accuracy verdict.

Every complete original model frame is inspected for causal adjacent lead
transitions. The archive keeps minute samples and transitions, with the next
stop's original forecast rows and all available fifty public quantiles. Missing
distributions remain missing. Entry clocks are first observed model transitions,
not physical departure times. Bus/provider/route, repaired collector topology,
source epochs and model continuity qualify the clock; gaps reset it. The
published route array is not used to infer repaired ring indices.

Collector capture uses a bounded read-only transaction, then validates and
decodes copied original pages after committing that read. It preserves selected
observations, the corresponding detector/visit projections, exact returned
leg/visit mutations, available model associations and actual original topology
bytes. Delayed model/source associations may attach an older original frame;
they do not reconstruct a past clock from later state. Unavailable associations
remain pending for two hours, then become explicit unknown records.

These are verified projections at capture time, with original frame/context
hashes. They are not complete original forecast payloads or collector reducer
inputs. The existing full recordings and protected incident/report evidence
keep their separate policies. Repeated polls, a projected collector row and a
GPS-correlated virtual pickup do not establish independent physical truth or
authorize promotion. Full source replay and all support/held-out quality gates
are still required.

The archive records the hashes of its four implementation modules and the
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
