# Guardian bridge and incident evidence

`poll.py` retains the Mac bridge's existing health, rider-stall, candidate-event
and failed-journey alerts, two-hour deduplication, and event read offsets.
`launcher.py` is the reviewed entrypoint copied to the launchd job's existing
`~/.openclaw/yale-shuttle-team/bin/ys-watch-bridge.py` path. The job still runs
once a minute; it uses the repository version without restarting riders or the
learner. `YALE_SHUTTLE_ROOT` overrides the launcher repository. `GUARDIAN_STATE`
and `GUARDIAN_WATCH` select isolated queue and rider locations for diagnostics.

An incident's original pointers to rotating logs remain as provenance. Each
new rider-event occurrence also receives a private, atomic evidence bundle
under the guardian state's `evidence-bundles/<incident>/<event>/`. It contains
the original event, matching run records from current and rotated sample,
event and journey logs, and up to five referenced/start/pickup JPEGs. Current
status and checkpoint files are explicitly labelled as capture-time context.
The bridge uses the same PID lock as the Node rider's storage code so that
rotation cannot remove a file during capture. It never changes rider records.

Every file has a byte count and SHA-256 in the manifest. The incident retains
the manifest checksum; duplicate captures verify the original immutable bundle.
Repeated alerts grouped into one incident retain separate occurrence receipts.
A capture failure stays visible in the incident and `evidence-status.json` and
retries on the next poll. A failed capture does not suppress the alert or reset
read offsets. Only the two configured rider roots supply evidence; referenced
paths cannot copy arbitrary files or follow screenshot symlinks.

Existing pending rider alerts are backfilled from whatever remains available.
The manifest compares sample rows with the journey's recorded sample count.
Missing samples, partial or malformed source rows, and unavailable screenshots
stay explicit; a completed capture does not assert complete historical data.
These GPS-correlated virtual records are not independent physical boarding or
ETA accuracy evidence.

Routine rider images and logs keep their existing rolling policies. Bundles
referenced by pending incidents are protected. Once their incident leaves the
pending queue, bundles roll by seven days from capture and a combined 256 MiB target.
Protected overage is reported and fails the bridge's evidence-health check;
unresolved bundles are retained. A malformed pending queue or damaged bundle
refuses cleanup. Dead writers' incomplete temporary bundles are discarded;
live writers' files remain protected and counted. A bundle is bounded to
64 MiB of selected log rows and 32 MiB of stored payload; exceeding either
limit reports a retryable capture failure and preserves the original sources.

The scheduled output log keeps approximately 1 MiB live plus one compressed
1 MiB tail. Copy/truncate preserves launchd's open append descriptors. This
routine log can roll because incident records and evidence have separate
retention; pending evidence is not deleted when output rotates.

`evidence-status.json` exposes fresh status, capture/retention errors, retained
and protected bytes, and historical sample gaps. The bridge also records the
running Python source hashes in `bridge-state.json`. Exit 0 means the poll's
evidence work succeeded; exit 1 means it needs attention. Health incidents
retain their separate existing consecutive-failure rule.

Rider heartbeats and feed receipts are checked separately. A running browser
with no valid feed receipt for more than five minutes raises
`rider-feed-stalled`, even if its heartbeat is fresh or its `feedStale` flag is
false. Receipts older than 30 seconds remain `stale` during the five-minute
alert grace; that grace never labels old data fresh. The existing 15-minute
heartbeat-stall check remains. Fresh empty feeds
are healthy receipt evidence; this does not attest upstream GPS age, a
completed journey, or ETA accuracy. Missing, malformed or future receipt clocks
remain `unknown` in `bridge-state.json`'s `riderFeedHealth`.

One feed-stall incident is emitted per outage. That latch survives monitor
restarts and rearms only after an observed fresh receipt, keeping repeated
checks from growing protected occurrences and bundles indefinitely. Unknown
data does not clear the latch. Existing incidents and their evidence remain
untouched.

Run `python3 -m unittest discover -s scripts/guardian-watch -p 'test_*.py' -v`
from `services/shuttle-v2`. `bridge.test.mjs` runs the same Python tests inside
the normal Vitest release gates.

Transfer rider events carry the current leg’s `line`. Candidate and failed-journey incidents use that explicit line; older events fall back to the journey-started mapping. Resuming on the second leg does not require replaying an earlier start event to attribute an alert.

Completed one-seat journeys also receive a pickup-window diagnostic. The bridge
seals the original run before comparing its first literal `Arrival: ... Likely`
window with a recorded pickup-area observation. It requires complete samples,
a fresh initial screen, the same named vehicle, unchanged provider ID, one
route, the same pickup label and stop coordinates, fresh GPS and receipt clocks,
and no waiting-observation gap over 30 seconds. The first qualifying pickup
position must agree with the at-pickup card and precede the boarding action by
at most 15 seconds. An earlier close pass stays unknown. Resumed, excluded,
transfer, ambiguous, missing and changed-vehicle records remain unknown.

A pickup observed more than five minutes beyond the first window raises
`rider-pickup-window-miss` for review, even when the journey completed. This is
the existing canary's five-minute first-sight diagnostic tolerance, checked for
parity by tests. These shared-GPS records do not prove physical boarding or
independent ETA accuracy, and do not fit or publish a model. A result inside
the tolerance is not an accuracy qualification. The October 20 Purple #124
record has a literal 4–12 min first window and a pickup-area observation 27 min
later; the retained Orange Night record instead changed vehicles and cannot
be scored as the original vehicle's late arrival.

Auditing starts with future completed events at first activation. It does not
relabel old journeys or retrospectively emit alerts from an old backlog.
At most two queued runs per rider are checked per poll. Capture failures leave
pending work for retry. A retained incident, including one already processed,
prevents duplicate occurrences after a lost bridge checkpoint. Each rider keeps
at most 200 routine verdicts in bridge state. Routine audit bundles use the
existing seven-day / 256 MiB rolling store; candidate incident bundles receive
the existing pending-evidence protection. `evidence-status.json.pickupAudits`
reports pending work and separate unknown, late-window and tolerance counts.
