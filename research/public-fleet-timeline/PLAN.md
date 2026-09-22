# Prospective public fleet timeline

September22,2026; pinned before implementation and recording. Existing
predictions_log rows cannot reconstruct simultaneous route choices: browser
and server deduplication discard occurrences and option/context state. Preserve
complete public responses for an independently pinned synthetic-trip replay.

Capture only GET https://yale-shuttle.fly.dev/api/buses without query overrides,
GET /healthz, root HTML and its same-origin JavaScript/module-preload resources.
No geocoder, rider location, report, shown-prediction, notification, private
endpoint or authentication token. No browser, model fit, outcome label, route
selection or ETA scoring runs in the capture process. The complete public feed
contains topology, segment/dwell tables, pace, schedules, model params and live
server ETA rows/distributions when available. Missing ETA remains missing.

Preserve exact HTTP response-body bytes, status, selected response headers,
request/receipt UTC and monotonic clocks, content and compressed hashes, errors
and explicit size limits. Content-addressed gzip blobs may reuse byte-identical
bodies, with a separate immutable record for every request. Raw responses must
remain recoverable; do not regenerate or normalize them from parsed JSON.
JSON parsing only supplies schema/clock metadata; malformed and failed responses
remain evidence, never successful empty fleets. Partial reads remain partial.

Default15-second cadence, no overlapping requests or catch-up bursts. Health
checks every60seconds bracket release attribution; fetch HTML/module resources
initially and when health build changes. A health bracket is evidence, not proof
that no intermediate deploy occurred. Record exact URLs and hashes; do not infer
an unrecorded client bundle or splice old/new server responses into one poll.
Slow requests cause explicit missed scheduled ticks, not fabricated snapshots.

An invocation requires a new output directory and explicit UTC end time. Initial
recording will end at2026-09-30T04:30Z, with3GiB maximum stored capture bytes and a
4GiB minimum filesystem-free guard; reaching either stops recording explicitly,
without deleting prior evidence. All responses have an8MiB body cap and10-second
request timeout. New output prevents overlapping writers and overwriting old
captures. Shutdown/error records and a replace-atomically status manifest expose
incomplete runs. Completed blobs/records are immutable. No automatic restart.

Test transport failure, invalid JSON, stale/missing ETA, exact-byte/hash recovery,
dedup, body truncation, same-origin asset filtering, release change, deadline,
cadence/gaps, storage/free-space guards and existing-output refusal on GitHub.
Only after hosted checks pass, copy the tested script into an immutable versioned
directory and run as a bounded user service (Nice15/CPUWeight10/CPUQuota25%).
The existing watcher keeps its resource limits and shared-browser behavior.

September22 remains development context. Capturing September23–29 is not opening
its outcomes, validating labels or relaxing the Brown prospective protocol.
Scenarios, candidate code/fits, processing clock, plan/refresh schedule, ranking
state, walking/arming policy, physical labels and censoring must be pinned in a
separate replay protocol before interpreting held-out outcomes. Complete fleet
capture establishes transport evidence only, not chronological model causality
or whole-app safety. Heavy replay and scoring stay on hosted runners.

Before recording, the end time was extended by30minutes because pinned synthetic
plans startingSeptember29 23:30ET run throughSeptember30 00:15ET. This preserves
their full45-minute horizon and15minutes of context; it does not change a model,
scenario or outcome rule. The original04:00Z end would truncate the last plans.
