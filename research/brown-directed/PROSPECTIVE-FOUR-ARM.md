# Prospective Brown four-arm lock: September 23–29, 2026

Pinned on September 22 before these prospective observations exist. This is a specification and launch gate, not an implemented complete-feed adapter, permission to open outcomes, or production change. It is separate from the original-only reference protocol in `research/brown-handoffs/PROSPECTIVE.md`; that reference is not rewritten. Retain both Ks without choosing a winner.

The completed development result is immutable at `7aac285`, with scoring code `f840e7226e0abd495e0215c8a4f96b10be036c7b` and hosted artifact 35691411464. Its 19 union pickups on two reused dates do not establish prospective support. This lock does not combine the separate 45/90-minute or 15/<45-second clock experiments.

## Fixed arms and fields

The four candidate arms are `frozen_K8_original`, `frozen_K8_directed`, `rolling_K5_original`, and `rolling_K5_directed`. The fifth comparator is the complete actually served public response, not a retrospectively regenerated baseline. The directed arms use the exact existing `guard.ts` SHA256 `472c2e7a5babebcb3e2d31736aa4d3ddb013d11bb73ebd157d3daf65719719f6`, invoked only for Brown route 19. The original arms use the same pinned reducer/features with that adapter disabled. All code owners and hashes are in `PROSPECTIVE-FOUR-ARM.json`.

Guard conditions stay unchanged: same provider/route/name, strict new observations, gap<=60s, a current or retained directed leg, both projections<=75m, forward/displacement movement>8m, existing 25 m/s plus 16 m plausibility bound, repeated fixes retain only an existing valid certificate, endpoint-only replacement without endpoint rewind, and immediate certificate invalidation/recovery on ambiguity or failed evidence. Do not introduce a new distance, speed, clock, smoothing or release rule.

Each eligible Brown row uses the same hybrid after production rounding of the underlying fit:

```
eta  = served.eta
low  = min(served.low, candidate.low, served.eta)
high = max(served.eta, candidate.high)
```

Unsupported rows return the exact served row. Only low/high numeric cells may change. Preserve point, stopsAhead, estimated flag, departNow, lowFloor, row order, all wire bus fields/standing/index fields, raw bus fields, service/tables/pace/topology payload, served metadata, and all other routes. The guarded phase state is an internal causal feature sidecar; do not replace the public bus location, raw at-stop state or public track index with it.

Preserve each original row-aligned 50-point distribution byte-for-byte, including its absence. Do not fill, rescale, reorder, relabel or derive a new distribution from the hybrid bounds. The resulting envelope/old-distribution combination is a diagnostic hybrid, not a coherent new CDF, calibrated probability export, or production-readiness claim. Actual frontend consumers retain their pinned behavior, including any use of those unchanged probabilities. Record every candidate row's original-row key, reason, feature/model hashes and changed cells separately from the public wire metadata.

## Route and occurrence scope

Brown canonical sequence is `[145,147,4,42,98,121,115,172,47]`: Science Park Garage, Winchester/Sachem, 130 Prospect(S), College/Wall(S), Phelps Gate, Union(N), State St Station, Humphrey/Whitney, Divinity. Freeze waits 0 and 5. Wait 0's complete target group is indices 1–5; wait 5's is 6, 7, 8, 0. K8 sources are 1/6 for waits 0/5; K5 sources are 4/0. Preserve both whole groups, ending wait targets, adjacent source/wait stops and group boundaries. Do not restrict to the two development destinations or any favorable subset.

For every complete public response, account for EVERY original ETA row, including all Brown pickup and destination rows, unchanged rows, invalid/unavailable rows and all competitor routes. Complete output means full row accounting, not forced candidate eligibility or manufactured missing targets.

The original row's stop ID, stopsAhead, bus identity and route determine the original occurrence contract. Resolve its canonical target from its own stop ID and a proved unique/compatible occurrence; for Brown's unique stop IDs this is the unique index. Infer the original anchor only as `(targetIndex - originalStopsAhead) mod n` after validating the original hop range and occurrence. Never derive a target as `guardedCurrentIndex + oldStopsAhead`, change stopsAhead to fit the guard, or map a later lap to an earlier modulo occurrence. Candidate phase/index is used only for the already-pinned progress/release/eligibility tests.

