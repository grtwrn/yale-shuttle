# Collector evidence watcher

This read-only operator captures the actual collector poll input, in-memory
observation topology, detector/visit state and returned source-row mutations.
It supports review of suspicious detector outcomes and rider reports. It does
not fit parameters, filter observations, change report status or publish a model.

Run with Node 22.13 or later and the installed TypeScript loader:

```sh
node --import tsx scripts/collector-witness-watch/poll.mjs
```

Schedule this command every 30 seconds under one supervisor. Each invocation
has a storage lock and reads at most eight pages of 16 frames. Configuration:
`COLLECTOR_WITNESS_DIR`, `COLLECTOR_WITNESS_BASE_URL`, and
`SHUTTLE_ADMIN_TOKEN_FILE` (default `~/.config/yale-shuttle/admin-token`). The
default private store is `scripts/.bot-artifacts/collector-witness-watch/`.
The token goes only to the configured app, in a header. Redirects are refused.
Errors/status never include credentials or arbitrary server response text.
The supervisor log keeps 1 MiB plus one compressed tail, using copy/truncate
so its open descriptor remains valid; these files count toward physical usage.

The authenticated `/api/evaluation/collector-witnesses` endpoint retains at
most 720 frames, one hour and 16 MiB including unique topology bytes. Each
frame has exact canonical binary64 values, map order, aliases, raw observations,
state hashes and a SHA chain. Topology includes the actual stop coordinates,
route orders, duplicate stop positions and unrounded leg geometry. It is not
inferred from a later network hash. A failed/oversized capture is an explicit
unavailable frame; lost clock continuity is a refusal. Diagnostic failure must
not withhold normal collector output.

The existing input-revision counters are read inside each source statement's
own transaction; the receipt is published after commit. Returned inserted rows
and before/after dwell-update rows are retained. This does **not** make a whole
poll atomic: a later failure can leave earlier statements committed and reducer
memory advanced. Failed polls retain that fact. Recovery inputs from before the
journal, source writes outside these wrappers and historical commit wall clocks
remain unknown. No row-eligibility or fitting formula changes here.

The watcher verifies frame, state and topology bytes before committing a page
and its cursor together in SQLite. Repeated pages retain the first transport
receipt; an old retry cannot rewind the cursor. The exact embedded frame JSON
and topology bytes are saved. Only a hash of the outer HTTP response is saved,
not its complete body. Producer build/epoch changes and clipped prefixes have
explicit boundary records, bounded to the latest 256; they never imply complete
coverage. A known topology is omitted from HTTP only after its local bytes have
been checked. The model index permits one last-frame revisit for a late first
model association without counting another collector poll.

The default physical directory budget is 256 MiB, with seven-day rolling
retention and a 128 MiB host-free-space reserve. Only one third is available to
the database (about 85 MiB); the remainder reserves its rollback journal and
small status files. `max_page_count`, DELETE journaling, FULL auto-vacuum and
actual allocated-file accounting bound this operator store without changing
production SQLite settings. Busy readers, unknown files, a protected full store
or low disk space hold capture and preserve the last committed cursor. They can
cause an explicit source gap if the server journal expires before recovery.
Full synchronous commits provide SQLite's local durability guarantees, not
remote backups or a promise against hardware failure.

Open-report protection uses the existing public model-input reference and the
private API's model-to-collector cross-index. Matching chunks plus a surrounding
30-minute-before/five-minute-after history window are pinned. When no exact
association is available, a time-only fallback is labeled as such. This does not
recover old reports' missing evidence. A truncated/invalid report queue, stale
protection refresh or damaged storage prevents cleanup; earlier pins survive.
The public feedback format and its public-response-only bundles are unchanged.

Derived completed legs whose endpoint distance divided by recorded duration
exceeds 30 m/s create **diagnostic leads** with protected source chunks/topology.
This is a conservative review trigger, not a statement of the bus's speed or a
rule to drop a row. Review the original GPS, state, geometry and revision ranges.
Incidents remain protected until deliberately reviewed; filling the protected
budget holds ingestion instead of deleting evidence. `status.json` is the
heartbeat and `retention.json` reports physical usage and protection findings.

Review leads and expired-source gaps are durably delivered to the existing
guardian `state/pending` queue (`COLLECTOR_WITNESS_INCIDENTS` overrides it).
Delivery acknowledgements follow the synced queue file. Lost acknowledgements,
failed writes and later polling outages retry from SQLite; a processed incident
is not resurrected. Available source history from 30 minutes before through
five minutes after a lead stays pinned, including later captured pages. A gap
also pins the last available page before its boundary. Processing an incident
does not silently release its source evidence.
Unavailable frames, partial failed polls and unknown source-write provenance
also reach review, even when a good poll has already cleared the current head's
error. Consecutive failures of the same kind share one incident while each
affected page stays pinned. The current failure keeps the recorder unhealthy.

After successful deployment/startup, set `LEARNING_WATCH_COLLECTOR_STATUS` on
the independent learning-health supervisor to this recorder's `status.json`.
It checks the recorder heartbeat and failed status with the existing three
spaced-check incident policy. A dead worker cannot keep itself healthy. The
recorder also checks witness age: successful empty polls create witnesses, so
fresh HTTP heads do not justify an indefinitely stalled collector. No input
gets a two-minute initial grace period; this is not a claim about service.

Validation includes real SQLite rollback, fresh-process retry/recovery, late
associations, physical shrinking, protected saturation, a concurrent reader,
corrupted topology, clipped source history and closed-database export. Captured
input is not independent ground truth, an ETA accuracy result or authorization
to promote a candidate. Original source/control/checkpoint, route support,
calendar, interval-score and untouched-test gates remain required.
