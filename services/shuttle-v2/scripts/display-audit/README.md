# Display consistency observer

The Mac checks `https://yale-shuttle.fly.dev` once a minute with
`node node_modules/tsx/dist/cli.mjs scripts/display-audit/poll.ts`, supervised by
`com.grtwrn.yale-shuttle-display-audit`. It reads only public health/feed data.
The local application image inputs must match the production build. A newer
operator-only Git revision is allowed when those inputs are identical; both
revisions appear in the heartbeat. Dirty application or audit source, unknown
builds, and a checkout changed during the HTTP poll fail the check.

A valid empty fleet reports `activity: "idle"` and zero coverage without requiring
an ETA snapshot. It clears unconfirmed observations, preserves queued incidents,
and resets the monitor's failure streak. Idle is not an ETA accuracy result or a
claim about scheduled service. Malformed feeds and nonempty fleets without a
valid ETA snapshot still fail.

For every fresh bus whose model and GPS agree it is standing at a stop, it
checks the actual overview anchor against that physical stop. On lines without
repeated calls, it independently counts forward through the published stop
sequence and checks every available pickup and get-off count. Green/Purple's
NEXT call uses their forecast sequence; simple loops' NEXT is also checked
against their published order. Green/Purple's
outbound/return counts are explicitly excluded from this physical-only oracle;
their existing pass-specific recorded tests remain the directional checks.

Two distinct ETA observations at least five seconds apart, no more than 150
seconds between checks, must disagree before an incident is confirmed. Normal
polling is 60 seconds. Cached observations cannot confirm an incident. A build
change or recovered check re-arms it; restart preserves confirmation/deduplication.
The separate simulated riders also compare their actual waiting-screen text
with an independent count, requiring a confirmed curb stand and two distinct
vehicle observations. Their `candidate-stop-count` event uses the existing
guardian incident bridge. Lightweight served stand records now accompany their
rolling UI samples, so future audits can distinguish curb service from the raw
stop-zone flag while approaching.

Artifacts are private local files in `scripts/.bot-artifacts/display-audit/`:
`status.json` exposes freshness, build, coverage, exclusions and findings;
`queue.json` keeps the last 100 confirmed incident batches for operator review;
`state.json` persists deduplication; `last-failure.json` is one overwritten public
feed capture. `health.json` records failure streaks. The launchd log rotates at
1 MiB with one previous tail. Local desktop notifications announce new incidents
and three failed checks; no report text or shell interpolation is involved.
No agent is spawned and no rider report, code, or production setting is changed.
These are consistency checks against the upstream feed, not independent arrival
measurements, browser coverage of every possible trip, or ETA accuracy scores.

Failed checks also retain `unavailable-history.json`, a rolling history of the
last 32 availability samples bounded to 8 MiB of formatted disk JSON. Recovery
leaves that history intact. Each check contains checksummed snapshots of the
parsed health/feed values it inspected and the available HTTP status codes.
Each input is limited to 1 MiB and each combined check payload to 2 MiB; missing,
oversized and omitted inputs are explicit. These are parsed diagnostic values,
not original HTTP response bytes. A corrupt or unwritable history is preserved,
and `failureEvidenceError` reports that capture failed alongside the original
check error. Rolling availability samples are separate from confirmed incident
queues and do not change comparison, freshness or notification thresholds.

`DISPLAY_AUDIT_DIR`, `BOT_BASE_URL`, and `DISPLAY_AUDIT_NOTIFY=0` override local
artifacts, target, and notifications. The scheduled process is short-lived; use
`launchctl start com.grtwrn.yale-shuttle-display-audit` for an extra check rather
than starting a second writer. To audit retained JSONL captures offline:

```
node node_modules/tsx/dist/cli.mjs scripts/display-audit/replay.ts captures.jsonl
```

Test with `npm test -- scripts/display-audit scripts/rider-watch`.