At-stop, later-lap, repeated or otherwise ambiguous rows remain exact fallback unless their complete occurrence contract is proved compatible with the fixed model. In particular, do not admit stopsAhead>=n, negative/invalid hops, an intervening same-marker occurrence, or a provider/name ambiguity by changing the row's meaning. Preserve duplicates with `(response ID, original row ordinal, provider/bus/route, target occurrence)` identities; do not collapse them by stop ID. Missing destination rows remain missing; sampled prediction logs cannot supply them.

Evaluate support and countdown for every target in the applicable whole group, even when one target lacks a currently emitted public row. Any group support failure or fitted point countdown<=60s makes that source/group exact served fallback. Keep explicit fallback counts by bus/group/target/reason. A topology or Brown geometry incompatibility does not authorize remapping to a new route sequence; use exact fallback and a version-incompatibility stratum.

## Training and actual artifact availability

All parameters stay fixed: Brown path cap 90 min, circular 120 min Gaussian time-of-day weighting, weekday/weekend split, effective paths>=12, at least 3 material dates each carrying>=5% weight, empirical q10/q90, and production rounding. The wait map remains the original canonical one; do not rerun wait selection. Source, intermediate and target visits must be complete and physically/provider-continuous, with actual reducer-emission knownAt strictly before trainBefore; raw quality and bracketing fixes must also be strictly before that cutoff. Preserve the existing <=60 s gap and <=22 m/s training-quality checks, ambiguous-name/provider exclusions and no EOF completion.

Frozen K8 reuses only original canonical paths known before September 16 00:00 ET (`2026-09-16T04:00:00Z`, artifact 35684356219); no later data enters this fit. It requires a separately sealed, hashed export before use. Its validFrom is September 23 00:00 ET and validUntil is September 30 00:30 ET, strict at the upper endpoint.

Rolling K5 for calendar day D uses trainBefore=D−1 at 00:00 ET, preserving a full prior-calendar-day embargo. Fit each next-day artifact on the preceding day after the required archive export is available; there is normally a full day of slack. The exported model must be actually built and sealed before any response uses it. Record true builtAt; do not backdate an artifact generated after a forecast or infer that an unavailable artifact would have existed.

| Rolling forecast day ET | trainBefore, strict ET | validFrom ET | validUntil ET, exclusive |
|---|---|---|---|
| Sep23 |Sep22 00:00|Sep23 00:00|Sep24 00:00|
| Sep24 |Sep23 00:00|Sep24 00:00|Sep25 00:00|
| Sep25 |Sep24 00:00|Sep25 00:00|Sep26 00:00|
| Sep26 |Sep25 00:00|Sep26 00:00|Sep27 00:00|
| Sep27 |Sep26 00:00|Sep27 00:00|Sep28 00:00|
| Sep28 |Sep27 00:00|Sep28 00:00|Sep29 00:00|
| Sep29 |Sep28 00:00|Sep29 00:00|Sep30 00:00|
| Sep30 adjacent context only |Sep29 00:00|Sep30 00:00|Sep30 00:30|

Eligibility additionally requires `builtAt <= server_eta.at`, `validFrom <= server_eta.at < validUntil`, exact parameter/topology/source manifests, and known training inputs. Missing, late, invalid or expired artifacts produce exact served fallback with that explicit reason; do not extend yesterday's rolling artifact or retrospectively activate today's export. September 30's predeclared context model exists only to complete September 29 scenarios and adjacent observations, not to add a new evaluation date or plan starts.

Each model manifest contains: immutable arm/version and source hashes; trainBefore; actual builtAt; validFrom/validUntil; raw and causal-visit prefix manifests; physical source/target path identities and knownAt; topology/wait map; fixed parameter hash; support exclusions; and physical/path/fit parity evidence. The sealed artifact includes the immutable admitted path pools and the pinned fit algorithm; the original causal source-departure clock still determines its time-of-day query. A query cannot add newly completed paths to that artifact. The two phase variants share the same original fit after independently checking their physical training-path/fit parity. A discrepancy halts the guarded comparison before scoring; do not silently replace fits, change labels, or outcome-select a subset.

