# ETA accuracy: what riders see vs what happened

> **Correction, 2026-09-03 — read this first.** Everything below that says a
> segment sample "already contains the typical dwell", or that
> `seg.avg - dwells[from].med` is "the drive", is **wrong**, and it is wrong in
> a way that shipped twice. `detector.ts` computes ONE number per transition,
> `elapsedSec = obs.collectedAt - prev.enteredAt` (bus becomes nearest A →
> becomes nearest B), and emits it as **both** `DwellEvent.dwellSec` and
> `SegmentEvent.travelSec`. Joined on their shared anchor over 30 days,
> **119,329 of 119,329 rows have `dwell_sec == travel_sec` exactly**, mean
> difference 0. Nothing in this system measures how long a bus stands still.
>
> A segment is still arrival to arrival — that part is true, and it is why the
> planner must never add a dwell to one. What is false is that the hop can be
> *decomposed*: `dwells[stop]` is an estimate of the **whole hop**, keyed by
> from-stop instead of by (from, to) pair. The subtraction goes negative in
> practice — on the live payload the dwell median exceeds the whole segment
> average on **41.2% of hops (113 of 274)**, which is impossible under the old
> story. See "The unstarted-rest re-pricing" below.


A replay of the app's own ETA arithmetic against three months of production
arrivals, plus every raw GPS position of one service day through the real
client functions. Scripts: `services/shuttle-v2/scripts/eta-replay/` (README
there). Full tables from the run are in the PR that introduced this file; the
numbers below are the ones that decide what to build.

Error convention throughout: **predicted − actual, seconds; negative = the app
was optimistic** (the bus came later than promised).

## Headline

1. **Calibration is at its floor.** The server's per-segment estimator
   (30-day median prior, same-weekday hour ±1 window, shrinkage k = 8) was
   replayed exactly — a from-scratch replica matched `computeSegmentStats` on
   every group in 484 hour buckets — and then swapped for 28 alternatives.
   None is worth shipping on its own: the best (a 7-day prior plus a
   recent-traffic shrink) moves the median by −1.9 s.
2. **The rider-visible error is in the client's live-state handling**, not the
   calibration. Replaying 69k raw positions through `findRouteAnchor` +
   `computeUpcomingArrivals` gives a median error of 115 s for the next 1–5
   stops with a −87 s mean bias, against 44 s for the same horizons when the
   bus is simply standing at a stop. Two mechanisms explain most of it and
   both are fixable in the client.
