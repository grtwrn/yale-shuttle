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

`evidence-status.json` exposes fresh status, capture/retention errors, retained
and protected bytes, and historical sample gaps. The bridge also records the
running Python source hashes in `bridge-state.json`. Exit 0 means the poll's
evidence work succeeded; exit 1 means it needs attention. Health incidents
retain their separate existing consecutive-failure rule.

Run `python3 -m unittest discover -s scripts/guardian-watch -p 'test_*.py' -v`
from `services/shuttle-v2`. `bridge.test.mjs` runs the same Python tests inside
the normal Vitest release gates.
