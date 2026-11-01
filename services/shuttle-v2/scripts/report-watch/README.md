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

Changes to report text, priority, follow-ups, or the rider-visible reply trigger
review. An operator's internal audit below the reply separator does not: writing
an investigation must not alert the watcher to its own work. The note projection
is checked against the server's rider-facing projection. Fingerprint version 2
upgrades unchanged version 1 entries without notifications and preserves every
pending item. A change not yet seen by version 1 remains actionable on upgrade,
because its digest cannot establish which field changed.

Fingerprints are capped at 1,000 reports, recent changes at 100, and pending at
1,000. If an incomplete scan would exceed the pending limit, the check fails
before replacing either the saved state or review queue; unresolved work is
never evicted to admit newer entries. The launchd log retains 1 MiB plus one previous tail. IPs, browser IDs,
full contexts, and device locations are not saved. Credentials stay in
`~/.config/yale-shuttle/admin-token`; status/errors never print credentials.
API failures preserve the queue and produce an unhealthy status until a later
poll succeeds. The watcher first requests 200 open reports. A full response
triggers one request for the API's existing maximum of 1,000. The final response
alone supplies the observed reports; fewer than its requested limit proves the
open queue complete at that observation. Every row must have a unique positive
ID, open status, and valid fields needed for change detection. Malformed or
duplicate rows fail the check before saved work can be pruned. Both requests and their bodies share
one 20-second fetch budget, and each decoded JSON body is limited to 16 MiB.

A full 1,000-report response cannot prove completeness, even when the actual
queue happens to contain exactly 1,000. Its observed changes are saved and
notified, but the status is unhealthy with `coverage.complete=false` and
`saturated=true`. Unseen pending reports and diagnostic evidence remain
protected. `coverage` records the effective limit, observed count and reason;
these are bounded observations, not a total count when coverage is incomplete.
Pending-capacity and oversized-response failures are explicit too. Repeated
coverage failures use the existing three-check health alert and recovery path.

This improves coverage beyond the former 200-report window; it does not supply
general pagination or durable event replay. The current API has neither. Its
live report stream emits IDs without a replay cursor, and per-report evidence
contains forecast inputs rather than the report thread. Full coverage beyond
the supported batch limit needs a server protocol change and separate review.

Three consecutive failed checks produce a local desktop health alert. The
counter and delivery receipt persist in private `health.json`, so scheduled
process restarts do not reset the streak or repeat a delivered alert. A later
successful check sends a recovery notice. Failed local deliveries retry on
subsequent polls. A damaged report state is reported as unhealthy and leaves
the saved queue intact. Health alerts use fixed text without endpoint error
details, credentials, or report contents. `status.json` exposes the failure
count and notification errors even when desktop alerts cannot be delivered.

Overrides: `REPORT_WATCH_DIR`, `REPORT_WATCH_BASE_URL`,
`SHUTTLE_ADMIN_TOKEN_FILE`, and `REPORT_WATCH_NOTIFY=0`.
Run `npm test -- scripts/report-watch` for restart/deduplication, follow-up,
resolution, privacy, truncation, and failed-request behavior.

## Forecast inputs attached to feedback

`/api/buses` supplies `X-Shuttle-Snapshot`: an identity and SHA-256 of the exact
uncompressed public JSON, its server build, model/serve clocks, and a genuine
retained producer-observation reference when available. The observation and the
HTTP response have separate checksums: cached rebuilds and comparison variants
are not the original model-time input. No private history is in the header.

The client binds this receipt and its receive clock to the bus array published
to React. Feedback reads the metadata from the same committed DOM as the timing
rows, before opening a form or route prompt. Typing and retries preserve that
snapshot; sending has its own timestamp. The client bundle identity and at most
eight same-origin public JS/CSS resource paths are captured too. A missing or
invalid receipt stays explicit. Screen capture remains a whitelist; it does not
copy rider coordinates, addresses, or complete planner objects.

On submission the server retains a referenced public response in
`report-evidence/` beside SQLite. It keeps up to 600 recent compressed inputs
for 15 minutes, bounded by 32 MiB, and persists only referenced inputs. The disk
store has a 32 MiB cap and seven-day rolling retention, with a preflight reserve
of 96 MiB of free volume space for the collector. Open reports protect their
referenced inputs. Unknown partial files count against the cap. A full
protected store, expired receipt, restart without a retained input, or I/O
failure records an unavailable diagnostic receipt and still accepts the report.
Reporter-supplied evidence attestations, paths and URLs are not trusted.
`/api/reports/:id/evidence` requires the admin header and returns checksummed
compressed public JSON. `/healthz` exposes bounded capture/storage diagnostics.

The watcher saves verified source bundles, public screen facts and reported
asset bytes under its private `evidence/` directory. It validates both bundle
and decompressed source hashes. Asset requests never carry the admin token;
only whitelisted `/assets/` filenames on the configured app origin are used.
Missing old assets and HTML fallback responses stay unavailable, and the
watcher never substitutes the current bundle for a missing reported one.

Evidence attempts are immutable with a small latest pointer. Later polls retry
temporary failures even after report events were deduplicated. New reports and
older incomplete attempts take precedence within a 30-second capture budget;
each request is bounded to ten seconds. A failed report bundle does not prevent
other reports from being attempted. The review queue is persisted and notified
before capture, so an evidence outage cannot swallow a submission. Consecutive
capture failures use the existing watcher health alerts.

The same 30-second evidence work window now includes local maintenance,
manifest discovery and unchanged-object validation. A poll admits at most
256 MiB of reads and 64,000 filesystem operations. Shared verified objects can
reuse their checksum within that poll, with fresh file-identity checks for each
reference and comparison against each manifest's expectations. Deferred checks
remain unhealthy and explicit; a bounded continuation in `evidence-status.json`
lets later polls resume beyond an attempted prefix. Incomplete reference scans
protect shared objects from collection. Committed attempt references protect
their objects; an object saved before its attempt commits can be reclaimed and
fetched again after a deferred poll. These are software/data checks, not
historical ETA replays.

Local evidence has a 256 MiB cap and seven-day rolling retention. Resolved
reports can be retired to leave space; open reports and all earlier attempts
remain protected. A saturated queue cannot prove older reports were resolved.
Damaged or partial manifests preserve possibly referenced inputs and expose
`cleanupUncertain`; protected evidence is never deleted to make a check pass.
`evidence-status.json` records capture results and retry IDs. Source/asset absence
does not establish a historical replay, physical service, or ETA accuracy, and
does not replace the original calibration clocks or model-availability fences.
