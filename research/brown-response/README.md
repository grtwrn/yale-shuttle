# Complete-response Brown adapter: development gates only

This implements the response boundary of the four-arm lock at `a1ee9cc` without
changing that lock. Work is limited to synthetic complete responses and the
already opened development artifacts ending September 20. No prospective body,
outcome attachment, accuracy score, new fit, selected K or production change is
authorized by this workflow.

The adapter keeps every original row ordinal, target occurrence and hop count.
It never computes a target from guarded phase plus old hops. Only supported
Brown low/high cells change. Unchanged row arrays, distributions, buses,
metadata and every other payload object retain their original references; the
original response is never mutated. Invalid wire input remains invalid and
unchanged. Whole-group support includes targets absent from the wire.

The clock sidecar reuses the pinned reducers and guard, consumes full raw polls
only through the server ETA clock, and carries actual source-emission knownAt.
It cannot rewind or use a newer public fleet fix to refresh an old ETA snapshot.
Missing raw-prefix proof, unknown/ambiguous provider, incompatible route geometry
or model availability produces exact fallback with a recorded reason. Scientific
physical/path/source/fit discrepancies halt a comparison instead of becoming
ordinary fallback.

The numerical fit is an injected synchronous query against the unchanged Python
fit and a sealed path pool. It is not ported to JavaScript. The development gate
uses previously sealed `fit-comparisons` values from run 35691411464; absent
queries are execution failures, never silently interpreted as weak support.
Synthetic manifests are explicitly marked as fixtures and rejected by default.
They prove availability boundary behavior, not that a historic model existed.
Real sealed artifacts and future query sidecars remain root-owned integration.

The complete-response tests use synthetic wire shapes. Development controls
wrap each logged row in a synthetic response; these are not falsely described
as archived full public responses. The development clock/features, source ledger,
all four original predictions, and prefix-deletion controls must match exactly.
All computation and tests run on GitHub; only static edits occur on the Pi.

## Representation and integration limits

`ArrivalDetails.tsx` prefers the old 50-point distribution dots when present,
even when this adapter changes low/high. Consequently its expanded plot and any
unchanged probability consumers still describe the old distribution. The new
envelope is a diagnostic hybrid, not a coherent CDF or production-ready forecast.
This adapter intentionally does not repair that mismatch by changing extra fields.

Root verified the initial captured frontend HTML/JS byte-for-byte in run
35693019507: production source `05a988194af3c376e5aa5da16682c29f797db2b2`,
web tree `39e7e9738975f45dfb5c443cc99961a39e9aa4ef`. That establishes the initial
bundle's provenance, not whole-app scenario parity, later-release compatibility,
raw/public alignment or boarding-outcome validity. Those remain launch gates.
