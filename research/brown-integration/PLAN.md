# Brown response / actual selection integration gate

Pinned before implementation. Hosted synthetic/development integration only;
no September 23–29 responses, physical outcomes, new model selection, threshold
changes, altered candidate fields or deployment. The four-arm machine lock
remains `4d1e09bd3cb41762a11e19a7de49bcfb8d8c479b44b3354a845df1b6c8f82742`.

## Exact dependencies

- Complete-response adapter implementation `1d2e7f9b680e578867500660190d25fd79ace11b`,
  immutable report head `c8ad9e117d807f8f4e7448f209102389e4d6d578`, passed run 35694780126.
- Actual frontend synthetic-selection checkout
  `4f5d261bb119093dec724afc00411808b685d251`, implementation
  `30996f91e4e09764ff55fb2c762bdfd67ce407e2`, passed run 35694101810.
  Keep this in a separate dependency checkout: its frontend is captured source
  `05a988194af3c376e5aa5da16682c29f797db2b2`, tree
  `39e7e9738975f45dfb5c443cc99961a39e9aa4ef`, not the older research frontend.
- Sealed frozen K8 builder/runtime `434afd324fb39d8f4ee2f0dfe7df6d58f9805f92`,
  artifact from run 35694227486, ID
  `d8648c2a87c00a113268e5da49ef6a8fa46c62081f740ac9bf8152fb7f648c76`.
- Original unscored development features, paths and fits from run 35691411464;
  canonical topology from run 35684356219. Only already opened September 16–20
  inputs are used. Rolling K5 production artifacts remain root-owned. Until
  available, explicit development fixture pools/manifests are permitted, never
  historical availability claims about a subsequently built real artifact.

## Input geometry review before implementation

The frozen exploratory September 21 export's fleet-before/after snapshots were
received September 22 at about 04:04:20 and 04:04:26 UTC. Their byte SHA256s are
`ea0d097530c2ca9c7b98d374c031027df3e09717f5b85b14ca8ba3b4d3be3d28` and
`a45d5725fd565a933f194a26f12fa52518a229caf807b98e9cc66b00e2c08bac`.
Both have the exact canonical Brown stop order, stop coordinates and 145-point
path. The path's sorted-key compact JSON SHA256 is
`1b9ddd6427c79fd425120a9d9de8ead1c3107a9d0e45a480279ad15348d01019`.
The strict geometry gate is compatible with these metadata snapshots. Both
contain zero Brown buses and zero Brown wire rows: this proves no actual Brown
wire eligibility or coverage. No geometry guard is relaxed.

## Required integration and gates

1. Collect the union of all required source-clock/whole-target-group queries
   from every original response row, preserving duplicate row ordinals and
   occurrence contracts. Targets absent from a response still participate in
   group support. Do not use model support or outcomes to choose query requests.
2. Execute those queries through the original Python fit and immutable pools.
   Bind request/result sidecars to exact model artifact, pool, source, parameter,
   protocol, input-response and request hashes. Missing/duplicate/altered queries
   or wrong bindings are execution errors; explicit `null` means unsupported.
   Never reinterpret a missing sidecar as a weak model or silently fit new data.
3. Feed the exact complete baseline and four overlay arms through the actual
   frontend adapter, with separate clocks, component state and causal sidecars.
   Sessions run sequentially because frontend stores are module-global; repeat
   in reversed arm order to prove state isolation. Keep actual poll application,
   same-array ETA attachment, planner cap, destination rows, original ranking /
   visibility holds, reminder state, profile A and profile B behavior.
4. No-treatment, invalid-wire and unsupported-model payloads must reproduce the
   complete original reference component state exactly. Check actual server /
   receipt clocks, aging and expiry, disappearance/recovery and permanent disarm.
   Preserve distribution arrays and every field except permitted low/high cells.
5. Synthetic ranking/reminder stress cases use fixed complete Brown geometry
   with competitor routes. Keep declared synthetic bounds/phase inputs distinct
   from original-Python fit controls. Require observable ranking and reminder
   divergence in mechanism fixtures, never call it measured model improvement.
   Exercise both original/guarded variants and both Ks without choosing a winner.
6. Reuse all original response/control/prefix gates. Development source clocks
   are deterministic: the first archived Brown forecast and the previously
   documented September 18 phase-return interval; no new case chosen from
   accuracy or boarding outcomes. Seal forecasts/decisions without any labels.

The old 50-point dots remain unchanged, so `ArrivalDetails` plots and probability
consumers still describe the old distribution despite a changed bound envelope.
This diagnostic hybrid is not a coherent probability export. Full capture/raw
clock alignment, a scalable prospective scenario runner, reviewed physical
outcome/censoring logic and final launch approval remain separate boundaries.
