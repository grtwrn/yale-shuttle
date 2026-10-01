# Validity of the selected regression holds

**Retain all four source holds.** None has positive evidence of a truncated, censored, or falsely short source visit. Three have continuous raw GPS supporting their recorded clocks and a connected stopped arrival at Division. Union 48550 has consistent complete event/leg records but no retained raw GPS; keep it with that lower evidence grade. These are deliberately selected difficult cases, so this audit cannot estimate an overall error rate or determine whether the candidate's aggregate tradeoff is acceptable.

Reproduce with `python3 red-window-data/regression-validity-review.py`. The JSON contains the exact source rows, nearby modern/legacy visits, incoming/outgoing legs, compressed GPS runs, final movement fixes, causal wire state, target records, and relevant prediction checkpoints. The script opens SQLite read-only, verifies timestamp/identity/clock consistency, and writes analysis artifacts only.

| Source visit | Bus, date (Eastern) | Pin → final resting endpoint | Pin-to-departure | Evidence and decision |
|---|---|---|---:|---|
| 64318 | #309, Sep 17 | 08:56:08.217 → 08:58:48.303 | 160.1s | Genuine short hold with shuffles and a complete Division arrival. Retain. |
| 58224 | #309, Sep 16 | 10:00:42.326 → 10:03:12.398 | 150.1s | Genuine short hold, including 5.2s roll-in before the first resting plateau. Retain. |
| 65347 | #309, Sep 17 | 10:50:52.856 → 10:59:12.981 | 500.1s | Real long wait with a 385s central GPS plateau, followed by a final staging plateau. Retain. |
| 48550 | #310, Sep 14 | 15:42:11.026 → 15:59:11.182 | 1020.2s | Complete long hold and onward chain; raw GPS unavailable. Retain with an event-only evidence flag. |

## The two short Winchester regressions are real

**64318:** the bus freezes at successively different positions near Winchester, including 30.1s about 5.3m from the stop and a final 45.2s plateau about 44.7m away. Its final unchanged-coordinate poll is 08:58:48.303; the first onward coordinate change arrives 4.789s later. Subsequent changes continue toward the next stop, and the recorded 10.046s candidate-confirmation interval ends at 08:59:03.138, exactly the legacy departure. There is one nearby legacy visit, no second nearby modern visit, one incoming leg, and one unchanged wire pin origin. No restart/truncation signature appears.

Its exact Division chain is **legs 59630 → 59638 → 59642**, ending in stopped target **64338** at 09:00:08.106. GPS comes within 4.0m of Division; the target then has a 50.0s stopped visit. Travel after the source departure is 79.803s. At the first fresh checkpoint at least 120s after pin, the shadow predicts 284s against 115s truth, with a 163s lower bound. This is a valid early-arrival miss by the shadow, not an erroneous short label.

**58224:** first resting coordinates occur at 10:00:47.521, 5.195s after pin. The bus has a 29.8s initial plateau, a 15.0s near-stop plateau, and a final 40.1s plateau about 43.7m from Winchester. The final movement begins with the fix at 10:03:17.296, 4.898s after the recorded endpoint. Confirmation occurs at 10:03:32.344, again exactly the sole legacy departure. Modern `stand_sec=144.877` and pin-to-departure `150.072` are different intended clocks, not inconsistent records.

Its exact Division chain is **53858 → 53866 → 53876**, ending in stopped target **58260**, 94.898s after departure; GPS comes within 12.7m of the target. At the standing +120s checkpoint, shadow point/lower bound are 276/126s against 120s truth. The prior Winchester departure was 09:13:46.957, whereas this one is 10:03:12.398. The bus is not obliged to preserve a delayed previous-hour phase. A rigid hourly-slot predictor can be wrong on a valid operational variation.

## Report 115 is a real long wait and a real later regression

**65347:** the main plateau lasts **10:51:42.828–10:58:07.861 (385.0s)** about 7.0m from Winchester. A subsequent maneuver ends in another **35.1s** frozen plateau at approximately the same final staging position as the two short cases. The first final movement fix arrives at 10:59:17.956, 4.975s after the recorded departure. The final 15.192s confirmation interval ends at 10:59:33.148, matching the sole legacy departure. The original pin remains intact through all these shuffles.

