# First prospective rolling Brown K5 export

September22,2026. No prospective performance data or outcome labels are opened.
All raw-data parsing, replay, fitting and tests run on hosted GitHub runners.
This build supplies the already fixed September23 rolling arm in the four-arm
lock `a1ee9cc`; it does not change that lock, select a K or deploy a model.

Use unchanged Sep3–20 raw input from35677536788, plus only the raw-position table
from the immutable Sep21 export started Sep22 04:04:19.844491UTC. That day was
already exploratory. Exact gzip SHA is
`250494e8bbc09794da6df73b772ba1f78addf83c4511e186e34ffee1c4c05381`;
the wrapper declares179,751 rows, all in Sep21 ET. Preserve original compressed
bytes and provenance in the research input branch; do not copy prediction,
arrival, visit, scorecard or rider data. Hosted validation checks hash, declared
columns, header/trailer, row count, identities, finite values and day range.
Transport completeness does not establish complete service coverage.

Replay the fixed original and Brown-only directed reducers over all observed
raw rows in time/provider order, with the exact existing reconciliation and
visit-row mapping. Neither reducer may use a finalized database visit or close
an open visit at EOF. Guard source remains SHA472c2e7a5babebcb3e2d31736aa4d3ddb013d11bb73ebd157d3daf65719719f6.
Whole-stream training cutoff is strict Sep22 00:00ET; no Sep22 context can close
a visit into this model. The original emitted prefix before Sep21 must match
the saved canonical visit records exactly apart from deterministic local IDs.
All non-Brown events must remain identical between arms.

Before fitting, require exact Brown physical arrival/departure/actual-knownAt
multisets and strict physical source ledgers, including unresolved pinned
events. Preserve anchor-only differences and unpinned bookkeeping separately.
Delete future suffixes at Sep16, Sep21 and the fixed noon Sep21 boundary and
require exact preceding original/guarded emissions; never relabel a discrepancy
as an ordinary missing-data fallback. Provider IDs describe observed continuity,
not proven identity of a physical vehicle.

Fit the unchanged canonical model with knownAt/raw times strictly before Sep22
00:00ET, fixed waits,90-minute path cap and all unchanged support/weighting rules.
Require physical path identity and numerical fit equality between the two
phase variants for Brown K5, all targets in both wait groups. Validate query
parity at all admitted source clocks and a fixed hourly Sep23–30 clock grid,
including unsupported queries. Refit from physically cut prefixes and require
identical pools and fits. No accuracy, window, action or outcome score is read.

Serialize every K5 cell in original list order with source/target/intermediate
provenance and causal raw/visit prefix hashes. Reload using unmodified original
fit/helper ASTs, with equality against the live model object. Generalize the
existing sealed loader only for the two already locked model schedules; the
frozen K8 export/manifest remains unchanged. Verify the prior frozen artifact
still loads and its saved fit controls remain exact.

Seal only after all gates, with true hosted builtAt and fixed validity Sep23
00:00ET to Sep24 00:00ET, exclusive. No historical backdating, expired-model
extension or partial-model substitution. A failed physical/path gate halts the
guarded comparison; do not tune using outcomes. Export a manifest compatible
with the response adapter and retain all hashes, source code, exclusions and
gate evidence. Rolling exports for later days require separately sealed raw
inputs and the same predeclared daily embargo; this first build is not a claim
that a daily schedule or the prospective end-to-end pipeline is already running.

## Pre-seal provider-field correction, September22

The input-only gate at318be10 found one original K5 path, already from September16:
#126 leaves Science Park at11:04:19ET and arrives again11:46:34ET. All504 raw
observations in the original training-quality bracket use provider66423. Its
target arrival/anchor also uses66423, but the closing visit is emitted at12:03:59
under66443. The collector explicitly retains `anchor_bus_id` across an ID
reissue; `visit.bus_id` is the provider at closing/emission, not necessarily at
arrival. An extra equality assertion between closing row IDs therefore tested
the wrong time span. Diagnostic run35695968897 preserves the failure and data.

Before sealing, replace that extra assertion with explicit verification of the
unchanged original quality interval: source departure through target arrival.
For every mismatch require one raw provider over that bracket, matching the
source ID and target anchor ID, and prove all observed transitions to the target
closing ID occur after target arrival. Otherwise halt. Preserve the entire
original physical/knownAt multiset, source/target IDs, pools, fits, cutoffs and
post-arrival transition evidence; discard or relabel nothing. Do not claim the
later wait stayed under one provider or infer physical vehicle identity from
the service identifier. Rider boarding outcomes still need their own continuity
through departure; this training-input clarification does not relax that gate.
