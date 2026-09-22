# Evidence capture for midnight-crossing trips

This performs lightweight, read-only exports of the seven public-fleet archive
tables. It runs no fitting, replay or outcome scoring. The admin token is read
locally and sent only to the production archive endpoint; it is never logged.

`capture-pair.py 2026-09-21 <new-output-directory>` sequentially preserves the
closed September21 day and partial September22 context. Each has original
JSONL header/row/trailer bytes, compressed/raw hashes, export-time health and
fleet snapshots, and per-request timestamps. Failed pulls remain identifiable
and never replace previous evidence. A subsequent retry needs another output
directory. The pair runner still attempts the second day if the first fails.

Schedule the one-off export for September22 at03:45ET, after the03:35 closing
scorecard and03:40 routine archive and before September21 raw observations
begin aging out at noon. The existing00:04ET September21 export stays intact.
Neither elapsed wall time nor complete transport establishes settled outcomes,
full service coverage or valid GPS: those require later hosted validation.
September21 includes previously inspected Red examples and remains exploratory.
September22 is exported as partial context, not a complete service day. This
capture does not open the prospective September23–29 comparison.

Heavy tests run on GitHub. A temporary local timer may run only this streaming
export, with a CPU cap and low priority; no new browser, model fit or permanent
service is introduced. The scheduled service's unit/status and resulting
manifest must be checked after execution. Metadata or framing failures cannot
be treated as successful evidence capture.
