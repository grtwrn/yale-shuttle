# Directed-leg reconstruction: evidence and limits

The frozen guard prevents the two diagnosed Blue Night phase errors and preserves the predeclared actual reverse/off-route recoveries. It is not ready to replace physical pickup measurements: it suppresses real close-marker observations, including stopped ones. Those encounters must remain visible independently of the canonical route phase.

The [specification was frozen at2378c5a](https://github.com/grtwrn/yale-shuttle/blob/2378c5a/research/directed-leg-protection/SPEC.md). The final research implementation is c80ab5f, validated by [hosted run35687909547](https://github.com/grtwrn/yale-shuttle/actions/runs/35687909547). The independent artifact/raw-observation follow-up is fa4a9e2, [hosted run35688487783](https://github.com/grtwrn/yale-shuttle/actions/runs/35688487783). Its original mechanism report is [0f542b1](https://github.com/grtwrn/yale-shuttle/blob/0f542b1/research/blue-night-hop-audit/FINDINGS.md).

All server/web production files remain byte-identical to the comparator. No deployment, model fit, arrival-error scoring, candidate/quality threshold change or September21 outcome reading occurred. All computation ran on hosted runners; local inspection read the resulting diagnostic artifacts.

## Validation

*18 focused fixtures passed, including the two false-anchor sequences, actual16→15/16→9/6→3 recoveries, endpoint phase memory, repeated/older polls, provider/route changes, observation gaps, contended identity and genuine skipped-stop recovery.
*178 existing detector, departure, network and filter tests passed.
*1,487,970 original observations produced51,581 baseline visits whose complete semantic signatures match the canonical artifact, and38,047 fixed forecast rows reproduce every original accepted/missing label exactly.
*Three fresh replays with physically deleted future suffixes preserve every earlier protected visit exactly. The September16/19 cutoffs and an independent mid-capture boundary are nontrivial checks; no EOF closures or historical seeds enter.
*Original data/artifact hashes and the production-source comparison pass. The old22m/s quality rule is unchanged. The geometric guard retains its separately justified existing25m/s identity-recovery plausibility bound; the two rules were not combined or relaxed.
*51,017 visits result in the protected arm, with17,514 guarded polls. Exact anchor-key collisions are retained as multisets, not overwritten. Seven baseline collision groups and their shifted counterpart produce eight comparison groups; they are repeated emissions under the same provider/anchor identity, not evidence of seven contended buses.

## Blue Night fixed-forecast cohort

The unchanged labeler accepts631 original rows and1536 protected rows:905 additions, zero removals and zero changes to previously accepted labels. Of the1044 original forward-occurrence exclusions,902 become accepted,10 become beyond45minutes,2 become pickup-hop disagreements and130 remain excluded. Three old pickup-hop disagreements also become accepted.

**Thirty-two additions have an earlier original physical pickup and remain evaluation barriers.** The separate barrier sensitivity contains873 additions without this identified conflict and1504 accepted Blue Night rows in total. This is a reconstruction sensitivity result on repeatedly reused development dates, not905 or873 verified prediction improvements. Both the original all-route result and every barrier row remain preserved.

The32 rows concern exactly two earlier Elm/York(stop53,index5) visits:

| Bus/provider | Earlier arrival UTC | Earlier raw evidence | Later selected arrival | Delay | Forecast rows |
|---|---|---|---|---:|---:|
|#38/66519|September18 03:45:39.616|3 polls within75m; closest48.29m; no repeated fix within75m; original visit `passed`|03:48:51.911|192.295s|1|
|#45/66597|September20 02:43:39.085|13 polls at an identical coordinate for60.007s,53.56m from the marker;16 polls within75m; original visit `stopped`|02:48:24.078|284.993s|31|

Both windows maintain route13 and their provider IDs. Maximum whole-window gaps are7.428s and5.194s. Provider hints proceed A&A(5)→Wall/York(67)→Gym(96)→Elm/York(53), supporting the listed travel order. They do not prove that boarding was impossible at the earlier close-marker encounter. #38's original passed-visit timestamp falls on a later95.13m fix despite the earlier48.29m approach; that further limits treating the old time as precise ground truth, but does not erase the encounter. #45's one-minute stationary coordinate is especially material. Geometry and heading cannot resolve doors, direction-of-service or boarding availability. Retain both barriers pending independent evidence or an explicit physical-encounter labeling contract.

## Physical changes, separated from anchor bookkeeping

The follow-up first matches exact physical signatures as multisets (vehicle/provider, route, physical stop, canonical occurrence, arrival/departure and outcome), ignoring anchor/knownAt bookkeeping. Remaining arrived visits are paired only when their observation intervals overlap uniquely in both directions under the same identity. There are no ambiguous overlaps in this dataset. Every unmatched record and paired change is retained in `physical-visit-differences.jsonl.gz`.

| Route | Suppressed arrived stopped / passed | New arrived visits | Paired physical changes | Suppressed / new anchors with no arrival |
|---|---:|---:|---:|---:|
|Blue Night|98 /136|0|63|14 /6|
|Purple|0 /0|0|3|160 /213|
|Green|0 /0|1 passed|0|0 /0|
|Gold|0 /0|0|0|0 /2|
|Orange East|0 /0|0|0|218 /0|
|Grocery Ham|0 /0|0|0|57 /18|
|Brown|0 /0|0|0|121 /0|

Red, Blue Day, Blue Weekend, Blue West, Orange Day, Orange Night and Pink have no changes at all. Red specifically has zero guarded polls, all5686 visits unchanged, and all7025 forecast rows/labels/reasons unchanged. Its recovery and clock behavior in this capture is preserved; the experiment does not alter the client ring's independent recovery rules.

Blue Night's suppressed arrived records are Elm/York51 stopped+41 passed and LEPH47 stopped+95 passed. These are canonical occurrence assignments the guard rejects, but they remain observed physical encounters. A route13-only scope does not solve this distinction. Its63 paired physical arrivals move9.879–54.924s earlier;27 departures and7 outcomes change. Sparse logged forecasts do not cover every such visit.

Purple's three physical changes are all LEPH(stop72,index15):

| Bus | Arrival shift | Departure shift | Outcome |
|---|---:|---:|---|
|#329|−55.191s|0|stopped→stopped|
|#122|−35.001s|−10.005s|passed→stopped|
|#300|−20.050s|−9.987s|passed→passed|

Green adds one passed visit at stop84 for#331/provider66161, closest73.15m, with zero recorded stand. Other non-Blue differences are anchors without an arrived physical visit or bookkeeping changes; they can still affect future history, phase and calibration and are not automatically harmless. No non-Blue logged accepted label changes, but those sparse logs are not a census of these altered training/physical events.

## Consequence

Keep the original all-route experiment, comparator and whole-group fallback intact. A separately frozen route13-only arm is assessable because it matches the original Blue Night research question; do not narrow it by deleting troublesome arrival stops or by the scores of individual cases. The present adapter is evidence for a causal route-phase repair, not permission to replace the physical encounter ledger.

Before candidate evaluation, separate directed canonical phase from raw close-marker/rest encounters, preserve earlier potential pickups as evaluation barriers, and regenerate causal origins, phase, release latches and knownAt under the new reconstruction. Compare every candidate and the deployed comparator on the same explicitly declared cohort, with additions/removals/changed physical times reported. Keep the highway-quality experiment separate and retain the original22m/s rule here. Any later temporal validation must use an actually untouched period; September17–20 and the inspected September21 examples do not supply that claim. No promotion follows from these diagnostics.

Artifacts: `directed-leg-protection` from35687909547 contains complete baseline/protected streams, guard decisions, original/changed labels, prefixes and all examples. `directed-leg-physical-diagnostics` from35688487783 contains both raw-window summaries, all32 barrier rows, the physical comparison ledger and per-route counts. Each is retained for90days by its hosted workflow.