## Causal raw, public-response and frontend clocks

Reconstruct raw observations chronologically through the production reducers pinned by the development code, with actual poll/reducer emission knownAt, source<=45min, observation age<=15s and 10 min continuous warmup. Provider/route/name ambiguity and raw gaps clear/invalidate history under the already-tested rules. Source origins cannot be populated retrospectively from finalized visits, and a released source occurrence cannot be revived by a later phase return. Preserve the original pinned reducers rather than silently rebasing them onto a later production release.

A captured public response is the immutable baseline payload plus its exact HTTP body/hash and request/receipt envelope. The candidate computation is at its original `server_eta.at`, not receipt time or a reconstructed later poll. Consume only original raw fixes and emitted source knowledge available by that server time, and only a model actually sealed by then. A newer raw fix present in the public bus list or later archive cannot improve the older ETA snapshot's candidate readiness. Preserve source and model temporal cutoffs even when several captured responses repeat the same ETA snapshot.

The 15 s public recorder is an observer cadence, not synthetic 15 s reducer input and not a claim about a 5 s rider browser. Use separately archived full raw observations, including bus_id/provider and actual collected_at, to preserve reducer departure-confirmation timing. Public snapshots alone cannot reconstruct the original approximately 5 s knownAt evidence. Retain raw/public clock alignment and missing-prefix provenance; no interpolation or future bracketing is permitted. If the required causal raw prefix or provider alignment is unavailable, candidate rows fall back exactly and remain counted as unavailable support.

Attach the complete original/candidate wire to the SAME bus-array instance used by the actual planner and live arrival helpers. The effective browser forecast clock is `receivedAt - (servedAt - at)`, exactly as `attachServerEta` does. Frontend stale handling stays strict<45s. One-second reminder/rendering ticks age the last attached forecast only; they do not recompute the candidate model, advance warmup, refresh GPS freshness, borrow a later response or create a new release event. Process receipt/failure events in recorded order. A response received after a decision is future information even when its server forecast time is earlier.

## Required hosted parity gates

Before launch, use the already opened development fixtures and synthetic boundary cases to verify the adapter. No local replay, fitting, build or tests are authorized. The following gates retain the completed experiment's definitions:

- Reproduce the original development controls exactly. The complete-response adapter must additionally preserve every served row's ordinal, stop occurrence, point, hop count, other fields and aligned distribution; all unsupported rows and all non-Brown output are exact fallback. Test destination rows, duplicates, later laps, invalid hops, incompatible versions and whole-group support/countdown failures.
- Require exact Brown physical arrival/departure/actual-knownAt multisets and physical source-origin ledgers between reducers. A physical event has a nonnull pin, arrival or departure; do not omit unresolved pinned events. Keep anchor-only changes and truly unpinned bookkeeping exclusions in separate ledgers. All non-Brown reducer emissions and features remain identical. Causal Brown phase/release differences remain explicit.
- Require original and guarded physical training-path identities, durations, support and numerical fit parity at every training cutoff. Compare all fixed target groups, including unsupported queries. Keep original labels and served baseline immutable; do not construct new labels from guarded phases.
- Delete future raw suffixes at fixed training cutoffs and response clocks and require identical earlier emissions, actual knownAt, origins, release latches and forecasts. Include source departure versus confirmation, last-wait departure, phase return, route/provider/name ambiguity, restart and missing-prefix cases. Never recreate an expired or released source occurrence from a finalized future visit.
- Exercise the unchanged inclusive 15-second observation, inclusive 45-minute source, inclusive 90-minute training-path and strict 45-second frontend boundaries, plus 10-minute warmup, strict training-knownAt cutoff, model builtAt/validFrom and exclusive validUntil. Verify that one-second UI aging creates no new model or tracker evidence.

Apply the same mechanical physical/path/source invariants to sealed prospective inputs before any candidate outcome scores are attached. A discrepancy halts the guarded comparison and remains a recorded scientific gate failure; it is not a reason to relabel, narrow the cohort or turn the failed interval into an ordinary fallback. Missing causal inputs or an unavailable model remain the separately defined exact-fallback states. The gate process may compare sealed reducer ledgers, but no prospective performance results or case outcomes are opened to select an arm or repair this protocol.

