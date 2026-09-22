# Research design: directed phase and possible boarding encounters

Draft for review, September22, 2026. This document authorizes no production change, fitting, new outcome dates or reclassification of the32 earlier-pickup barriers. It proposes a diagnostic successor to the fixed c80ab5f phase experiment and its fa4a9e2 physical audit. The original artifacts remain immutable.

## What the existing evidence establishes

The published Blue Night geometry and dense same-provider traces support forward travel through the two diagnosed locations:18→19 passes near LEPH14, and2→3 passes near Elm/York5. The frozen directed-leg rule prevents their false canonical reanchors, retains the predeclared reverse/off-line recoveries, reproduces51,581 original visits and38,047 original forecast labels, and passes future-prefix checks. Red is unchanged.

This establishes a route-phase defect and a plausible causal repair. It does not establish that nearby stops were unboardable. The phase adapter suppresses98 Blue Night arrived-stopped and136 arrived-passed records and changes63 physical arrival times. Among905 newly admitted fixed-forecast rows,32 depend on looking past two earlier Elm/York encounters. #45 reports an unchanged coordinate for60.007s at53.56m from the marker; #38 has three fixes within75m, minimum48.29m. Both retain evaluation barriers. The873 other additions have no such identified conflict in the existing baseline ledger; they are not873 verified accuracy gains.

