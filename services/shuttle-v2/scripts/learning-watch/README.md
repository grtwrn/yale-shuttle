# Learning observer health

Run `node scripts/learning-watch/poll.mjs` from `services/shuttle-v2`.
The Mac's `com.grtwrn.yale-shuttle-learning-watch` job checks once a minute
and at login. It reads the supervised observer's process, status, state and
frozen champion/source identity. A lock serializes concurrent monitor checks.

The earlier guardian bridge checked production health and rider events but
did not inspect learner refusals. This check covers a missing/wrong observer
process, a heartbeat older than two minutes, a feed receipt older than thirty
seconds, distinct-input age over one minute, observer errors, unexpected
disabled publication, unsupported/inconsistent cycle metadata, missing/changed
frozen evidence and an observed production-control failure.

Three checks spaced at least forty-five seconds apart confirm an incident;
a gap over 150 seconds resets an unconfirmed streak. Persistent findings are
deduplicated until recovery or a new cycle. Rapid manual probes cannot create
three confirmations. Incident-write failures remain unreported and retry.
Durable incidents enter the existing guardian pending queue. No Slack, email,
desktop notification or app report is sent by this script.

Each new incident embeds a checksummed diagnostic snapshot of the parsed status
values used by the confirming check: learner error/control status, frozen and
live source identities, observer probe, configured collector/archive statuses,
read errors and platform summary. These are diagnostic JSON values, not original
file bytes. They remain available when the mutable status paths later recover
or rotate. The first alert snapshot survives a persistent write retry; existing
pending or processed incidents, including older incidents without snapshots,
are never rewritten or given reconstructed failure details.

Each diagnostic section is bounded to 8 KiB and the combined snapshot to 64 KiB.
Missing, oversized or unserializable sections are explicitly incomplete;
size-limited omissions retain their byte count and checksum. A new incident,
including any existing CPU confirmation receipts, is bounded to 512 KiB.
Full pending forecasts, visits, training data and model parameters are omitted.
Snapshots share the guardian incident's retention, so no separate snapshot
directory grows outside that policy. This adds no application requests and
changes no alert threshold, sampling cadence or publication gate.

Warmup control mismatches are diagnostics. Calibration/test mismatches and
persisted protocol failures prevent a valid publication and warrant review.
Ordinary lack of visit support and a candidate losing its quality comparison
are expected outcomes, not monitor failures. The check does not itself prove
parameter accuracy, complete source-byte parity or independently observed
boarding. It never changes learner evidence, parameters or cycles, and never
starts, stops or restarts the observer.

A verified running container can still be awaiting its first current status
while startup checks retained inputs. `observerReadiness` keeps that fresh
process observation separate from the previous runtime's status and terminal
error. The phase is `awaiting-current-status` and `ok` stays false, even when
the previous status is recent. Verification progress stays unknown and readiness
unverified; this neither creates a new context nor supplies positive controls.
Missing or invalid container/status timestamps also keep `ok` false. Timestamp
association alone never certifies health: once status belongs to the current
process, all existing health checks apply. The host-process fallback is unchanged.

Private `status.json` and `state.json` live in
`scripts/.bot-artifacts/learning-watch/`; recent incident receipts keep the
latest 100 entries. Output logs retain approximately 1 MiB live plus one compressed
1 MiB tail. The guardian owns incident retention and triage. Original evaluation
evidence keeps its separate retention protections.

`LEARNING_WATCH_ROOT`, `LEARNING_WATCH_DIR` and `LEARNING_WATCH_INCIDENTS`
override learner input, monitor output and guardian pending directories.
The default input is the live `.learning-loop`, never a one-shot probe cache.
Exit 0 means the current operational checks pass; exit 1 means a current failure
or monitor error. Inspect actual launchd registration/exit status and fresh
monitor output; an old healthy file does not establish that monitoring runs.

Tests: `npm test -- scripts/learning-watch`.

## Collector recorder supervision

Once the collector witness endpoint and scheduled recorder are installed,
`LEARNING_WATCH_COLLECTOR_STATUS` can point to the recorder's `status.json`.
The monitor then checks that independent worker's heartbeat and failed status
using the same spaced, persistent incident policy. Missing/corrupt/stale status
or capture/protection/storage/queue failures reach the existing review queue.
This setting stays absent before installation and certifies no ETA accuracy.

## Recent production CPU throttling

An optional private `performance-policy.json` in the monitor directory enables
Fly platform telemetry: `{"version":1,"enabled":true,"org":"personal","app":"yale-shuttle"}`.
`performancePolicyFile` can select an isolated policy for diagnostics. Credentials
come from `flyctl auth token -q` (`FLYCTL` overrides the Mac binary path); they
are sent only to the fixed Fly Prometheus origin and are never retained.
Absent configuration explicitly reports disabled coverage. Bad configuration,
failed authentication, missing/stale series, mismatched machine identities and
insufficient counter support remain unknown operational findings.
Responses marked `isPartial: true`, or with a malformed completeness marker,
also remain unknown. An omitted marker and an explicit `false` are accepted;
an incomplete zero-throttling response cannot recover or rearm a CPU episode.

The check reads the platform counter increase over five minutes, rather than
only asking whether the app responds at this instant. At least 20 seconds of
CPU quota throttling is a finding. The existing three spaced confirmations
still apply, so a short stall stays visible after HTTP service recovers.
This measures platform throttling, not a bus delay or an exact duration of
request unavailability. Fresh source timestamps and at least two counter
observations are required. A stale host is superseded only when the same
machine has a fresh replacement; other missing coverage stays unknown.

CPU episodes persist independently of learner cycles. Unknown telemetry does
not confirm or rearm them; a later healthy measurement rearms the alert.
Incidents retain all three confirmation receipts, each bounded to 64 KiB of
checksummed metric responses, without request headers or credentials. These
remain verifiable through a lost acknowledgement or monitor
restart. Existing incident IDs, learner evidence and pending records are
unchanged. This adds no model publication, accuracy qualification or process
restart capability.

The optional `LEARNING_WATCH_HISTORY_STATUS` points to the separately scheduled
compact timing-history archive's `status.json`. That job runs every fifteen
minutes; this supervisor requires a heartbeat within twenty minutes and fresh
model/collector evidence at capture time. During an empty GPS feed it requires
the archive's fresh original empty-feed receipt rather than a model timestamp
or an idle flag alone. Missing, failed or stalled capture uses the same three
spaced-check incident policy and retains the archive status path for review.
This monitoring does not change learner sampling or accuracy qualification.

Fresh GPS without any ETA uses a separate original forecast-unavailable feed
receipt. The supervisor verifies its checksum identity, response/receive clocks
and actual bounded GPS observations, including their freshness and locations.
It does not accept an unavailable flag or bus count alone, invent a model
timestamp, declare the fleet empty or infer that physical service ended.

Once optional posterior capture is enabled on that archive, set
`LEARNING_WATCH_POSTERIOR_REQUIRED=1`. The supervisor checks its separate
coverage status, original model/runtime/posterior hashes, fresh model timestamp
and actual sample count. A disabled, missing, corrupt or source-unbound sample
becomes a `timing-history-posterior` finding through the same spaced checks.
An old model is acceptable only alongside the already-validated original
idle or forecast-unavailable receipt. This does not certify that rolling
retention still contains any previously sampled state, change parameters,
restart the observer or qualify ETA accuracy.
