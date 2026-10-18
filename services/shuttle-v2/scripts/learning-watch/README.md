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

Warmup control mismatches are diagnostics. Calibration/test mismatches and
persisted protocol failures prevent a valid publication and warrant review.
Ordinary lack of visit support and a candidate losing its quality comparison
are expected outcomes, not monitor failures. The check does not itself prove
parameter accuracy, complete source-byte parity or independently observed
boarding. It never changes learner evidence, parameters or cycles, and never
starts, stops or restarts the observer.

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
