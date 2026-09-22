# Proposed immutable capture continuation — awaiting root review

This is a transport-only plan, not an executed schedule or permission to open prospective bodies/outcomes. Preserve the September 23–29 scenario roster and September 30 00:30 ET capture deadline. Do not increase the existing recorder's 3 GiB byte limit or lower its 4 GiB free-space floor.

The September 22 metadata audit projects the current 3 GiB limit binding between September 27 and 29 if recent rates persist. These are capacity scenarios, not service forecasts. Clearing only the verified npm cache restored 16.93 GB free; it does not change this separate recorder limit.

Proposed fixed parts, declared before the prospective observations:

| Part | Primary request interval, ET | Start recorder | Stop old recorder |
|---|---|---|---|
| A, existing unchanged capture | Current start through Sep25 00:00, exclusive | Already running | After part B has persisted a complete fleet request at/after the boundary; stop explicitly and preserve final manifest |
| B, new immutable directory | Sep25 00:00 through Sep28 00:00, exclusive | Sep24 23:59 | After part C has persisted a complete fleet request at/after the boundary; preserve final manifest |
| C, new immutable directory | Sep28 00:00 through Sep30 00:30, exclusive | Sep27 23:59 | Existing absolute Sep30 00:30 deadline |

Each part uses the same frozen `bae23b33211c73589ede784bf32d3485124874d1/capture.py`, SHA256 `4f494f132da14bd369b768605190a77319ef1586e326f062289ec6f1274115b3`, public origin, 15-second cadence, 60-second health cadence, 8 MiB body limit, 3 GiB stored-byte limit, 4 GiB free-space floor, request timeout, CPU/Nice bounds and failure recording. Each writes a fresh directory and fresh hash chain; nothing appends into or rewrites a closed part. At most three parts, at most 9 GiB aggregate recorder allowance; no adaptive additional parts. The free-space guard remains active throughout. This proposal requires explicit root approval because it extends the originally single-part bounded collection allowance.

Freeze a top-level manifest before launch with code/unit hashes, part IDs/directories, exact UTC boundaries, all limits, previous-part references, and the following deterministic stitching rule. A record is primary only when its **requestedAt** lies in that part's assigned interval. Keep all overlap records for provenance, but never feed both copies as extra observations. Retain primary failures and schedule gaps. Sort admitted events by original receipt time, preserving original sequence ties and capture-scoped IDs. A request started before a boundary but received after it remains future information until its receipt; it is not discarded or moved backward. Carry scenario/frontend/model state across boundaries; do not replan, refresh freshness or re-arm merely because the capture part changes.

The one-minute overlap establishes new health/assets context without resetting an ongoing episode. New-part capture failure is a recorded missing-input interval; do not choose whichever duplicate response gives a better ETA or outcome. If the successor has not persisted a complete fleet request within two minutes after its boundary, retain the predecessor for audit, record a continuation failure and alert root; do not silently change the predeclared primary interval or manufacture uninterrupted coverage. A reboot or crash similarly remains explicit. Missing/bracket-ambiguous release identity remains unavailable under the existing decoder contract.

Before any actual bodies are consumed for replay, require a small GitHub-hosted synthetic stitching test: request/receipt straddles, equal timestamps, duplicate overlapping bodies, failed successor, health/build ambiguity, cap stop, no double cadence, preserved gaps and unchanged continuous scenario state. This is a recording/provenance repair, not a candidate-model or outcome-adapter change. Root owns implementation and collection-unit approval; no units or timers were changed by this audit.