## Whole-app selection lock and outcome embargo

Use the separately pinned all-line synthetic selection protocol v1.1 at `6dfbe4f86e60873663784e129743dbabbe1122e6`, document SHA256 `4507ff7e1d89bf188aa1273cd2c7a1fb6fcd7ed02ac0dfa62501264e3f23e13c`, with the 42 fixed O/D geometries, all 14 competing routes, every half-hour start September 23–29 and 45 min horizon. Its scenario SHA256 is `265ecc5b1bf189f995f8272805b658dc28c63f991e7a724a54e2e8e1b4699af9`. Late September 29 starts receive context through September 30 00:15 ET, with capture ending 00:30 ET. No new starts or scoring date are added.

Preserve its stationary profile and initial-choice immediate-response walking proxy, actual plan/refresh triggers, bus selection, ranking/visibility hysteresis, pinned frontend bundle per episode and all unavailable-version states. Heads-up changes reminder state only; only leave-now starts walking. Null reminder input permanently disarms without retry; a valid walk<60s emits no ping and does not teleport the rider. Candidate arms receive the same complete inputs with independent scenario state; route/bus/walking divergences remain explicit. Fixed-bus action parity is not full-app recommendation invariance.

No prospective outcome labels or model-performance scores may be opened until the complete causal pipeline, model manifests, occurrence mapping and actual frontend adapter have been reviewed and passed hosted parity tests. Forecasts/features/decisions must be sealed before outcome attachment. Record original physical labels independently; unresolved/provider-gap/repeated-occurrence barriers remain censored, never replaced with invented arrival+60s departures or candidate labels. This document does not itself define a new whole-app boarding-safety outcome adapter; the separate selection protocol currently authorizes decision/selection diagnostics only.

The prior numerical and fresh-support gates remain: common-cohort width gain>=60s, MAE degradation<=20s, coverage>=80% and loss<=2points, no new early>60s visits, early-rate increase<=1point, no new false-now or point/bound ordering reversals>30s, no added paired avoidable action misses, satisfactory evidence-specific handoff review, and at least 30 pickups, 12 source journeys and 3 unopened service dates. Preserve full-route denominators, all-arm and original-lead common unions, raw/printed aging, target/date/source support, waiting cost, censoring and all phase/freshness/expiry/real-departure transitions. Observed departures may justify uncertainty reduction; a large jump is reviewed with its actual causal evidence, not automatically smoothed or failed.

## Complete-input gaps to close before implementation or launch

1. **All-target adapter missing:** current development features/scoring use sampled predictions_log rows. Implement a response-row-preserving adapter for every complete served row and every Brown destination, with strict occurrence proof and whole-group fallback. It must not reconstruct missing rows from sampled logs.
2. **Raw/public alignment not yet demonstrated:** the public recorder preserves full 15 s fleet/ETA/tables/health/build responses, but these do not replace the full raw/provider stream or prove its availability at each ETA clock. Supply immutable raw-prefix manifests, actual collected/emission clocks, gap accounting, restart context and tested server/public alignment before candidate readiness can be trusted.
3. **Prospective model exports not built:** this lock pins the formulas and deadlines, not future model values or availability. Implement/seal frozen and daily artifacts with real builtAt/expiry, strict knowledge embargo and parity. A late export cannot repair earlier fallbacks.
4. **Actual frontend adapter/version parity pending:** complete bodies and HTML/assets/health brackets are input evidence, not proof that a hand-written selector matches the served frontend. Preserve captured bundle/source mapping and version ambiguities; use actual planner/update/reminder/ranking behavior with hosted parity, including distributions and destination bounds. Do not assume a missing/dynamic asset equals repository source.
5. **Outcome adapter not approved:** preserving full responses enables selection diagnostics; it does not establish physical boarding labels or eliminate the prior earlier-encounter barriers. A separate reviewed causal outcome adapter is required before prospective accuracy or missed-shuttle claims.

This lock opens no prospective body/outcome, runs no fit/replay and schedules no scoring. Root owns capture and final pipeline/launch review. Keep missing data, fit failures and incompatible releases as explicit evidence; do not change dates, Ks, constants, rows or behavior after looking at prospective outcomes.