3. **"Live pace" (report #64) makes things worse.** Scaling the remaining hops
   by the bus's own actual/predicted ratio over its last three hops raised the
   median error by 18.5 s at full strength and 3.2 s at half strength. Three
   hops of one bus are too noisy to extrapolate. Do not build it.

## Baseline (bus standing at a stop, clean window 2026-08-31 14:00 → 09-02 20:15 ET)

98,227 (prediction, actual) pairs, every arrival used, no sampling.

| horizon | n | median abs | p90 abs | mean signed | within 60 s |
|---|---|---|---|---|---|
| 1 stop ahead | 12,096 | 20.6 s | 102 s | −9 s | 83% |
| 1–5 stops | 54,686 | 44 s | 238 s | −14 s | 60% |
| 1–10 stops | 98,227 | 67 s | 313 s | −28 s | 47% |

Bias grows about −6 s per hop. The window is the first days of the semester
(buses slower than the 30-day summer history); the 21-day window (447k pairs,
partly on the old flicker-prone detector) shows +11 s the other way. Median
error by route is 54–75 s on the downtown lines and 100–117 s on Pink, Purple
and Gold.

## What the 28 variants said

| family | best paired Δ median | verdict |
|---|---|---|
| window shape: hour-only, weekday/weekend | +0.3 to +0.5 s | no change |
| shrinkage k = 2 / 4 / 16 | ±0.7 s | no change |
| medians instead of shrunk means | −1.6 to −4 s over 21 d, but 30–60 s **optimistic** and worse in the clean window | no |
| 7-day prior instead of 30-day | −1.2 s | marginal, consistent in both windows |
| recent traffic (this segment, last 1–2 h, any bus) shrunk into the served value | −1.3 to −1.9 s | marginal, consistent |
| client trusts the served value when payload `n` = 0 (drop the route-average/distance fallback) | −2.2 s over 21 d, +0.2 s clean | harmless; `n` = 0 is 5% of hops today |
| own-bus live pace (report #64) | **+18.5 s** (+3.2 s at half strength) | do not build |
| route-level drift over the last 2–6 h | +2 to +5.5 s | do not build |

The only calibration-side change with a consistent gain is recency (7-day
prior, recent-traffic shrink), worth about 2 s. It is queued behind the client
fixes below.

## The two client mechanisms (GPS replay, 2026-09-02 13:14 → 20:16 ET, 322k pairs)

**1. Stall credit over-corrected — fixed in this PR.** A segment sample runs
arrival to arrival, so `seg.avg` is the whole A→B elapsed time, waiting
included (but see the correction at the top: it cannot be split into a wait
and a drive). `computeUpcomingArrivals` nevertheless subtracted every elapsed
second of the current dwell from the first hop, so the longer a bus sat, the
more optimistic the promise: median next-stop error −19 s after 30 s of dwell,
−112 s after 2–5 min, **−203 s** past 5 min. Buses are dwelling in 41.6% of
positions. This is the "wait leg 20–25% optimistic" the live browser harness
kept reporting.

| stall credit | all pairs median | mean bias | at-stop next-stop median / median bias |
|---|---|---|---|
| uncapped (before) | 114.9 s | −87 s | 71.0 s / −54 s |
| capped at the dwell median | 111.6 s | −84 s | 64.0 s / −48 s |
| **capped at ½ × seg.avg (shipped)** | **103.9 s** | **−70 s** | **51.5 s / −26 s** |
| capped at ¼ × seg.avg | 102.9 s | −53 s | 51.8 s / −3 s |
| no credit at all | 104.6 s | −32 s | 57.4 s / +19 s |

**Both fractions were wrong, and a rider found out.** On 2026-09-03 a Red bus
had sat 10 minutes of its ~8-minute layover at 344 Winchester — 82 s of driving
from the next stop — and the board told a rider three stops later "5 min". Half
of that 557 s segment is 279 s of pure padding. The bus left, arrived about
2.5 min later, and anyone who trusted the 5 missed it. **Arriving early is the
dangerous direction**: a late bus costs a wait, an early one is gone.

The bound is not a fraction of the segment at all; it is the calibrated dwell
figure for that stop. **The reasoning originally written here — "the segment
equals the dwell plus the drive, and only the dwell can be cancelled" — is the
false premise corrected at the top of this file.** What the bound actually
leaves behind is the gap between a 30-day shrunk mean and a 14-day windowed
median of the same quantity, which on a right-skewed layover happens to be
about the size of the drive. It is kept because it is the best-MEASURED option
and a recorded pass gates it (`npm run test:accuracy`), not because that story
was right. So the credit is capped at the calibrated dwell for that stop
(`dwells` was already in the payload; `computeUpcomingArrivals` now takes it),
and `STALL_CREDIT_MAX_FRACTION` survives only as the fallback for a stop the
calibrator has never measured. For the reported hop: 557 − 475 = 82 s, which is
the drive, which is the answer.

### The credit could bill a whole hop at zero (2026-09-03, report #80)

A rider watching Red #316 hold at 344 Winchester asked the obvious question:
"if its waited 5/5 already, then it will be here sooner than 3 min". Replaying
that exact position against live calibration, **the premise is right and the
conclusion is wrong**: elapsed 300 s, cap 335 s, so `applied = min(300, 335,
419) = 300` — every elapsed second was already credited. The ~3 min left is
three hops of *driving* (119 + 55 + 50 s). No dwell credit can remove drive
time, and the direction the rider wanted is the one measured harmful twice.

What the report did uncover is the same bound failing on its other side. The
dwell median and the segment average estimate the *same quantity*, so `med >=
avg` is ordinary rather than exceptional — **114 of 274 hops (41.6%) on the
live payload** — and on every one of those `min(elapsed, med, segAvg)` returns
`segAvg`, billing the hop at **exactly zero**. A bus that had stood long enough
was promised at the next stop instantly: 0 s to cover 311 m. Over 88,570
replayed production positions that fired on **9.3% of at-stop next-stop
predictions**.

The fix is a floor that owes nothing to the dwell/segment decomposition: the
stops are a known distance apart, and no bus covers that distance faster than
the calibrator's own `MAX_PLAUSIBLE_M_S` (22 m/s). `driveFloorSec` in
`web/src/arrivals.ts`; the client mirrors the server constant and
`arrivals.test.ts` parses it, so the two cannot drift.

GPS replay, 2026-09-03 09:51–17:30 ET, 412,994 pairs, replica-exact against the
shipped function (0 mismatches). Truth = curb-side arrival:

| | median | mean bias | ≤60 s | **>2 min optimistic** | >2 min pessimistic |
|---|---|---|---|---|---|
| all positions, before | 98.7 s | −76.7 s | 36.3% | 27.0% | 17.6% |
| all positions, **after** | **96.7 s** | −73.7 s | 37.2% | **26.4%** | 17.6% |
| at-stop next-stop, before | 65.7 s | −130.8 s | 47.2% | 27.7% | 5.5% |
| at-stop next-stop, **after** | **62.1 s** | −124.9 s | 49.4% | **26.8%** | 5.5% |

The optimistic tail shrinks and the pessimistic tail does not move — the floor
only ever removes promises that were physically impossible. It fires on 30.1%
of at-stop next-stop predictions, median lift 20.5 s.

**Do not raise the floor to make the median look better.** Flooring at
`BUS_SPEED_M_S` (6 m/s, the *typical* speed used to guess unmeasured hops)
scores a better median (93.8 s) and a smaller optimistic tail (25.4%) — but
6 m/s is not an upper bound on speed, so the floor stops being a bound and
starts being padding: it prices a 370 m hop at 62 s and withholds credit a bus
has genuinely earned, which is the complaint in report #82. The 22 m/s bound
takes the free half of that trade and none of the risk. The half-hop cap still
scores best of all on the aggregate (92.0 s) and is exactly the one that broke
this layover; the aggregate hides it.

**2. The anchor goes wrong on out-and-back routes.** Where the client's anchor
disagrees with the server detector's stop index (13.4% of positions) the
median error is 367 s against 99 s otherwise. Disagreement is concentrated
where the route folds back on itself: Green 40%, Purple 19%, Orange East 16%,
Pink 10%, under 3% on Blue Day/Red/Orange Day. With a perfect anchor the
overall median would be 103 s and the mean bias +2 s. Green stays at roughly
200 s even then: its published sequence does not describe how buses drive the
West Campus spur, which needs its own investigation.

Also measured and settled: proration of the first hop by straight-line
progress is as good as proration along the road polyline (115 vs 117 s) and far
better than none (157 s). Keep the chord.

### What the lever was (2026-09-04): the road, and the feed's place in the sort

Two independent defects in `findRouteAnchor`, both in **which legs it believes
the bus could be on**. They were found separately (rider report 95 and PR #122's
handover trace) and each is measured on its own below.

**A leg was a chord, and a bus does not drive on a chord.** The candidate test
measured `distanceToSegmentM(bus, stops[i], stops[i+1])`: the straight line
between two stops. Blue West's Canal / Munson → Mansfield / Division is a 573 m
hop whose road bows more than 200 m off its own chord, so a bus honestly on that
leg reads 121–211 m from it and drops out of the 150 m candidate set — leaving
the RETURN down the same road as the only candidate, which gives the fold's
direction filter nothing to compare and lets `gateAnchor` take the hop on one
30 m deadband step. A bus 33 s from the kerb was re-priced a lap away.
Reproduced to the metre on the production feed rows, Blue West #126,
2026-09-03 21:37 ET (PR #122 names the same polls in UTC):

| poll (ET) | chord d[7] | chord d[8] | **road** d[7] | candidates | anchor |
|---|---|---|---|---|---|
| 21:37:40 | 121 m | 230 m | 2 m | [7] | 7 |
| 21:37:45 | 186 m | 143 m | 3 m | [8] | **8** |
| 21:37:50 | 211 m | 109 m | 3 m | [8] | **8** |
| 21:38:00 | 149 m | 96 m | 1 m | [7,8] | **8** |

This is the straight-diagonals bug in a second consumer (CLAUDE.md, "Route
lines"), and it takes the same fix: `traceStopLegs` projects the stops onto the
published polyline, so a leg is the piece of road between them. **Over 54,920
scored positions the leg the detector puts the bus on falls outside the 150 m
window on 19.64% of polls measured to the chord and 3.63% measured to the road.**
The published line supplies 271 of the network's 274 legs; the three it cannot
(all Green) fall back to the chord, as does any route with no registered path.

The cost is that a leg which follows the road is a long thin region and can hug
another leg on the same street, so there are more candidates to tell apart:

| route | mean candidates, chord to road | truth outside the window, chord to road |
|---|---|---|
| Blue West | 1.03 to 1.40 | **38.29% to 0.00%** |
| Purple | 1.76 to 2.55 | 41.47% to 2.21% |
| Green | 2.12 to 3.15 | 40.69% to 20.94% |
| Blue Night | 1.96 to 2.13 | 20.36% to 6.21% |
| Orange Night | 2.22 to 2.37 | 13.22% to 0.00% |
| Red | 2.66 to 2.69 | 1.27% to 0.08% |
| ALL | 2.04 to 2.37 | 19.64% to 3.63% |

Green keeps a fifth of its misses because three of its legs are the ones the
published line cannot supply at all, and the extra candidates are the reason
the selection rule below has to be right.

**`last_stop_id` ranked when it should only have excluded.** Step 2 sorted every
in-range candidate by forward distance from the feed's `last_stop_id` and used
the bus's own GPS purely as a tiebreak, so among adjacent candidates it always
took the EARLIEST — however far away. That is fine while the feed is fresh, and
it is often not: on Red #316, 2026-09-04, upstream froze `last_stop_id` at
Whitney / Audubon for **seven minutes, 2.6 km and five stops**, and the sort then
degenerates to "take the leg furthest behind":

    11:38:26  130 Prospect (N) -> Winchester / Sachem   32 m (fwd 2)  LOST to
              Trumbull / Hillhouse -> 130 Prospect (N) 145 m (fwd 1)
    11:41:27  Canal / Munson -> 344 Winchester          46 m (fwd 4)  LOST to
              Winchester / Sachem -> Canal / Munson    136 m (fwd 3)

`at_stop_id` was quietly doing the sort's job within 75 m of a stop, so between
stops the anchor simply sat a stop back for the whole hop and then caught up in
one poll: at 11:42:01 the countdown went 10 min to 5 min, and the bus reached
Division / Prospect 322 s later. The 5 was right; the hop that vanished carried
344 Winchester's layover. The same mechanism is report 95's own moment — Blue
Day #38 at 11:20:59, anchored at Whitney / Cottage (S) with the bus 132 m past
Whitney / Edwards (S), promised 297 s for a ride that took 224 s.

So forward distance now **excludes** (`ANCHOR_FEED_LEAD_HOPS`, 5) and the GPS
decides among the survivors, with forward order still breaking a tie inside
`ANCHOR_NEARER_M` (80 m). Both constants are measured, neither is tuned:

| rule | anchor behind the detector, all routes | Red |
|---|---|---|
| master's sort | 17.71% | 9.10% |
| window 3 | 10.06% | 0.58% |
| window 5 | 10.21% | 0.42% |
| window 8 | 9.25% | 0.96% |

The curve is flat from 3 to 8, so 5 is not an optimum: it is the smallest window
covering the freeze that was actually observed, and it stays well inside Red's
fold separation of ten. **Removing `last_stop_id` outright is still worse** —
at 11:36:46 the leg nearest #316 was SCL → 130 Prospect (S), 128 m away and ten
stops ahead on the far side of the fold; only forward distance rules that out.

**The band is not a softening of the rule, it is the whole safety of it**, and
it has two measured bounds that leave one narrow range.

From below, the folds. Two anti-parallel legs of an out-and-back sit within tens
of metres of each other, and choosing between them by distance does not cost a
stop, it costs a LAP. `scripts/eta-replay/branch-lock.ts` counts exactly that —
the anchor a quarter of the loop out of position:

| arm | Green | Purple | Blue Day | Orange Day |
|---|---|---|---|---|
| master | 11.1% | 22.2% | 0.3% | 0.5% |
| road window only | 11.1% | 22.2% | 0.3% | 0.5% |
| selection only, 30 m band | 13.1% | 26.5% | 0.9% | 0.0% |
| both, 30 m band | 13.7% | 27.8% | 1.2% | 0.0% |
| both, 60 m band | 12.7% | 26.0% | 0.3% | 0.0% |
| **both, 80 m band** | **11.1%** | **22.2%** | **0.3%** | **0.0%** |

The road window is byte-identical to master on this instrument; it is the
SELECTION rule that costs the out-and-backs, and the band is the dial. At 80 m
Green, Purple and Blue Day are back exactly where master had them and Orange
Day's gain is kept.

From above, the incidents: #316's two disputes are 113 m and 90 m apart, so the
band must stay under 90 m or the second one goes back to the feed's stale
answer. 80 is the largest round value that clears it.

It also settles a jitter that has its own shipped test. The two legs meeting AT
a stop are both ~0 m from a bus standing there, so with no band the choice
between "has reached this stop" and "is still approaching it" is float noise:
displacing a bus perpendicular to the road by up to 30 m at every stop on the
network changes the anchor at **96.7% of the 274 stops** with no band, 10.6% at
15 m, 0.7% at 30 m and 0.0% from 60 m up. Each flip adds or removes that stop's
whole dwell — report 32's "6 min then 16 min".

#### What it bought

`gps-replay.ts`, both changes, proximity truth (the primary one — it is what a
rider at the stop experiences), 2026-09-03's 6.5 h of raw positions:

| slice | master | branch |
|---|---|---|
| overall, median \| mean bias | 101.2 s \| −88.7 s | **100.4 s \| −58.2 s** |
| moving bus, next stop | 47.6 s \| −108.5 s | **45.2 s \| −60.3 s** |
| where the anchor disagrees with the detector | 338.4 s \| −431.8 s | **319.9 s \| −137.1 s** |
| Green + Purple | 199.2 s \| −216.3 s | **180.0 s \| −81.1 s** |
| every other route | 87.3 s \| −53.9 s | 85.8 s \| −51.4 s |
| perfect-anchor bound | 95.1 s \| −25.4 s | 95.1 s \| −25.4 s |

The bound is unmoved, so this is the same population measured against the same
ceiling. Per route the median moves 69.5 → 66.9 (Blue Day), 64.2 → 61.1 (Red),
217.5 → 198.5 (Green), 189.2 → 171.9 (Purple), 93.2 → 90.5 (Orange East), 68.8
→ 65.2 (Orange Night), and the other way on Brown (132.9 → 138.6), Gold (115.9
→ 117.7), Blue West (121.3 → 122.6) and Pink (207.8 → 208.5).

#### The two changes are coupled, and the rider simulator is what showed it

`rider-sim/run.ts`, 33,696 synthetic riders over the 2026-09-03 capture, all
fifteen lines, `PAYLOAD_PATCH=split-patch-0903.json`, every arm paired against
master wait for wait. Share of riders who saw each thing:

| arm | jump ≥300 s | reversal ≥60 s | STRAND | dropped while approaching | worst drift p90 |
|---|---|---|---|---|---|
| master | 23.2% | 37.0% | 6.4% | 18.0% (4,853) | 475 s |
| **road window only** | **17.4%** | **31.0%** | **5.6%** | **15.2% (4,025)** | **370 s** |
| selection change only | 24.1% | 40.4% | 7.0% | 20.2% (5,540) | 530 s |
| both, 30 m band | 17.8% | 31.6% | 5.6% | 15.9% (4,232) | 370 s |
| both, 80 m band | 17.8% | 31.4% | 5.4% | 15.6% (4,148) | 370 s |

On the headline shares the 80 m arm is the best of them. **It is also the one
that fails the per-route split**, which is the whole reason the split is the
gate — see below.

**The selection change on its own is a LOSS.** That is the finding to keep: with
the chord window the candidate set frequently does not contain the leg the bus
is on, and letting GPS choose freely among a wrong set is worse than the
conservative forward sort that master used to paper over it. The window has to
be fixed first; only then is "believe the GPS" safe.

Paired, road window against master: jumps ≥180 s fixed on 1,378 riders and
introduced on 214; reversals fixed on 1,585 and introduced on 73; strands fixed
on 377 and introduced on 195; drops 4,788 → 4,011. Worst drift improved for
2,842 riders and worsened for 717.

`jitter-audit.ts` pairs the two trees transition by transition over 1,068,197
ETAs with production's own `AnchorStore`:

| | master | branch |
|---|---|---|
| jumps ≥120 s | 8,183 (0.77%) | 7,536 (0.71%) |
| of which EVENTLESS (nothing happened in the world) | 134 | **67** |
| eventless by mechanism | wrap 50, flip 40, calib 26, advance 18 | wrap 46, calib 21 |
| eventless triggered by `last_stop_id` | 108 | **46** |
| "twitch" (bus moved <100 m) | 2,102 | 1,530 |
| freeze share, fix moved / fix repeated | 15.93% / 56.08% | 15.49% / 55.19% |

**The anchor-flip class of eventless jump is gone** — 40 and 18 to zero. And the
gate the operator cares about is untouched: over 1,649 departures the arm minus
shipped countdown is p50 0 s and p90 0 s both at the departure poll and six
polls later, and every one of the 38 departures where master dropped the number
by ≥60 s, the branch drops it in the same poll (38 of 38).

#### The index metric cannot arbitrate the window change, and here is the proof

`gps-replay`'s "anchor disagrees with the detector" and the sweep's disagreement
column both score the client anchor against an oracle built as *the GPS-nearer
of {detIdx, detIdx − 1}* — and "nearer" there is measured to the CHORD. So the
target moves with the arm unless it is pinned, and pinning it to the chord makes
the chord arm right by construction. Both readings are in
`scripts/eta-replay/anchor-sweep.ts` (54,920 scored positions), and they
disagree exactly as that predicts:

| arm | oracle measured the same way as the arm | oracle pinned to the chord |
|---|---|---|
| master (chord window, forward sort) | 41.04% | 41.04% |
| chord window + the exclusion rule | 35.61% | 35.61% |
| **road** window + the exclusion rule | 35.61% | 38.21% |
| **road** window + master's sort | 42.16% | 42.66% |

The selection change is judged cleanly either way — it does not touch the
candidate set, so both columns move together and both say it is better by five
points. The window change is not judged here at all. Its evidence is the two
measurements that need no oracle: **the leg the detector puts the bus on falls
outside the 150 m window on 19.64% of polls measured to the chord and 3.63%
measured to the road**, and the rider simulator below.

## THE GATE: it passes on totals and on Green, and FAILS on Purple

`rider-sim`, 28,951 waits paired master → this branch (80 m band), riders with
each defect FIXED / INTRODUCED. Totals first, then the routes the brief named:

| route | n | strand | jump ≥180 s | reversal | dropped |
|---|---|---|---|---|---|
| **ALL** | 28,951 | **466 / 204** | **1568 / 278** | **1715 / 130** | **885 / 152** |
| Red | 7,216 | 221 / 13 | 938 / 12 | 1197 / 3 | 392 / 1 |
| Green | 1,528 | 98 / 45 | 103 / 70 | 230 / 31 | 148 / 5 |
| **Purple** | 2,048 | **65 / 75** | **113 / 125** | 82 / 65 | 123 / 94 |
| Pink | 2,790 | 55 / 67 | 273 / 64 | 156 / 21 | 148 / 45 |
| Blue West | 188 | 14 / 0 | 19 / 0 | 22 / 0 | 23 / 0 |
| Blue Day | 6,554 | 0 / 0 | 77 / 0 | 5 / 0 | 11 / 0 |

Totals pass comfortably and Green passes on all four. **Purple does not**: net
+10 strands and +12 jumps ≥180 s. That is the swap the split exists to expose —
its headline strand share barely moves (12.0% → 12.3%) and its drops and
reversals improve, so a totals-only reading would have called this clean.

### And the same split says which half causes it

master → **road window only**, same population:

| route | strand | jump ≥180 s | reversal | dropped |
|---|---|---|---|---|
| ALL | 428 / 207 | 1483 / 223 | 1749 / 81 | 953 / 90 |
| Red | 213 / 48 | 884 / 34 | 1195 / 1 | 371 / 0 |
| Green | 58 / 27 | 103 / 47 | 234 / 26 | 143 / 9 |
| **Purple** | **82 / 28** | **157 / 87** | 92 / 53 | 136 / 67 |
| Pink | 50 / 102 | 288 / 54 | 184 / 1 | 230 / 14 |

**The window alone is strongly positive on Purple** (strand net −54, jumps net
−70). Adding the selection rule turns those into +10 and +12. The selection
rule buys Red (strand introduced 48 → 13, jumps introduced 34 → 12) and Pink
(strand 50/102 → 55/67) and pays for it on Purple.

So the two mechanisms are not merely coupled — they trade against each other by
route, and `ANCHOR_NEARER_M` at 80 m already spends the fold budget: it puts
`branch-lock`'s lap count back at master exactly (Purple 22.2%, Green 11.1%),
so Purple's remaining cost is not the fold and cannot be bought back with a
wider band.

### Decision: ship both (operator, 2026-09-04)

Red and Blue Day are what riders actually use, and Red is the operator's
founding complaint. Both halves give Red **938 jumps fixed against 12 and 221
strands against 13**; Purple pays **+10 strands and +12 jumps on 2,048 waits**
— half a percent, on the West Campus route — while the totals, Green, the
departure trace and the fold count all pass.

The per-route FIXED/INTRODUCED split is what makes that a decision rather than
a guess, and it stays as the gate for anything that touches this function.
`scripts/eta-replay/rider-sim/pair-by-route.mjs` is the instrument.

**The follow-up is a separate PR, not a per-route switch.** The halves trade by
route for a reason that is geometric, not statistical: Purple's out-and-back
puts two candidates on the SAME physical road running opposite ways, where
GPS-nearest is genuinely ambiguous and forward distance is the right tiebreaker
— whereas on Red the disputed candidates sit on distinct geometry, where the
GPS should win. Making the selection rule fold-aware on that basis is the fix;
special-casing a route id is not.

**Decided 2026-09-04, so nobody re-imposes it:** the anchor/detector
disagreement rate is **not a gate on a change to the candidate window**. It rose
on Pink, Purple, Green and Blue Night when the window moved from the chord to
the road, while those routes' rider error was flat or better, and the paragraph
above is why — a window fix cannot be judged by the thing it replaces. The gate
for such a change is `rider-sim/` paired against master (strands, reversals and
drops reported as a FIXED/INTRODUCED split, never as a total: the
selection-only arm proved a total can hide a swap), `branch-lock.ts` for the
out-and-backs, and the departure trace.

**And one thing to watch.** Green's mean bias flips −110.7 → +109.1: the median
improves 19 s and the sign moves to the safer side (a rider told later than the
bus comes does not miss it), but the character of Green's error changes and that
is the route to watch on the canary.


## The unstarted-rest re-pricing: shipped and reverted the same day (2026-09-03)

`computeUpcomingArrivals` briefly re-priced every hop after the first as
`max(30, seg.avg - dwell.med) + dwell.low`, meaning to bill a rest the bus had
not begun at the 35th percentile rather than the median. It was merged on a
measurement showing the median error on rest-spanning chains going from
+0.8..+2.0 min to about zero.

**The shipped code did the opposite of the thing that was measured.** Because
`dwell.med` estimates the whole hop rather than a part of it, `seg.avg - med`
collapsed onto the 30 s floor and the hop became `30 + low` — *larger* than the
segment it replaced.

| where | share of eligible hops re-priced UP | median change |
|---|---|---|
| live payload, 2026-09-03 16:20 ET | 66.4% | +12.9 s |
| every hour bucket of a week, all 15 routes (42,345 route-position-hours) | 77.2% | +24.9 s (mean +43.4 s) |

Blue Night's 333 Cedar → 129 York has a 63 s segment average and a 680 s dwell
median; it was billed **597 s**.

Replayed against real arrivals — 262,762 (prediction, actual) pairs, 30 days,
k = 1..5, `scripts/eta-replay/dwell-quantile-replay.ts`:

| configuration | median abs | mean bias | >2 min PESSIMISTIC (rider misses it) | >2 min OPTIMISTIC (rider waits) |
|---|---|---|---|---|
| **no re-pricing (shipped now)** | **37.5 s** | **+0.2 s** | **11.0%** | 9.9% |
| p35 re-pricing as merged | 46.7 s | +10.7 s | 13.0% | 9.8% |
| the same intent as an honest discount, `seg.avg - (med - low)` | 39.9 s | −28.8 s | 8.9% | 14.0% |

Clean window (post detector-rewrite, 60,163 pairs): median abs 41.1 / 45.2 /
48.1 s, pessimistic 7.0% / 8.1% / 4.8%.

So the merged version was **9.2 s worse on median error and 2.0 points more
pessimistic** — the direction it existed to reduce, and the one that costs a
rider the bus. Under the merging PR's own break-even (a missed bus 1.31× a
wait) its expected cost is 26.8 against 24.3 for not having it. Writing the
intent honestly (`- (med - low)`) overshoots the other way, −105 s median on
rest-spanning chains, because `med - low` is p50−p35 of the *whole* hop
compounded over five hops.

`DwellStats.low` is still calibrated and served, and is now dormant.

### It was also a source of visible JUMPS, which is what riders complain about

Median error says how wrong the board is on average; a rider does not
experience an average, they watch one number for a minute. Replaying every raw
GPS position of a service day at 5 s cadence through the real anchor
(`scripts/eta-replay/stability-replay.ts`, 361,112 consecutive-poll pairs), a
healthy ETA counts down in real time, so

    jump = (eta2 - eta1) + elapsed

is 0 when the number is honest. **Step 1 is exempt from the re-pricing and step
2 is not**, so the instant a bus advances a stop the hop that was surcharged
stops being surcharged — a jump built into the rule rather than into the data:

| at a stop advance (18,551 pairs) | with re-pricing | without (shipped) |
|---|---|---|
| median absolute jump | 48.0 s | **34.8 s** |
| jumps over 30 s | 76.4% | **55.8%** |
| jumps over 60 s | 36.5% | **28.8%** |
| jumps UP by over 60 s | 16.0% | **11.8%** |

Between stops (342,561 pairs) the two are identical to the decimal — the
re-pricing does not drift a bus mid-segment, it lurches at the stop boundary.
Removing it cuts the median lurch by 28% and upward lurches over a minute by a
quarter. Note the replay recalibrates hourly where production recalibrates
every 5 min, so this *understates* any additional flapping from the 30 s floor
crossing as calibration moves.

This is a different mechanism from the layover clock resetting under a parked
bus that creeps (`BusState.stationarySince` and `STATIONARY_RADIUS_M`); that
one lives in the collector and is not touched here.

## Does a bus's holding-so-far predict its holding ahead? No. (2026-09-03)

Tested because a bucket table suggested a bus that had held far LESS than
expected went on to hold ~1.78× expected — "its break has not happened yet".
`scripts/eta-replay/hold-signal.ts`, 58,005 windows over 30 days and all 15
routes, expected = the calibrator's own served median at that instant.

- The ratio reproduces at **1.44×**, not 1.78× (n = 1,096), and its median is
  1.12 — the mean is a tail.
- It is a confound. A bus that has held little is a bus that has not reached
  its layover yet, so its next window contains *different stops*. De-mean each
  observation's excess by the exact (route, stop-pair) it lands on and the
  deficit bucket's median effect is **−2.6 s**.
- Correlation of prev-3 ratio with next-2 ratio: **−0.03**; with de-meaned
  excess: **−0.09**. Negative — if anything the opposite sign.
- Against the price the board charges, the deficit bucket is under-charged by a
  median 30.2 s, indistinguishable from the ordinary 1–1.5× bucket's 29.9 s.
  The signal does not separate the population it exists to separate.
- End to end, withholding a discount from "deficit" buses moves the median
  error by 0.2–0.3 s. **A perfect, unbuildable oracle of whether the bus will
  actually hold longer is worth at most 4.2 s.** The client also holds no
  per-bus arrival history, so building it would need a new payload field.

Not built. Do not rebuild it without a signal that beats that 4.2 s ceiling.

## A deploy was writing short dwells and short segments (2026-09-04)

`Collector.states` is in memory, so until PR #129 and its follow-up every
restart made each bus a first sighting — a second `arrivals` row for one stand,
and, because `dwell_sec`, `segments.travel_sec` and `stop_visits.pinned_at` are
all measured from `BusState.enteredAt`, a dwell, a segment and a stand that
began at the RESTART instead of at the arrival. Report #100 caught the
rider-visible half. This is the calibration half, and it was on disk.

### The damage, from a production snapshot (2026-09-04, 30 days / 7 days)

A restart re-anchors the whole fleet on one poll, so its stamp carries an
arrival for every live bus. That is the fingerprint: 96.8% of the duplicate
rows sit on a stamp shared by six or more buses, and gating on six rather than
three changes the population by 4%.

| | | |
|---|---|---|
| 1,486 split stands in 7 days | 1,719 duplicate arrival rows | 4.3% of every arrival |
| 1,143 segments | short by a median 98 s | 0.93% of the table |
| 1,094 dwells | short by a median 101 s | 0.66% of the closed rows |

The served stand tables took it worst, because `STAND_VALUE` is
`departed_at − pinned_at` and a restart moves `pinned_at` into the middle of
the stand. Medians on the two routes whose tables riders are served, recorded
against merged:

| stop | recorded | merged |
|---|---|---|
| 344 Winchester (3:11) | 273 s | 310 s |
| Winchester / Mansfield (3:121) | 383 s | 479 s |
| 333 Cedar (1:10) | 405 s | 475 s |

### It moves the estimator the right way, and most where it should

`gps-replay.ts` against the snapshot, and against a copy with the split stands
merged (`scripts/merge-restart-split-arrivals.ts`) — the estimator identical,
only the calibration data differing. Proximity truth, 433k pairs, the shipped
client:

- Overall median |error| **97.4 → 96.8 s**; median bias **−5.3 → −1.7 s**.
- Six of nine routes improve their median: Pink 144.9 → 140.2, Gold 115.7 →
  113.2, Brown 116.6 → 114.6, Red 67.5 → 66.0, Blue Day 44.7 → 44.4. Green
  (266.5 → 267.2) and Orange Day (43.5 → 44.5) move the other way by under a
  second.
- **Every route's bias moves the same direction — away from optimism.** That is
  the mechanism showing itself: the truncated rows under-priced standing time,
  so the app promised buses that came later than it said.

The first hop, split by how long the bus has ALREADY been standing, is the
measurement that matters, because the deeper into a stand a bus is the more of
it a restart could hide (negative = optimistic):

| standing for | n | median \|error\| | mean bias | median bias |
|---|---|---|---|---|
| moving | 44,980 | 44.7 → 44.8 | −39.0 → −37.8 | 9.1 → 9.5 |
| 0–30 s | 5,570 | 21.3 → 21.2 | −32.7 → −31.7 | −13.6 → −13.0 |
| 30–60 s | 9,280 | 26.1 → 26.3 | −48.2 → −46.4 | −15.5 → −15.1 |
| 60–120 s | 9,155 | 51.9 → 53.5 | −88.3 → −84.1 | −32.9 → −30.2 |
| 120–300 s | 8,635 | 115.7 → 114.9 | −116.2 → −107.5 | −72.0 → −65.4 |
| **300 s+** | **9,257** | **128.0 → 122.1** | **−159.5 → −150.4** | **−111.6 → −103.6** |

The moving population is unchanged and the layover population gains 5.9 s of
median accuracy and 9.1 s of bias, monotonically in the elapsed stand. Nothing
was tuned to produce that — the correction is a measurement error being
removed, not a knob.

Two honest caveats. The overall trade is one point of `optimistic120` for one
point of `pessimistic120` (22.7 → 21.7 and 21.6 → 22.6): shifting predictions
later fixes the optimism where it is worst and overshoots elsewhere, and the
optimism/pessimism balance is the estimator's lever, not this one's. And
`gps-replay` does not serve the stand tables (`dwells[route][stop].q`), so the
worst-damaged of the three columns is not in these numbers at all — the table
above is a floor.

## Limits of the measurement

- **Read the `client` row, not `chord`.** `gps-replay.ts` scores the real
  `computeUpcomingArrivals` (the row marked SHIPPED) alongside an in-file
  replica that exists only so the counterfactual modes can be run at all. The
  replica has gone stale silently before — when the credit bound changed on
  2026-09-03 it was not updated, and the real call was not being passed
  `dwellTimes` either, so **112,825 of 412,994 pairs disagreed by up to 576 s**
  while `chord` was still being quoted here as "the current client". Both were
  fixed (#53 and this change). The replica rows remain sound as **deltas**
  against each other — which is how the before/after table above should be read
  — but an absolute accuracy figure should come from the `client` row, and the
  run prints a banner when the replica drifts past 1%.

- Ground truth for the arrivals replay is the detector's own "nearest stop
  changed" event, which fires a median 25 s before the bus is physically within
  50 m; the GPS replay uses the bus's own track (first entry within 50 m) as
  its primary truth. Absolute errors are therefore midpoint-to-midpoint in the
  first case and curb-side in the second; bias numbers are estimator bias
  either way.
- The detector was rewritten on 2026-08-31 13:00 ET; arrivals before that carry
  twin-stop flicker, so the clean window is 2.3 days. The GPS replay covers one
  weekday afternoon and evening — no morning peak, no weekend.
- Calibration was time-travelled at hour granularity; production recalibrates
  every 5 min, so it is 0–60 min fresher than the replay.
- `predictions_log` was empty when this was measured: nothing in production
  recorded what riders were told, which is why all of it had to be
  reconstructed. `docs/prediction-log.md` closes that gap — a sampled share of
  clients now posts what it displayed, every row naming the bundle that
  produced it — so a re-measurement can be checked against observation instead
  of asserted from a replay.
