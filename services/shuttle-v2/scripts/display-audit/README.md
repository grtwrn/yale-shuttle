# Display consistency observer

The Mac checks `https://yale-shuttle.fly.dev` once a minute with
`node node_modules/tsx/dist/cli.mjs scripts/display-audit/poll.ts`, supervised by
`com.grtwrn.yale-shuttle-display-audit`. It reads only public health/feed data.
The local Git revision and clean `web/src` must match the production build;
otherwise the heartbeat fails rather than auditing unpublished calculators.

For every fresh bus whose model and GPS agree it is standing at a stop, it
checks the actual overview anchor against that physical stop. On lines without
repeated calls, it independently counts forward through the published stop
sequence and checks every available pickup and get-off count. Green/Purple's
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

`DISPLAY_AUDIT_DIR`, `BOT_BASE_URL`, and `DISPLAY_AUDIT_NOTIFY=0` override local
artifacts, target, and notifications. The scheduled process is short-lived; use
`launchctl start com.grtwrn.yale-shuttle-display-audit` for an extra check rather
than starting a second writer. To audit retained JSONL captures offline:

```
node node_modules/tsx/dist/cli.mjs scripts/display-audit/replay.ts captures.jsonl
```

Test with `npm test -- scripts/display-audit scripts/rider-watch`.
