# Fixed capture continuation, September 22–30

Root approved the scope in `plan.json` before implementation: preserve the existing capture A, add only B/C, at most 9 GiB of aggregate recorder allowance, 3 GiB per part and the unchanged 4 GiB free-space floor. The unchanged frozen recorder ends every part at September 30 00:30 ET. Nothing here changes a model, observes prospective outcomes or extends collection into October.

| Part | Launch, ET | Primary requests, ET |
|---|---|---|
| A | Already running; never restart into its directory | Original start to September 25 00:00 |
| B | September 24 23:59 | September 25 00:00 to September 28 00:00 |
| C | September 27 23:59 | September 28 00:00 to September 30 00:30 |

Intervals are half open. The launch overlap is fixed at one minute. If the successor persists a transport-complete fleet request begun at or after its primary boundary and received within two minutes, the metadata-only handoff stops the exact predecessor process. This is independent of buses, ETA values, build acceptance or research results. A valid empty fleet suffices. Failed/missing successors do not move ownership: preserve the predecessor for audit, record failure and leave the gap visible. There is no restart, retry timer, fourth part or best-response substitution. A late timer, reboot, clock discontinuity, cap stop and partial capture remain explicit limitations.

`continuation_control.py` verifies the frozen manifest/tool hashes, external recorder bytes and exact process arguments before launch or stop. A failed handoff is write-once. It reads at most 16 MiB of bounded committed journal metadata, never bodies, and has both wall-clock and monotonic deadlines. Unit resource limits match the existing capture: Nice 15, CPUWeight 10, CPUQuota 25%. The new persistent timers survive a reboot, but a missed launch outside the fixed two-minute handoff allowance fails closed. They do not resume into a previously created directory. The existing A service is untouched until a proved B handoff.

## Provenance and stitching contract

The exact recorder and sealed-prefix decoder are vendored under `reference/` with commit/path/SHA provenance. Only their synthetic fixtures run in this workflow. The production recorder remains the previously frozen external file. New code does not edit these references or the existing partial A capture. A's 3,837-record prefix head from the metadata audit is an immutable anchor; every eventual A prefix must contain it unchanged.

`index_parts(plan, {part: (sealed_directory, external_seal_sha)}, output)` verifies complete sealed prefixes with the pinned decoder before publishing `verification.json`. It uses an on-disk SQLite sort; no fleet/body history is held in memory. Original metadata and source references remain in every record. A record identity is part + source sequence + journal-record SHA, independent of how much later data a sealed prefix contains. The seal remains a separate locator/provenance field.

Primary ownership uses exact `requestedAt`, admission uses exact original `receivedAt`, both at microsecond precision. Sort ties by fixed A/B/C order and original source sequence. A pre-boundary request received afterward remains owned by the old part and unknown until its receipt. Overlap fleet requests are preserved but never become extra observations. Incoming prelude health/assets are **part-scoped release context only**: they cannot replace the active fleet, retrospectively qualify a build, or change rider/scenario state. Schedule-gap records have no requestedAt and remain unknown-span evidence; do not invent missing ticks or use them to repair boundaries. Failures, unknown source identity, ambiguous releases and unsafe clocks remain explicit. No EOF visit closure is created.

The index is a provenance layer, **not an app outcome adapter or a frontend parity proof**. `updateFleet`/`fleetUsable` mean only an owned, transport/schema-usable body; `strictIdentityKnown` and `acceptedRelease` remain false. A future authorized consumer must retain per-part decoder/release evidence, existing permanent unsafe-frontier behavior and version qualification. It must carry the same scenario/frontend/model/action state across part boundaries without re-arming, changing freshness, refitting, or choosing an alternate response. The synthetic state-consumer fixture tests this interface contract only. `decisionReady` means all three prefixes verified without observed unsafe clocks; it does not prove service completeness or source/app eligibility. Closed/stopped captures may still contain gaps. No real raw body is opened by building the review bundle.

## Hosted check and installation review

The `capture-continuation-fixtures` workflow runs only synthetic fixtures: fixed caps/dates, launch/handoff failures, request/receipt straddles, exact receipt ties, overlap de-duplication, metadata mutation, future-prefix parity, cap stops, preserved gaps, unknown health identity, microsecond clock rollback, unchanged simple scenario state and immutable bundle hashes. It then creates a small review artifact containing the frozen deployment manifest, complete tool hashes, eight unit/timer files and `INSTALL-REVIEW-ONLY.sh`. No captures, reports or upstream bodies are downloaded.

**Do not run the installation script until root reviews this exact hosted artifact.** It verifies `review-seal.json`, copies the immutable tool bundle and installs only the four fixed future timers plus their services. It does not execute a new capture immediately when installed before the declared dates. Root must verify artifact/source/deployment SHA and inspect the generated command file. Nothing in this branch installs a timer, stops a service or changes a schedule by itself.

After an approved installation, inspect `systemctl --user list-timers --all 'shuttle-public-fleet*'` and the exact unit files. At each boundary inspect the write-once `capture-continuation-audit-<commit>/handoff-B.json` / `handoff-C.json` and service journal. Capture failures require reporting, not adaptive parts. Source snapshots/outcomes remain unopened until their separate protocol authorizes access.
