# Rolling monitoring storage

Run `node scripts/retention/maintain.mjs --dry-run` to inspect removals, then
run without the flag to apply them. The team Mac runs this every ten minutes
through `com.grtwrn.yale-shuttle-storage`; rider capture also enforces image
and JSON-log retention on every write. No application deployment is needed.

Each rider retains screenshots for seven days within 256 MiB, deleting the
oldest eligible files instead of stopping capture. The current journey and
optional `storage-pins.json` (`names` or `runIds` arrays) are protected.
Protected captures may temporarily exceed the target; the overage is reported
and clears once the journey finishes or the pin is removed. The image manifest
and gallery are rebuilt together, so expired images do not leave broken links.
`retention.json` reports current usage, limits and removals.

`storage-policy.json` in each rider directory can override
`imageMaxBytes`, `imageMaxAgeMs`, and the `samples`, `events`, `journeys`
objects (`chunkBytes`, `maxFiles`, `maxAgeMs`). Defaults:

| Data | Rolling retention |
| --- | --- |
| Screenshots | 256 MiB / 7 days per rider |
| UI/GPS samples | 12 × 5 MiB chunks / 3 days |
| Events | 6 × 5 MiB chunks / 30 days |
| Journey summaries | 6 × 5 MiB chunks / 90 days |
| launchd output logs | 10 MiB live + 3 compressed backups |
| Superseded learning inputs | 256 MiB / 7 days |

Active calibration/test inputs, pending/candidate receipts and the current
champion's publication evidence remain protected. Warming input hours that
predate calibration can expire only when they contain no pending/candidate
receipt and are outside the 47-minute boundary window. Source snapshots,
paired outcomes, validation/submission files and archived training inputs are
preserved. Daily training archives retain their existing 180-day policy.
An active evaluation can exceed the retired-input budget; retention must not
invalidate it by deleting its evidence. Cleanup does not restart the learning
observer or change its source fingerprint.

Riders checkpoint their journey and tester browser state to private
`resume.json`. A restart within five minutes restores tracking and marks the
resumed journey excluded from accuracy scoring. Session restoration is applied
once per browser context, so it cannot resurrect an old ride on the next trip.
The separately supervised learner continues through rider restarts.

Tests: `npm test -- scripts/retention scripts/rider-watch`.

Guardian rider alerts now keep separate checksummed evidence bundles before
routine logs or images expire. Pending incident bundles are protected; resolved
bundles roll by seven days and a 256 MiB target. Capture errors, overage and
historical gaps are visible in the bridge's evidence status. This does not
change the rider or learning retention policies above. See the
[guardian bridge](../guardian-watch/README.md).