The exact Division chain is **60572 → 60578 → 60581**, ending in stopped target **65364**, 79.916s after departure; GPS comes within 15.9m. At standing +60s, the shadow improves the point from production-model replay's 159s to 598s against 515s truth. Near the end it regresses: at the final plateau endpoint, shadow predicts 221s against 80s truth, compared with production's 108s. Both facts count. The valid long hold does not excuse the later excessive prediction, and the later error does not invalidate the earlier improvement.

Across these three source-to-target GPS windows, maximum poll gaps are **5.4, 5.2, and 6.8s**. Each uses one bus ID with no duplicate timestamps. Maximum observed step speeds are **14.8, 14.0, and 16.3m/s**; these quantized GPS steps provide no teleport/impossible-travel evidence. During the source holds there are brief excursions to roughly **90–92m** before returning to a resting plateau. Such a maneuver can flip a hard 75m gate without being a completed departure. The source hold includes shuffles; it does not assert that the vehicle is physically motionless for its entire duration.

## The long Union hold is not established measurement error

**48550:** modern pin/arrival is 15:42:11.026 and the final resting endpoint is 15:59:11.182, giving 1020.156s. The sole legacy arrival spans 15:41:16.096–16:00:16.252 (1140.156s). Modern and legacy use different arrival/departure definitions; a 55s earlier legacy entry and 65s later legacy exit account for the duration difference. They derive from the same feed, so their agreement is consistency evidence, not an independent physical measurement.

There is one exact incoming leg **44540**, a complete next leg **44626**, and **17 consecutive observed one-hop legs** through the correct route sequence to stopped Division target **48749** (final leg **44807**). No source or intermediate `how='gap'`, unresolved departure, or skipped target is required. The source reports 197 resting polls, two shuffles, three final movement steps, and `how='clock'`; this supports a completed visit but does not prove a door-close time.

The previous same-bus Union departure is **14:56:36.151** (visit 48205); an intervening Winchester departure occurs at 15:22:30.957. The current Union departure is 62m35s after the previous one. An early return followed by a long hold is compatible with the observed near-hourly cycle. This is an explanation consistent with the records, not proof of a driver's dispatch instruction.

I also streamed **`~/shuttle-archive/2026-09-14/raw_positions.jsonl.gz`** rather than relying on the database alone. It has 16,198 rows for routes 10/16/17/14/13, **zero Red rows**. No matching GPS can be recovered from that archive. Therefore retain the hold for the event-based component analysis, report the evidence limitation, and optionally show a prespecified sensitivity restricted to raw-supported cases. Do not label it corrupt or remove it because it produces a large residual or a late-survival quantile jump.

## What these labels can and cannot support

1. **Do not score a retrospective endpoint as an observed departure signal.** For all three GPS-supported cases, the departure timestamp is still the last frozen coordinate. Onward movement first becomes visible about five seconds later and confirmation follows roughly 15–20s after the endpoint. `first_moved_at` records an earlier shuffle; using it as the final departure's availability time would leak or mislabel the event. Existing detector code makes this distinction in `src/collector/departure.ts` (reference-point comments and candidate creation/confirmation).
2. **Do not equate `stationary=true` with no physical movement.** The wire pin persists through the first onward fixes, and it also survives genuine earlier shuffles. A useful integrated candidate should use the causal movement/standing belief and evolving departure evidence. A switch based solely on the pin flag or first fresh coordinate is not justified by this audit.
3. **Keep endpoint-specific exclusions separate from source validity.** Rosenkranz targets **58296** and **65406** are classified **passed**, despite continuous physical arrival evidence. They can support a physical pass-time endpoint, not verified boarding. For **64318** and **48550**, the strict chain toward Rosenkranz fails after stop 104; do not bridge it or substitute a later lap. All four source holds and their Division chains remain valid for the corresponding analysis.
4. **Retain genuinely difficult outcomes when assessing the model.** These cases are selected regressions, not four independent random trials; three are the same named bus. Their frequency and aggregate rider impact require the complete date-blocked replay and the frozen later holdout. A small number of worse valid tails can be an acceptable tradeoff if the full evaluation supports it. Excluding them after seeing errors would bias that decision.

**Decision:** no source-record quarantine is justified for these four. The concrete correction is to preserve causal clock/state semantics and truthful endpoint support in validation. This audit changes neither production nor application code.
