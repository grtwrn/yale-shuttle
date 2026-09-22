# Brown source-occurrence findings and narrow guard options

Hosted diagnostic[35688746325](https://github.com/grtwrn/yale-shuttle/actions/runs/35688746325)
at04295df reproduced all2,032 prior Brown four-policy feature rows. Eight
future-prefix deletion checks passed. The4,076 retained trace frames cover the
three pinned examples under45/90min source clocks. Prior forecasts, labels,
scores and raw hashes are unchanged. No fitting, scoring or new dates occurred.

## The named case is not proof of a wrong physical lap

Brown#304/provider66529 on September18 has704 observed polls in the pinned
09:32–10:31 interval, maximum gap20.556s, route19 throughout and no contention.
Its source6 State St visit is physical: closest54.40m, arrival09:32:12.238,
departure09:34:02.251, actually emitted/known at09:34:22.240.

The apparent subsequent source return is entirely different:

| Causal poll, ET | Evidence |
|---|---|
| 09:37:07.337 | Nearest anchor jumps6→3 while bus travels from State toward Humphrey. |
| 09:39:37.291 | Remote College/Wall3 pass closes, closest454.60m, never pinned, null arrival/departure; phase temporarily becomes3drive. |
| 10:12:27.715 | Nearest anchor changes4→6 on the Phelps→Union approach; State6 is516.43m away. No physical State visit occurs. |
| 10:14:37.953 | Anchor returns6→5. The unpinned State6 pass emits with null arrival AND departure and closest516.43m. Reducer transit becomes fromIndex6, dated to closest approach10:12:27.715. |
| 10:17:09.876 | Actual Union5 pin,51.39m away. |
| 10:17:14.860 | A repeated fix establishes Union5 hold; phase changes6drive→5hold. Source09:34 is unchanged. |
| 10:30:10.871 | Actual Union visit emits departure10:29:50.849; the90min source release latch becomes true and stays true. |

The valid physical sequence is source6→7→8→0→1→2→3→4→wait5. No additional
completed physical source6 visit or intervening Union departure was observed.
The old source is consistent with the intended pre-Union occurrence. There is
no missing completed source/wait emission to invent or recover.

The responsible reducer contract is explicit in
services/shuttle-v2/src/collector/departure.ts:700–707: an unpinned anchor pass
emits null arrival/departure but starts Transit.fromIndex at that anchor using
its closestAt for leg bookkeeping. This is valid bookkeeping for that reducer,
but canonical-windows/replay.ts:70–72 treats that transit index as checkpoint
phase without preserving whether its departure was physical or synthetic leg
bookkeeping. The classifier's 'drive from source6' therefore overstates evidence.

For K=n−1=8, modulo distance can only be0..8; `distance(source,index)>K` cannot
release anything. That algebraic limitation can conceal occurrence ambiguity,
but does not prove this origin was from the wrong lap. Nor should a cumulative
nearest/phase counter replace it: the remote6→3→7 excursion adds a spurious full
loop by09:39, long BEFORE reaching Union. Summing those indices would invalidate
the correct source and create a fabricated lap. A true missed-wait/missed-source
cycle remains a theoretical unresolved case, not an observed result here.

The adjacent#126/source6 example has the same remote6→3→7 contamination but a
normal Phelps4→Union5 approach and real Union departure08:30:19.911, known
08:30:34.933. Source1→Science0 likewise retains its genuine source11:01:52.958
(known11:01:57.979), waits at Science and releases only on real departure
12:01:15.428, known12:01:45.382. These reinforce the distinction between an
unreliable nearest-anchor chain and a physically qualified stop occurrence.

## Separately labeled directed-leg evidence

The independent artifact35687909547 uses a different, research-only reducer
adapter; it was NOT folded into this frozen diagnosis. It protects the exact
10:12:27.715 observation on directed leg4→5: previous/current path offsets
0.79/7.95m, advance49.45m over4.894s, selecting endpoint4 instead of remote6.
The remote State pass disappears, but Union's physical arrival, departure and
actual knownAt are byte-identical; only its anchor time moves earlier. It also
removes the remote College3 pass, with Humphrey arrival/departure/knownAt intact
and an earlier anchor. Added/removed anchor keys alone are not physical visits.

## Narrow options, not implemented by this diagnostic

Both options retain BOTH Brown leads, unchanged original45min/15s clocks,
whole-group fallback and deployed-point/early-bound hybrid. No score-based
selection or permanent release from an unpinned remote transit anchor.

A. **Checkpoint phase provenance only.** Keep the production reducer and all
visit emissions untouched. Distinguish an unpinned/null-departure transit anchor
from a physical phase. Retain a prior physical leg only while the existing
causal directed-leg certificate supports forward motion; otherwise withhold the
whole group without inventing a release. Current physical pin/hold and completed
departure evidence establish valid phase again. Origins retain their actual
knownAt and confirmed release stays irreversible. This has the narrowest data
effect, but introduces an explicit checkpoint phase view separate from the
detector's bookkeeping phase. This remains a proposal only.

B. **Brown-only directed-leg adapter.** Apply the already frozen geometric rule
only to route19 before the unchanged reducer. This keeps detector/pass/transit
state internally consistent and directly addresses both remote excursions, but
can affect anchor timing and other physical emissions elsewhere. It therefore
needs stricter full-route parity before any scoring.

For B, freeze the precise adapter source and require exact Brown physical
arrival/departure/actual-knownAt MULTISETS, treating unresolved pinned visits
explicitly and excluding only genuinely unpinned null/null bookkeeping passes
from physical identity. Preserve original source knowledge, fitted training
paths/distributions, original physical labels/deployed comparator/raw hashes,
and all non-Brown reducer emissions/features. Every anchor-only change and
phase/release/origin delta must be explicit and causal, with future-prefix
deletion checks. Halt before scores on any physical/knowledge/path/fit mismatch;
do not relabel or relax gates. Only if all pass may unchanged-label, common-cohort
window/rendered/action/handoff scoring proceed. Root authorized B as the next
separately pinned experiment; this diagnostic does not implement it.
