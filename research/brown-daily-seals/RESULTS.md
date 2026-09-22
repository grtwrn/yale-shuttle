# Daily Brown automation: implementation review packet

The implementation is research-only and inactive. Tested source:
`51adecc7bc580deab59695cc1583c61ecb3bdccf`, branch
`research/brown-daily-seals-2026-09-22`. The original Sep23 seal at `6546241`
and its raw/model artifacts remain unchanged. PLAN.md was approved before
implementation; COMMANDS.md now names the actual interface and inactive units.

## Evidence and scope

Final hosted gate: [35784902440](https://github.com/grtwrn/yale-shuttle/actions/runs/35784902440), **success**.
HOSTED-RESULTS.json retains its compact exact input, artifact, stream and
resource identities. This gate uses synthetic fixtures and already-opened
Sep3–21 development history only. New models fitted: **0**. New raw days read:
**0**. Forecast-error scores: **0**. No real seal request or timer was created.

The 21 synthetic fixtures cover the fixed Sep24–29/context-only Sep30 schedule,
D−1 embargo, cumulative immutable selections, server-only provenance and
retention, archive tampering/duplicates/strict schema, unchanged scientific
function ASTs and fixed query grid, request commit/push lifecycle, first-success
idempotence, unresolved GitHub admission, actual publication receipt clocks,
catalog recovery after a state-write crash, global scientific holds, and
aggregate child RSS/scratch enforcement. Two inactive calendar expressions
also passed hosted systemd parsing.

The final full reducer control took **132.7 seconds**, with **1,465,483,264 bytes**
peak aggregate RSS across up to five processes and **974,446,592 bytes** peak
scratch. No resource limit was exceeded. Compact result artifact **10719178205**
is 8,922 bytes, SHA256
`830ca641e844856e01f006e8af06158d91720a5a3d0466aba181facdf756c628`.

A separate tiny synthetic artifact was actually uploaded, downloaded by ID
with explicit extraction layout, compared byte-for-byte, and checked against
GitHub's artifact ID/digest/run metadata at actual receipt. It is explicitly
not a model or seal. Both workflows share one noncanceling concurrency group;
request/data pushes do not trigger the fixture workflow.

Sep21 normalization matched all **179,751** eight-column raw records from the
original header/trailer export exactly after its original projection/sort.
The full historical replay processed **1,667,721** observations. All four full
uncompressed baseline/guarded event and visit streams matched saved successful
Sep23 diagnostic artifact **10680881133**, run **35696391115**, byte-for-byte.
Brown: **839/839** matched physical visits, **0** discrepancy keys, **0** metadata
differences, **145** anchor-only differences; totals 991 baseline versus 845
guarded visits. All **274,800** non-Brown events matched. The unchanged six
historical prefix-deletion checks and strict physical source parity passed.
The regenerated new-day wrapper retains all old prefix controls and adds the
newest admitted day's midnight/noon controls; it cannot reuse the Sep23 gate.

This proves normalization and reducer compatibility for the opened control.
It neither validates future physical outcomes nor demonstrates a better ETA.
Full path/provider/numerical and frozen K8 reload gates remain mandatory on
each future daily prefix before a new artifact can publish. No new-day fit was
run to exercise those future inputs during this review.

## Exact review surfaces

- `IMPLEMENTATION.json`: hashes 106 source, lock, workflow and unit files,
  including the unchanged original reducer/guard/fitter closure and four-arm
  JSON lock `4d1e09bd3cb41762a11e19a7de49bcfb8d8c479b44b3354a845df1b6c8f82742`.
- `contract.py`, `inputs.py`: schedule, immutable gzip package, provenance and
  hosted-only decoding. Sep21 fixture package keeps original selected/snapshot
  manifests; it does not invent an original HTTP wrapper for normalized rows.
- `generate.py`, `sealing.py`, `run_daily.py`: checked original-source
  substitutions, fresh reducer/fit gates, actual post-verification build clock,
  source export and aggregate resource watchdog.
- `controller.py`, `select_request.py`, `publish.py`: unique immutable pushes,
  admission/state/lock recovery, verified artifact publication and actual local
  acceptance time. Any scientific halt blocks subsequent new days until review.
- `.github/workflows/brown-daily-seal.yml`: real workflow, triggered only by one
  newly added immutable request. None exists in this review branch.
- `units/brown-daily-seal.service` and `.timer`: 04:10/06:10/10:10 ET Sep23–29,
  each targeting the next fixed day. `brown-daily-seal-status.service` and
  `.timer`: 17:10 status reconciliation only. All four remain uninstalled.

First accepted success is authoritative. Missing or late artifacts retain
the exact served comparator until actual acceptedAt and within fixed validity;
yesterday's artifact cannot be extended. Separate Sep30 validity remains
00:00–00:30 ET and introduces no evaluation start. A recorded scientific
discrepancy cannot become ordinary fallback or an automatic retry.

## Operational limits and remaining boundary

One hosted research job at a time; 60-minute GitHub job timeout. The workload
watchdog covers replay/fitting and their child processes: 55 minutes, 6 GiB
aggregate RSS, 12 GiB workspace scratch, 4 GiB Node heap. Dependency setup and
artifact download/upload are outside that workload watchdog but inside the
60-minute job timeout. Reported peaks are sampled every 0.1 seconds for RSS
and 2 seconds for scratch, not a hard OS memory reservation. No history or
gate may be reduced to recover from a limit failure.

Only small summary metadata was downloaded to the Pi. Original/raw/model
research scripts and the complete production subtree have no diff from the
frozen base. All tests, GPS decompression and reducer replay ran on GitHub.
Original Sep23 model evidence, four arms, thresholds, frozen frontend proofs
and the 28,224-profile benchmark were not changed. Later Android frontend
releases remain outside those source qualification proofs.

Root still needs to review the concrete code/commands/units before requesting
any new-day fit or enabling timers. This is the explicitly approved boundary
for this implementation task; no credentials, private/rider endpoints,
notifications, new recording, candidate activation or production change were
introduced.
