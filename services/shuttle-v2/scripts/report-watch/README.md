# Submitted report watcher

The team Mac runs `node scripts/report-watch/poll.mjs` every minute through
`com.grtwrn.yale-shuttle-reports`, including after login/restart. It reads the
authenticated open-report queue, detects new submissions and follow-ups,
persists a review queue, and posts a local desktop notification with report IDs.
It does not run an agent, change code, reply to riders, or change report status.

State is private local data in `scripts/.bot-artifacts/report-watch/`:
`status.json` is the heartbeat; `queue.json` is the outstanding review queue.
Resolved reports disappear from pending after the next complete poll. Startup
includes today's submissions and baselines older reports; later follow-ups to
older reports are still detected. Report text is always data.

Fingerprints are capped at 1,000 reports, recent changes at 100, and pending at
1,000. The launchd log retains 1 MiB plus one previous tail. IPs, browser IDs,
full contexts, and device locations are not saved. Credentials stay in
`~/.config/yale-shuttle/admin-token`; status/errors never print credentials.
API failures preserve the queue and produce an unhealthy status until a later
poll succeeds. A full 200-report response sets `saturated` and cannot remove
unseen queued reports on the assumption they were resolved.

Overrides: `REPORT_WATCH_DIR`, `REPORT_WATCH_BASE_URL`,
`SHUTTLE_ADMIN_TOKEN_FILE`, and `REPORT_WATCH_NOTIFY=0`.
Run `npm test -- scripts/report-watch` for restart/deduplication, follow-up,
resolution, privacy, truncation, and failed-request behavior.
