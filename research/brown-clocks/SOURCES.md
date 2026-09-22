# Where the clock limits come from

These are code owners at the pinned research base3d6e571; no production file is
changed by this experiment.

| Contract | Research owner | Production counterpart |
|---|---|---|
| Retained-source age<=45min | canonical-windows/replay.ts:75 origin export and:63 release-latch processing | collector/k10Clock.ts:67 for qualified non-Red scopes and:82 for Red; server/k10Trial.ts:25 and server/blueK10Trial.ts:59 recheck source age |
| Checkpoint observation age<=15s | canonical-windows/replay.ts:73 readiness | collector/k10Clock.ts:94 snapshot; server/k10Trial.ts:75 and server/blueK10Trial.ts:82 overlay |
| Ordinary live observation age<45s | Alternative adopts the published constant, with a strict boundary | web/etaSource.ts:8 ETA_MAX_AGE_MS and:29 snapshot freshness; server/serverEta.ts:254 recompute inputs and:312 live-row filtering |
| Brown training path<=90min | canonical-windows/PLAN.md and workflow/canonical-windows.yml BLUE_MAX_PATH_SECONDS=5400; k-sweep/evaluate.py:76 | Brown has no qualified production checkpoint scope in collector/k10Scopes.ts |

All production paths above are relative to services/shuttle-v2/src unless
prefixed web/; research paths are relative to research/. The workflow lives in
.github/workflows/canonical-windows.yml.

Git provenance: Red PR312/c294fde introduced both45min and15s limits. Blue
replay95645f6 and PR316/2af5f79 retained them. Blue's DIAGNOSTIC-PLAN.md explicitly
increased only the training-path cap from45 to90min, keeping handoff rules and
other gates fixed. Thus45min is a real inherited validity guard, not accidental
data corruption; repository history does not show a Brown-specific validation
that45min is the correct retained-source lifetime. Ninety-minute fitting support
justifies a bounded sensitivity test, not an automatic validity extension.

The15s checkpoint contract is stricter than the45s ordinary-live contract.
The alternative never extends the live server's freshness allowance:45s is
unavailable, actual observedAt is never advanced and other vehicles' successful
polls do not refresh this bus. The120s collector TTL and belief/restart retention
are separate contracts and are not used as experiment constants.

Both factors preserve confirmed source-departure knowledge and one-way release.
Increasing a source lifetime alone while retaining45min release processing
would omit evidence in the newly admitted range; that is why both use the same
per-arm horizon here. This does not resolve the separately reported K8
source-occurrence ambiguity when no completed wait departure was retained.
