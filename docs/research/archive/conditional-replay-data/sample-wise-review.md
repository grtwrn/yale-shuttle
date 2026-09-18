# Sample-wise future lap simulation: independent review

**The first-occurrence recurrence is a defensible causal experiment for the fitted conditional-hold hypothesis. It preserves the current pricing/filter separation and the existing pass atom. It does not establish calibrated intervals or a mathematical “departure floor.”** I found a per-hypothesis departure-clock bug and the implementation now addresses it. Accuracy conclusions require the completed paired replay; no application or production changes were made by this reviewer.

I reviewed `arrival.ts`'s `sampleFutureLaps`, its callers, `startChain`, `ownDeparture`, lap support/scaling, conditional table construction, and `replay-sampled.mts`. [sample-wise-review.mts](sample-wise-review.mts) bundles a read-only copy of the actual helper with diagnostic exports and runs concrete invariants/counterexamples. [Results](sample-wise-review-checks.json) include the reviewed source hash. These are bounded semantic checks, not substitute full-route tests.

## The joint recurrence is coherent

For path k, the initial sample remains the actual chain's remaining current rest plus first drive, or its current partial drive. At each future stop s the helper uses:

- previous simulated departure from s, if this path has one; otherwise the as-of served age for s;
- lap = this path's arrival minus its previous departure, or served age plus this path's arrival;
- the same stratified stand draw, with conditional/marginal selection by lap support and the existing positive lap factor;
- this path's new departure = arrival + hold, followed by its sampled drive to the next stop.

Current standing paths seed their initial departure by subtracting the exact same drive samples from their starting samples. The current residual distribution and its existing lap factor remain unchanged by this helper. The initial next-stop vector is unchanged. Future path generation reads no observed future departure or target label: using a simulated previous departure is a normal forward-generative operation, not leakage. Earlier sampled arrivals can receive longer holds, which introduces the proposed regulating dependence missing from one nominal multiplier.

This is still a **model hypothesis**: it assumes a scaled conditional positive-duration shape and existing factors apply to each sampled lap. The fitted relationship is not proof that imposing this coupling reproduces operators' decisions. It retains the historical/live duration-origin mismatch detailed in [rest-origin-review.md](rest-origin-review.md), legacy departure availability limitations, and the inspected-date validation limits. Sample-wise dependence does not repair those definitions.

## Pass behavior is preserved

The conditional table carries the same CDF mass at zero as the marginal, and both use the same term permutation. Consequently a given path that draws a pass remains a pass when support causes it to switch distribution; multiplication by a positive factor cannot create a positive hold from zero. A direct 256-path check, deliberately spanning the lower lap-support boundary, retains exactly **64 zero-hold paths** for a 25% atom. `includesStand` still suppresses an additional stand rather than adding it twice.

This preserves the existing model's stop/pass assumption. It does not test whether stopping probability itself depends on lap or whether the separate movement-kernel `pStop` is calibrated.

## Departure-clock bug: addressed in the working tree

The first implementation computed `ownDeparture` once using the lead's standing state, then reused it for every hypothesis. If the lead still stands, that helper returns no bridge. A simultaneous moving/departure hypothesis then used the **previous lap's** served departure when pricing its next visit, whereas its standing sibling seeded its own simulated departure. This is the same class of mixed-hypothesis inconsistency `ownDeparture` exists to prevent.

The current call site (`arrival.ts:747–750` when reviewed) now calls `ownDeparture` separately using each chain's `standingAt`, including `leadNow`. This resolves the identified bridge error. The diagnostic counterexample gives next-occurrence arrival **940.03 s** with the shared lead bridge versus **1100 s** with the correct moving-path bridge.

The ongoing sampled replay was started before this source edit. Its source version should be identified accordingly. The recorded Red scoring filter excludes 20-or-more-hop targets, so the specific next-lap error is mostly outside these metrics; do not use those metrics to claim next-occurrence parity. Add a permanent regression for a standing lead plus moving alternate before any promotion.

## `departNow` is a scenario, not a lower bound

Re-simulating the future after removing the current residual is a coherent question: **“When would this bus arrive if it left this rest now, under the modeled future regulation?”** It no longer equals the original future path minus one nonnegative term. Leaving earlier can earn a longer hold at the next regulated stop.

The distinction is not theoretical only. A helper counterexample within supported lap factors removes **500 seconds** of current rest but changes arrival from **2200 to 2449.86 seconds**. The duration-scaled negative slope can exceed one second of extra hold per second saved, and support/clamp boundaries can also break pathwise ordering. This is a model counterexample, not a claim that it happens on a particular recorded rider trip.

Therefore the comments claiming `departNow`/`lowFloor` are guaranteed lower bounds, and “the same chain, one term short,” are false when this experiment is enabled. `leadNow` should be recomputed as the implementation does; retaining the old future holds would answer a different, frozen-hold counterfactual. Keep its quantiles descriptive and do not enforce them as interval floors. The existing `min(nowLow, eta)` reporting rule also means the wire `lowFloor` is not always the unaltered q10 of that counterfactual. Audit consumers before changing its public meaning. The current code does not enforce this quantity as the lower interval bound.

## Limits to retain in evaluation and before promotion

- The 256 deterministic stratified uniforms are reused by stop index across later route occurrences, as in the existing prefix sampler. Repeated visits therefore share the same stand/drive quantile rank; this is not independent noise on each new lap. Sample-dependent regulation does not turn that inherited dependence into validated serial behavior. Evaluate later occurrences separately before broad claims, and consider occurrence-specific innovations only as a distinct tested change.
- On fallback hops with `includesStand=true`, the drive distribution contains a stand and the helper seeds the current departure at zero because no separate residual exists. That is inherited incomplete decomposition, not a measured physical departure clock. The frozen Red patch supplies explicit drive quantiles on all 29 primary hops, so this fallback limitation does not explain the present Red comparison. Do not generalize that result to all fallback routes.
- Hard supported-lap boundaries and factor clamps remain. Passing through them can change individual samples discontinuously. This is existing policy applied per path, not smoothness or coverage assurance. Report jump counts and tails alongside width and WIS.
- The replay now uses production's 600 s absent-entry eviction, an improvement over the earlier scoped harness. Its belief-equality assertion still compares only baseline versus conditional nominal arms; sampled arms should also be checked. Periodic full-server parity remains a same-poll check using a cloned, already-stepped state, not an independently evolving full-server trajectory. `departNow` and `lowFloor` are currently absent from paired output, so these scenario semantics are not yet scored by the replay.
- The current conditional fields remain absent from the dwell cache fingerprint. Distinct segment objects isolate these replay arms, but a production implementation needs complete cache identity. Global experiment switches default off; changing them between independent replay engines is safe here because execution is synchronous, but they are not a production per-request configuration mechanism.

Judge the completed factorial comparison as: nominal marginal, nominal conditional, sampled marginal, sampled conditional. A width reduction with better WIS and acceptable rider/departure errors is useful even if some interval misses increase. A systematic center error or a new route-context regression should not be excused as rare tails. Freeze the selected definition before new date-blocked calibration and confirmation; the current retrospective recordings are development evidence.
