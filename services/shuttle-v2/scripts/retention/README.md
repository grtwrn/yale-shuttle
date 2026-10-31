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
| Original rider feed responses | 256 MiB / 7 days per rider; separate per-trip journals |
| launchd output logs | 10 MiB live + 3 compressed backups |
| Eligible superseded learning inputs | 256 MiB / 7 days from the recorded hour's end |

Active served-control-v2 inputs remain protected from their original seed,
including warming: later verification needs the complete source chain.
Legacy warming inputs can expire only when they contain no pending/candidate
receipt and are outside the 47-minute boundary window. Active calibration/test
inputs and the current champion's publication evidence remain protected. Source snapshots,
paired outcomes, validation/submission files and archived training inputs are
preserved. Daily training archives retain their existing 180-day policy.
An active evaluation can exceed the retired-input budget; retention must not
invalidate it by deleting its evidence. Cleanup does not restart the learning
observer or change its source fingerprint.

A closed context with a source refusal or protocol failure also protects its
input journals, including every context with the same frozen trial checksum.
Starting a fresh scientific trial does not release that failed cohort into
ordinary rolling deletion. Retention reports `refusedTrialContexts` and
`refusedInputBytes` separately from active trial identities; a conflicting
frozen/closed trial identity refuses cleanup. This protection preserves only
files that remain available and cannot recover earlier deleted journals.

Completed quality decisions protect every context of their original trial too,
including an ordinary rejection for failing to improve the score. These are
reported as `completedTrialContexts` and `completedInputBytes`; they do not
create a source refusal or change the recorded decision. A daily training
database archive is not a complete copy of these original inputs.

An operator may also pin a trial in `custody-pins.json` in the learning root:

```json
{"v":1,"trials":[{"trialSHA256":"<64 lowercase hex>","contextId":"cycle-<timestamp>","frozenSHA256":"<SHA256 of the original frozen-candidate.json bytes>","reason":"Original inputs still required by the source evaluation."}]}
```

The pin is anchored to the original frozen context and protects every context
sharing its trial checksum. A malformed or conflicting record stops learning
cleanup before deletion. Pins have no automatic expiry.

Publish pin and release controls through `writeLearningCustodyControl` from
`control-snapshot.mjs`, which shares the storage maintenance lock and syncs
the atomic replacement. For example, from the service directory:

```sh
node --input-type=module - LEARNING_ROOT custody-pins.json CONTROL_RECORD_JSON <<'JS'
import fs from 'node:fs/promises';
import {writeLearningCustodyControl} from './scripts/retention/control-snapshot.mjs';
const [root, name, file] = process.argv.slice(2);
console.log(await writeLearningCustodyControl(root, name, JSON.parse(await fs.readFile(file))));
JS
```

Use the named `custody-releases/TRIAL_SHA256.json` path to publish a release
record with the same helper. Direct manual writes do not share the lock;
retention also rechecks control identities and active/trial/champion scope
immediately before deletion and aborts if it observes a concurrent change.

To archive a completed, fully retired cohort, run:

```sh
node scripts/retention/archive-cohort.mjs LEARNING_ROOT TRIAL_SHA256 NEW_ARCHIVE_DIRECTORY
```

The destination must be a new directory in a separate tree from the learning
store, with an existing parent. The exporter copies every context file, including complete
original compressed journals, source snapshots, runtime checkpoints, paired
outcomes and decisions. It verifies the copies, rechecks all original bytes
and membership, syncs the archive files and directory hierarchy, and writes a
synced sealed manifest last. Membership must match the original trial identity
and every ordered, checksummed prior context link in its frozen and closed
descriptors. A surviving subset cannot be archived as a complete cohort.
Missing declared inputs, contexts, links, changing evidence or a live trial
refuse export. Default limits are
16 GiB, 16,384 files and a 20 GiB free-space reserve; a failed export remains
unsealed. Exporting does not release originals or change any scientific gate.
Every explicitly declared seed, source event, runtime checkpoint and frozen
source member must be present with its original checksum too. External
training archives retain their separate 180-day policy; this exporter copies
the native trial's context files and does not certify indefinite training-data
availability or physical ETA accuracy.

After reviewing the complete archive, an operator can write
`custody-releases/TRIAL_SHA256.json` in the learning root:

```json
{"v":1,"trialSHA256":"<trial checksum>","reviewedAt":"<ISO timestamp>","note":"<review basis>","manifestFile":"<absolute manifest path from exporter>","manifestSHA256":"<manifest checksum from exporter>"}
```

Retention independently checks that the archive and learning store are
separate trees, validates the full original lineage, and verifies every
archived byte and all original context files before accepting the first
release. It syncs the archived bytes and writes a separate durable acceptance receipt before
any removal so later runs can distinguish already expired journals from
originals missing before custody was established. It verifies the archived
bytes again on later runs. A valid release makes completed inputs eligible for
the ordinary rolling budget; it never overrides active, champion, refused or
pinned protection. `archivedTrialContexts` reports verified released cohorts.
`--dry-run` checks the same evidence without writing acceptance receipts or
removing inputs. Keep the archive while its release remains in use; missing or
corrupt archives stop further learning cleanup. No existing missing evidence
can be recovered or certified by creating a release record.

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

Original feed responses live in `feed-responses/<numeric-run-id>.jsonl`.
Each record contains the exact decoded response bytes as gzip/base64, their
checksums, receipt time and a small allowlist of response headers. Sample and
arrival records refer to their receipt identity. Capture reuses responses the
rider already received; it sends no additional request. Startup requests are
marked separately from page responses, and a saved feed does not prove that a
DOM text read used the same snapshot.

Completed, unpinned response journals roll by age and total bytes. The active
and checkpointed trips and `storage-pins.json` run IDs remain protected. Their
overage is reported; a 512 MiB protected ceiling refuses further capture
without deleting protected evidence. `storage-policy.json` can override the
`feedResponses` object (`maxBytes`, `maxAgeMs`, `maxProtectedBytes`). Individual
bodies are bounded at 8 MiB decoded and 1 MiB compressed. Capture failures are
explicit on samples and in rider status; three successive failures create a
`candidate-feed-evidence` event.

Incident bundles copy first, latest, event-nearest and available arrival
response context within an 8 MiB allowance and the existing 32 MiB bundle cap.
Their `feedResponseCoverage` distinguishes retained context, unavailable bodies,
and omissions by selection or byte budget. These copies survive routine cache
rotation. They do not imply complete trip HTTP custody or physical ETA accuracy.
