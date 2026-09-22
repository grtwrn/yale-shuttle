# Blue Night forward-hop exclusion evidence

The dominant signatures are false canonical reanchors while buses follow the published path. They are not evidence that buses skipped16–18 stops. Whole-group fallback is appropriate under the unchanged reconstruction; this audit does not qualify K10 or remove difficult targets.

Evidence: hosted [run35686892045](https://github.com/grtwrn/yale-shuttle/actions/runs/35686892045), diagnostic commit4624407. Artifact `blue-night-hop-audit` retains `REPORT.md`, `summary.json`, `geometry.json`, all failure rows, predeclared examples and reducer traces. Baseline controls reproduce1990 Blue Night labels, every frozen K10 path and3288 emitted Blue Night visit signatures exactly. Inputs stop at September20 ET; no September21 outcomes were opened. The original quality, labels, paths, candidates and production files are unchanged.

## Population, not just examples

| Population | Index transition | Modulo hop | Rows/source paths | Distinct next visits |
|---|---|---:|---:|---:|
| Rejected labels |18→14|16|733|21|
| Rejected labels |5→3|18|232|7|
| Rejected labels |18→15|17|48|11|
| Rejected labels |18→17|19|19|3|
| Rejected labels |17→14|17|7|4|
| Rejected labels |19→15|16|5|2|
| Frozen K10 paths |18→14|16|156|83|
| Frozen K10 paths |16→15|19|8|4|
| Frozen K10 paths |16→9|13|2|1|
| Frozen K10 paths |6→3|17|2|2|
| Frozen K10 paths |5→3|18|1|1|

Label rows are repeated forecast snapshots, not independent arrivals; next-visit identities can overlap between transition classes. The two dominant signatures account for965/1044 label exclusions. Detailed examples were chosen before inspection: chronologically first failure for each population/index transition, retaining every transition class. They establish mechanisms, not a claim that every row was manually verified to share that mechanism.

The156 frozen18→14 failures comprise83 source paths for wait0 and73 for wait16;153 pass original source-to-failure quality,3 fail its22m/s speed check. The remaining13 first-failure paths pass that quality check. The dominant signature spans12 training dates and12 bus names. For wait16, target17 has67 paths on12dates and target18 has70 on12dates, while targets19 and0 have0: each stops80 source paths at a large hop,4 at the duration cap and10 at track exhaustion. This is the actual cause of the unsupported whole group.

## Published path and exact causal evidence

Published and serialized runtime route13 have the same20 unique physical stop IDs and identical polyline. No repeated-stop renumbering or Blue Night topology repair occurred. Every ordered leg traces without a bridged chord. The snapshot is not a historical day-by-day topology log, so it cannot exclude an unrecorded schedule change.

Relevant order:2 A&A→3 Wall/York→4 Payne Whitney→5 Elm/York, and14 LEPH→15 Church Street South→16 Union Station→17 81George→18 Church/George→19 Congress/Cedar→0 333Cedar.

The691.85m published18→19 leg passes12.10m from LEPH's marker, despite LEPH's sole listed occurrence being14. The428.93m published2→3 leg passes50.18m from Elm/York's marker, before its listed occurrence5. Physical proximity on these paths does not itself establish a scheduled boarding visit.

* Earliest training18→14: #40/provider65937, September3 22:28:39.565Z. The fix advances35.32m along the intended18→19 leg in5.071s and is7.20m from it. Global LEPH is105.65m away, while the best forward stop is282.84m away; the150m slack comparison abandons the correct branch. The bus subsequently reaches19 and0. All observations remain on route13/provider65937; maximum gap across the example5.163s, maximum speed13.61m/s.
* Earliest label18→14: #44/provider66524, September18 01:43:53.516Z (September17 ET). The fix is6.73m from18→19 and advances29.84m along it in4.998s. Motion aligns with that leg (cosine0.992) and opposes14→15 (−0.994). Provider last-stop evidence stays35 before advancing43, not72. This is legitimate downstream travel near old LEPH, not backwards travel to the old occurrence.
* Earliest training5→3: #54/provider66296, September14 03:45:27.171Z. The original error starts2→5: a point2.43m from2→3 moves35.26m forward, while global Elm/York beats the best forward marker by154.66m. At03:46:07.179Z it reanchors5→3, then proceeds3→4→5. Earliest label example #44/provider66575 on September19 00:05:42.084Z repeats the same mechanism:2.18m from2→3,33.59m forward in4.881s; the putative leg5 motion is essentially perpendicular. Provider stop hints support5(A&A)→67(Wall)→96(Gym)→53(Elm).

A single tangent/heading test is insufficient at a corner: the earliest18→14 training fix crosses a turn, so its displacement is nearly perpendicular to the segment it lands on while directed polyline progress is clearly forward. Raw sequential projections and continuity supply the causal evidence.

## Distinct exclusions that must remain visible

All48 label18→15, all19 label18→17 and all5 label19→15 rows are first-step failures with a logged-hop anchor different from reconstructed phase. Their earliest traces show ordinary13→14→15 or16→17 progression. Unique physical targets intentionally infer their anchor from logged stops-ahead without requiring phase agreement (`canonical-windows/occurrence.ts`); changing this would be a separate cohort/feature change. Another12 first-step disagreements occur within18→14 and17→14. One earliest17→14 example simply has the physical18 arrival three seconds before its forecast, then encounters the same real detector18→14 reanchor. No blanket large-hop relaxation resolves these distinctions.

The rare training cases contain materially different motion despite stable route/provider IDs and dense GPS:

*16→15, #40/provider66302, September14 03:43:32.166Z: the point is8.60m from15→16 and moves backwards along it (cosine−0.999,32.55m backwards); the expected16→17 leg is228.90m away. It later goes15→14→19. This supports actual observed reverse/shortcut travel, not the dominant geometry illusion; scheduled service legitimacy is unknown.
*16→9, #54/provider66296, September14 03:27:22.102Z: an intermediate17 anchor never reaches the stop, then reanchors9; the closest published leg is539.85m away at the jump. Raw observations remain dense (maximum6.242s gap). This is an observed off-line excursion or route-assignment mismatch, not missing GPS; do not reconstruct the omitted stops.
*6→3, #51/provider66274, September13 02:48:43.322Z: the old6→7 leg is230.94m away while the bus has returned near the Wall/York area. Dense same-provider data supports an observed deviation, not a16/17-hop literal traversal. Its service interpretation remains unresolved.

## Consequence and separate experiment

Keep current whole-group fallback and the>5 guard. Choosing only targets17/18 because their observed path counts look favorable would be post hoc. A future Union-Station-to-Church/George corridor could be defined from service geometry before separate validation, but this audit does not qualify it. It still needs every target, causal source availability, expiry/transition behavior and a new temporal evaluation.

The independently motivated repair is an occurrence invariant: continuous forward movement on a directed downstream leg must not be reassigned to another canonical occurrence merely because its marker is nearby. Its leg memory must be distinct from the nearest endpoint; otherwise preventing2→5 by choosing3 permits3→5 at the next poll. Preserve actual reverse/off-route/identity/missing-data recovery and retain removed physical-pass evidence explicitly.

A separate research experiment was frozen before replay in [spec2378c5a](https://github.com/grtwrn/yale-shuttle/blob/2378c5a/research/directed-leg-protection/SPEC.md), on branch `research/directed-leg-protection-2026-09-22`. It uses a research adapter around unchanged production reducers, existing geometric tolerances, original22m/s quality, focused positive and negative fixtures, full all-route baseline parity, causal-prefix deletion and explicit fixed-forecast cohort changes. No model-error tuning or deployment is authorized by the audit's results. Red's identity/route recovery, first-sight stationary seeds, client ring reacquisition and lead release remain separate regression obligations.
