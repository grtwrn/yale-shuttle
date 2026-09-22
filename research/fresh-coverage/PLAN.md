# September21 exploratory evidence freeze

This audit measures evidence availability, not ETA performance. It changes no
model, quality cutoff, or promotion rule. All scans and tests run on a GitHub
hosted runner. The local capture only streamed allowlisted fleet exports.

September21 ET has closed, but its early export is not settled truth. Preserve
the original API header and trailer in each `*.original.jsonl.gz`; these are
API envelope files, not the row-only input expected by `archive-db.ts`. The
original manifest and exact exporter source hash remain immutable. Coverage
uses a separate normalized manifest on the runner, without rewriting streams.

The previous-day files and manifest are copied unchanged from the September20
03:40ET scheduled archive (exported September21). That archive provides earlier
GPS context unavailable from the present36-hour-retention API. It lacks original
API wrappers; that difference must remain explicit. Current fleet snapshots and
checkpoint model files describe extraction-time configuration, not every
historical prediction. The canonical reference topology provides route names
only; compare its sequences with the new live snapshot before future replay.

Audit original byte identities, wrappers/counts/schema, duplicates/conflicts,
observed-service GPS buckets, visit continuity and rider-vs-upstream surfaces
with the existing coverage implementation and unchanged thresholds. Report
every route, including unobserved service. Per-day continuity deliberately
censors intervals needing adjacent-day positions. A successful audit workflow
does not certify complete service, settlement, or trustworthy detector truth.

September21 is partially inspected development evidence (some Red examples
were already seen), never an untouched holdout. No ETA error or candidate
scores will be computed in this workflow. Future research must reconstruct
knownAt causally, preserve occurrence ambiguities, and include adjacent-day
warm-up/departure context. Take a separate settlement export of September21
after03:35ET and before its first GPS ages out around noonET. Preserve that
export independently, along with relevant September22 context.

Promotion still needs a predeclared candidate/comparator and at least30
physical arrivals,12 source journeys and3 subsequently unopened service dates,
plus all width/accuracy/coverage/early-arrival/action-risk gates.