The non-Blue physical audit also finds three Purple LEPH timing changes and one new Green passed visit. Other non-Blue differences concern unarrived anchors or bookkeeping. This warrants separate accounting even where sparse prediction logs show no changed accepted label. See [the immutable report](https://github.com/grtwrn/yale-shuttle/blob/b1f9738/research/directed-leg-diagnostics/RESULTS.md) for complete counts and identities.

## Two independent causal records

**Directed phase** answers which directed part of the published route the observation supports. Record route/provider/vehicle episode, canonical topology hash, leg/occurrence candidate set, directed progress interval, supporting observation timestamps, confidence/recovery reason and actual knownAt. Keep the leg distinct from its nearest endpoint. First sight, contention, provider/route changes, missing observations, backwards motion and off-line motion can make phase uncertain or restart it. Never encode uncertainty as a forced full-lap advance.

**Possible boarding encounters** answer which physical stop markers the observed vehicle came near, and what its fixes did there. Build these directly from raw positions and marker coordinates, without reading a phase anchor, repaired index, candidate ETA, training residual or eventual service outcome. Retain:

* vehicle name, provider identity and route assignment on every contributing observation, plus explicit continuity boundaries;
* physical marker ID and an encounter/observation-episode identity independent of canonical index;
* observed entry/last-near/exit bounds, closest approach, number and times of supporting fixes, exact repeated-fix plateaus, raw movement evidence and missing intervals;
* open/closed/censored state, versioned observation provenance, every update's actual knownAt, and whether entry or exit is only bounded by a sampling gap;
* candidate marker aliases for overlapping zones and direction/occurrence evidence as annotations, never evidence erased from the record.

An arrival timestamp derived retrospectively by the old detector is retained for comparison, not treated as the raw encounter's exact instant. #38 demonstrates the distinction: its old passed-visit timestamp is at a95.13m fix although the earlier approach reached48.29m.

The fundamental control is **encounter invariance**: with identical raw observations and physical topology, toggling baseline versus repaired directed phase must produce byte-identical encounter records. Separate state ownership and immutable observation inputs must make that true by construction and by prefix tests.

## Fixed encounter diagnostic, proposed before running it

Use only the frozen September3–20 input and existing public marker topology. Enumerate nearby physical markers independently of the route sequence, preserving the assigned route as evidence. Limit evaluation joins to the declared route/vehicle contract; a nearby marker alone does not create a new service assignment.

For this first diagnostic, reuse75m as the observed-near threshold and125m as an exit hysteresis boundary; these come from the existing pin/rest geometry, not an arrival-error sweep. Entry requires an observed fix within75m. After entry, a fix beyond125m closes the observed spatial episode, retaining the last-inside/first-outside time interval; it does not prove a service departure. Fixes between the boundaries keep the episode open without manufacturing additional inside75m evidence. A gap>60s, unknown/changed identity, contention or route reassignment censors the relevant route/vehicle episode and retains the break. No completed departure is invented across it or at archive EOF. Record ambiguous one-fix approaches rather than silently deleting them.

Track exact-coordinate plateaus separately from the spatial episode. Report their observed duration and whether their coordinate is inside75m, in the75–125m band or outside. The existing15s standing convention may provide a descriptive `stationary_fix_supported` flag, with knownAt only when that duration has been observed. It is not a door-open or boarding label. Moving/short-repeat passes remain `possible_pass` evidence: coarse polls and the provider's deadband cannot establish that no brief boarding occurred. Absence of a stationary flag must not remove an earlier-pickup barrier.

Do not merge simultaneously nearby markers into one asserted service event, or count them as multiple proved boardings. Retain one spatial evidence episode with the candidate physical-marker identities it supports. Distinct stops, opposite-direction twins and repeated canonical occurrences remain explicit ambiguities.

## Joining phase and physical evidence

Join only information known at the query instant. Phase can annotate an encounter as consistent with one canonical occurrence, consistent with several, or near a marker outside the currently supported occurrence. Provider last-stop hints and raw displacement add supporting/contradictory evidence; neither is obeyed as service truth.

Examples: a near-LEPH encounter during supported18→19 travel is not automatically reassigned to earlier index14; an Elm/York encounter during2→3 is not automatically assigned the scheduled index5. Both remain physical records. Published list order, geometry, heading and the absence of a provider hint do not jointly prove that a rider could not board there. A stationary encounter can also be a traffic light or yard hold; stationary evidence does not prove service either.

For a fixed forecast's physical pickup marker, inspect the chronologically first potentially relevant physical encounter after the forecast, including open/ambiguous encounters. If an earlier encounter precedes the proposed canonical target, preserve an evaluation barrier unless an independently specified service rule resolves it. Do not skip it because the later arrival better matches a prediction, because it appears on the expected leg, or because the earlier record is merely `passed`. Route/provider discontinuities make the join unavailable; they do not erase the earlier evidence and permit a clean later join.

The32 known rows must stay unresolved under this protocol. A newly discovered earlier encounter may add barriers elsewhere. Report all additions to uncertainty rather than tuning radii or phase rules to recover a preferred cohort size. Any future rule resolving service requires separate review and evidence beyond proximity/order alone. The current archive need not be able to resolve every case.

## Fixed diagnostic and validation protocol for review

1. Freeze source/data/topology hashes, this specification, output schema, thresholds and episode identity rules before implementation. Keep the original phase arm, original physical visits,22m/s quality, forecast rows, waits, candidate families and whole-group fallback intact. No K fitting or ETA-error scoring in this diagnostic.
2. Implement the two records only inside a research harness. Stream the original observations in their original chronology with exact duplicate and simultaneous-name handling. Persist both their causal update streams and retrospective descriptive summaries; never substitute a final summary for evidence available at forecast time.
3. Hard controls: original baseline parity; encounter invariance under either phase arm; nontrivial future-prefix deletion for both records at the existing three cutoffs; no future-knownAt joins, EOF closures, implicit service assignments or discarded overlapping markers. Identity/route breaks and stale input must remain visible.
4. Fixtures include both flagged Elm/York encounters, all predeclared positive/negative geometry cases, a near-marker one-minute plateau, a moving pass, twins/repeated occurrences, cold start mid-episode, provider handoff, contention, missing fixes and an incomplete final encounter. Assert the32 barriers survive, including the moving #38 example, without asserting whether boarding actually occurred.
5. Run the full existing14 observed routes on hosted runners. Report by route, stop, day, vehicle and continuity episode: physical encounters, stationary-supported versus moving/ambiguous passes, exact phase-consistent/ambiguous/off-sequence joins, barriers, missingness and changed causal availability. These are diagnostics, not scores.
6. Audit every98 Blue Night stopped suppression and136 passed suppression against the new physical record, plus all63 paired timing changes. Include all three Purple timing changes and the Green added pass; keep every other route as a control. Do not select examples by model error or omit conflicting encounters. Existing deterministic first-example selection can aid presentation, but the full population ledger is mandatory.
7. Produce three separate outputs: directed phase comparison, invariant physical encounter ledger, and fixed-forecast barrier/join sensitivity. Preserve all32 current barriers and report any additional barriers and unresolved occurrence associations. A separate route13-only phase arm may then be specified for review, with all targets and encounter rules unchanged; this does not rewrite the completed all-route arm.

Acceptance here means the records are causal, independent and auditable, and that ambiguity is preserved. It does not mean the route has adequate training support, narrower reliable windows or a deployable detector. Rebuilding candidate origins/release latches, fitting, rider simulations and a genuinely untouched temporal validation remain separate reviewed work. No new dates are opened by this design.
