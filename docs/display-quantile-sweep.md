# The display quantile: τ swept, priced, and left where it is

**Measured 2026-09-08: the 9/4 gps-replay (205,061 scored pairs, every line)
for the aggregates, and the 9/3 rider simulator (2,001 paired Red waits) for
what it does to a rider. Status: a measurement for the operator, not a change.
`DISPLAY_TAU` still ships at 0.5 and nothing in this branch touches it.**

`docs/eta-ring-posterior.md` §3 calls τ "the one product constant" and says it
should be swept and put in front of the operator as a trade-off, not chosen by
taste. It never was. This is that sweep, plus a price on the trade-off, plus a
check of §3's own optimality argument against the data.

**The answer, up front: leave τ at 0.5.** The aggregate error statistics do
point mildly upward — the rider-at-the-kerb truth likes 0.55–0.60, which is
also where the estimator's measured median bias goes to zero — but they are the
only reading that does, and they are contradicted by the one measurement that
follows a rider rather than an aggregate. **The rider simulator, run at 0.50 and
at 0.55 over the same 2,001 paired Red waits, says 0.55 costs 42% more strands
(38 → 54), 42% more reversals (133 → 189), and more jumps and drops (§6).** The
detector truth says 0.45; §3's own asymmetric-loss argument, evaluated on the
real hazards and the real headways, says *below 0.35* unless riders build in
about four minutes of slack, at which point it says 0.50 exactly. 0.5 is the
only value none of these calls wrong. **And the incident that prompted the
sweep is not a τ problem**: Red #307's 11:07 stand at 344 Winchester sits at the
0.95 knot of that stop's own table, so no defensible τ would have promised it
(§8).

---

## 1. How τ was made settable, and the proof it changed nothing

`DISPLAY_TAU` (`web/src/eta/index.ts`) reaches the shown number through
`arrivalsForBus(..., tau, ...)`, but `computeUpcomingArrivals` passed
`undefined` and had no way to say otherwise. The measurement adds one optional
last argument to `computeUpcomingArrivals` and one env read in the replay, the
`MODEL_PARAMS` pattern:

```diff
--- a/services/shuttle-v2/web/src/arrivals.ts
+++ b/services/shuttle-v2/web/src/arrivals.ts
   anchorStore?: AnchorStore,
+  /** MEASUREMENT ONLY. Omitted — which is every call in the app — the
+   *  estimator uses `DISPLAY_TAU`, so shipped behaviour is untouched. */
+  tau?: number,
 ): UpcomingArrival[] {
...
-        routeSegs, routeDwells, targetSet, now, undefined, dwellTimes,
+        routeSegs, routeDwells, targetSet, now, tau, dwellTimes,

--- a/services/shuttle-v2/scripts/eta-replay/gps-replay.ts
+++ b/services/shuttle-v2/scripts/eta-replay/gps-replay.ts
+const TAU = process.env.DISPLAY_TAU ? Number(process.env.DISPLAY_TAU) : undefined;
...
-  dwellPayloadAt(o.t), clientStore)
+  dwellPayloadAt(o.t), clientStore, TAU)

--- a/services/shuttle-v2/scripts/eta-replay/rider-sim/run.ts
+++ b/services/shuttle-v2/scripts/eta-replay/rider-sim/run.ts
   (the same env read, and `..., segs, t, dw, cohort.store, TAU)`)
```

**Fidelity.** The pristine tree at `origin/master` (1c85638) and the patched
tree at `DISPLAY_TAU=0.50` were run on the same snapshot and the same payload
patch. All 226,052 emitted pairs are byte-identical, and so is the whole of
`gps.json` (`generatedAt` aside). The default arm *is* master, to every digit.
`npm test` — 2,044 tests, 73 files — passes with the patch in place. (`PAIRS_OUT`
was afterwards extended to carry the proximity truth and the pair's stop, bus
and clock, so §5's cost analysis could be done outside the script; that
extension is identical in every arm, the τ = 0.50 arm included.)

This branch is documentation only; the two-line patch above is not committed,
because a τ knob in shipped code is a thing an operator has to want.

## 2. The sweep — every line, the rider's truth

`REPLAY_DB=./store/snap-0904-2205.db`,
`PAYLOAD_PATCH=./scripts/.eta-replay/model-patch-all-0904.json`, one
`REPLAY_OUT` per arm. **2026-09-04 15:51–22:04 ET, 6.2 h, 49,655 positions,
226,052 pairs, 205,061 with a proximity truth**, next 1–5 stops.
Error = promise − truth. *Pessimistic* = we said later, the bus beat the
promise, the rider can miss it. *Optimistic* = we said sooner, the rider waits.

| τ | median \|err\| | p90 | median bias | **pessimistic ≥120 s** | **optimistic ≥120 s** | within 120 s | 10–90 covers | band width |
|---|---|---|---|---|---|---|---|---|
| 0.35 | 70.9 s | 383 | −34.8 | **9.9%** | **26.0%** | 64.1% | 76.5% | 298 s |
| 0.45 | 61.9 | 387 | −16.7 | 12.4% | 19.9% | 67.7% | 76.5% | 297 |
| **0.50 (shipped)** | **59.5** | **393** | **−7.7** | **14.0%** | **17.1%** | **68.9%** | **76.5%** | **298** |
| 0.55 | 57.9 | 402 | +1.3 | 16.0% | 14.5% | 69.6% | 76.6% | 298 |
| 0.60 | **57.8** | 414 | +8.8 | 18.0% | 12.1% | **69.8%** | 76.6% | 298 |
| 0.70 | 63.4 | 438 | +29.5 | 24.3% | 8.5% | 67.2% | 76.7% | 298 |

Read it as: **τ is a dial that trades the two tails at close to one for one**
(0.50 → 0.55 buys 2.6 points off the optimistic tail for 2.0 points onto the
pessimistic one) while nudging the median. The interval does not move at all —
`low`/`high` are q10/q90 of the same mixture and are not functions of τ, which
the flat coverage column (76.5 → 76.7%) and the flat median width (297.4 →
298.4 s) confirm empirically as well as by construction.

### The two ground truths disagree, and they bracket 0.5

The detector fires when the nearest stop changes — roughly at the midpoint
*before* the stop — so its arrival times are systematically earlier than the
kerb's, and it wants a *lower* τ:

| τ | 0.35 | 0.45 | **0.50** | 0.55 | 0.60 | 0.70 |
|---|---|---|---|---|---|---|
| median \|err\|, detector truth | 75.7 | **74.5** | 75.7 | 78.0 | 82.8 | 97.9 |
| median \|err\|, proximity truth | 70.9 | 61.9 | 59.5 | 57.9 | **57.8** | 63.4 |

**The choice of truth moves the apparent optimum by a full 0.15 of τ** — more
than any of the differences the sweep is trying to resolve. The proximity
truth is the rider's and is the one this report scores on, but the disagreement
is the first reason to distrust a τ picked to two decimal places.

## 3. Per route (proximity truth)

| route | n | median \|err\| 0.50 → 0.60 | pessimistic ≥120 s 0.50 → 0.60 | optimistic ≥120 s 0.50 → 0.60 | median bias at 0.50 | best τ | τ that zeroes the bias | 10–90 covers |
|---|---|---|---|---|---|---|---|---|
| Blue Day | 12,274 | 35.3 → 39.8 | 7.8 → 10.5 | 6.3 → 5.1 | **+6.2** | 0.35 | 0.43 | 81% |
| Orange Day | 13,982 | 28.1 → 29.6 | 5.0 → 6.1 | 3.6 → 2.1 | +3.8 | 0.50 | 0.46 | 84% |
| Red | 20,972 | 47.5 → 45.8 | 4.8 → 6.6 | 19.0 → 13.7 | −19.7 | 0.55 | 0.61 | 76–77% |
| Pink | 19,061 | 106.1 → 98.7 | 9.4 → 14.4 | 36.4 → 28.5 | −54.9 | 0.60 | 0.67 | 68% |
| **Green** | 22,611 | 191.3 → 226.3 | 49.0 → 55.5 | 11.3 → 8.9 | **+113.1** | **0.35** | **never in range** | 50% |
| Purple | 27,102 | 102.9 → 109.8 | 25.3 → 29.1 | 22.0 → 19.3 | −0.4 | 0.50 | 0.50 | 76% |
| Blue Night | 22,973 | 70.8 → 63.3 | 13.1 → 16.9 | 18.8 → 10.2 | −20.5 | 0.70 | 0.60 | 79% |
| Orange Night | 28,068 | 39.4 → 37.1 | 3.0 → 7.2 | 9.1 → 4.1 | −18.9 | 0.60 | 0.62 | 83% |
| Gold | 6,018 | 55.4 → 47.2 | 7.4 → 13.0 | 20.9 → 11.2 | −27.9 | 0.60 | 0.61 | 79–83% |
| Blue West | 12,037 | 47.5 → 46.8 | 4.5 → 7.8 | 16.6 → 8.4 | −16.6 | 0.60 | 0.56 | 92% |
| Orange East | 11,656 | 48.1 → 44.8 | 3.5 → 7.7 | 16.5 → 10.8 | −19.9 | 0.60 | 0.59 | 90% |
| Brown | 8,307 | 79.4 → 91.7 | 12.7 → 21.3 | 27.4 → 23.4 | −28.1 | 0.50 | 0.57 | 79% |
| **pooled** | 205,061 | 59.5 → 57.8 | 14.0 → 18.0 | 17.1 → 12.1 | **−7.7** | 0.60 | **0.54** | 76.5% |

**The important column is the bias one.** At τ = 0.5 the shown number is the
median of the predictive distribution, so a calibrated model would sit at 0.
Ten of twelve routes sit *early* (−17 to −55 s) and Green sits 113 s *late*.
**That is a per-route calibration defect, and one global τ cannot fix it**: the
τ that zeroes Pink is 0.67, where Green is already +174 s late at 0.60 and
roughly **+235 s** by 0.67; the τ that zeroes Green is below 0.35, where Pink is
**114 s early**. Green
is the known-bad ring — its buses call at West Haven station inside an 11 km
hop — and it alone contributes 11% of the pairs while pulling the pooled
optimum down. The last column also shows the interval is untouched by τ: every
route's coverage varies by under a point across the whole sweep (Gold, the
smallest sample, by four).

## 4. What τ actually moves on the screen

Median change in the shown seconds against τ = 0.50, by what the app is
currently promising:

| promised | n | 0.35 | 0.45 | 0.55 | 0.60 | 0.70 |
|---|---|---|---|---|---|---|
| 0–60 s | 18,675 | −3.7 | −1.2 | +1.4 | +3.0 | +6.7 |
| 1–2 min | 19,411 | −11.8 | −3.7 | +4.1 | +8.6 | +18.6 |
| 2–5 min | 54,747 | −20.8 | −6.9 | +7.2 | +15.0 | +32.0 |
| 5–10 min | 59,372 | −38.8 | −13.0 | +13.6 | +28.1 | +61.2 |
| 10–30 min | 66,346 | −92.2 | −29.9 | +30.5 | +64.1 | +148.5 |
| 30 min+ | 7,501 | −224 | −78 | +84 | +179 | +356 |
| **share of readings whose shown MINUTE changes** | | 63.0% | 31.7% | **32.5%** | 53.9% | 74.5% |

τ is nearly inert where riders care most (±1.4 s inside the last minute, which
is why the three accuracy suites' tight near-arrival assertions are not at
risk) and swings the long numbers hard. A move to 0.55 changes the displayed
minute on **a third of all readings** — a large, visible change to buy 1.6 s of
median accuracy.

## 5. The cost: strands versus waiting seconds

The simulator's currency, on the same 9/4 data. A *strand* is the bus pulling in
while the app still shows ≥180 s; the *waiting seconds* are `max(0, truth −
shown)`, what a rider who timed the walk to the number then stands at the kerb.
Both are put on one denominator — the **bus arrival event** (an "approach": one
bus, one stop, one arrival, and every poll at which a number was shown for it).
1,721 approaches, mean wait taken over each approach's own polls.

| τ | mean waiting s per approach | strands | strand rate | waiting s saved per strand added |
|---|---|---|---|---|
| 0.35 | 67.8 | 402 | 23.4% | — |
| 0.45 | 53.2 | 427 | 24.8% | 1,001 |
| **0.50** | **46.8** | **435** | **25.3%** | 1,383 |
| 0.55 | 40.8 | **435** | 25.3% | **∞ (no strand added)** |
| 0.60 | 35.2 | 439 | 25.5% | 2,405 |
| 0.70 | 25.3 | 443 | 25.7% | 4,244 |

A strand costs one headway. Measured on this window: **Red 940 s, Purple 895,
Orange Night 995, Green 1,035, Pink 1,185, Blue Day 1,260, Orange Day 1,420,
Blue Night 1,445; the four single-bus lines are a whole lap — Gold 2,320, Orange
East 2,295, Blue West 2,417, Brown 2,865.** Every step above 0.45 buys more
than a downtown headway's worth of waiting seconds per strand it adds, so **in
this currency the sweep says push τ up, all the way past 0.70.**

**Do not act on that — and §6 shows why.** This proxy barely responds: the
strand rate moves 2.3 points across the entire sweep, against a ±21 Poisson
error on 435 counts. It is also the *wrong unit*. It asks what number stood on
the screen at the instant of arrival, once per bus arrival. A strand happens to
a **rider**, who has been watching one pinned bus with their own belief store
since before the bus was in sight, and whose number can be ≥180 s at the kerb
for reasons this proxy never sees. Run at rider level — the simulator, 2,001
paired waits — the sign flips: τ = 0.55 **adds** strands, 38 → 54. The
approach-level number was measuring the anchor, which τ does not move; the
rider-level one measures what τ does. **§6 is the reading to trust, and this
table is kept only because it was the currency the sweep was asked for and
because the disagreement is the finding.**

## 6. The rider simulator: 0.55 is worse for Red's riders

The one measurement that scores a rider's *whole watched sequence* rather than
an aggregate over (bus, stop) pairs. Two runs from this tree over the 9/3
capture (09:51–24:00 ET), identical in everything but τ — same snapshot, same
`model-patch-all-0903`, same population (2,169 riders: 1,479 uniform + 690 on
the 344 Winchester chain) — paired wait for wait. 2,001 paired waits, 0 on one
side only.

| paired, τ 0.50 → 0.55 | at 0.50 | at 0.55 | fixed | **introduced** |
|---|---|---|---|---|
| **strand** (bus arrives while the number says ≥180 s) | 38 | **54** | 4 | **20** |
| jump ≥180 s | 93 | 108 | 9 | 24 |
| reversal ≥60 s | 133 | **189** | 19 | **75** |
| dropped while still approaching | 18 | 23 | 0 | 5 |
| worst drift per wait | — | — | improved 367 | worsened 479 |
| first-promise \|miss\| | — | — | improved 243 | worsened 373 |

Uniform riders alone (1,181 scored, Red): jump ≥180 s 4.8 → 5.3%, reversal
≥60 s **8.5 → 11.3%**, strand 1.2 → 1.5%, overshoot 4.0 → 4.6%, dropped 1.5 →
1.9%, worst-drift p90 **130 → 170 s**. The first-promise miss splits exactly as
§2 predicts — the bus arriving *later* than promised falls (19.0 → 16.8%) and
the bus *beating* the promise rises (26.3 → 29.1%) — and on this line the rise
is the one that costs.

The 344 Winchester chain, the six stops the operator's own incident is on
(675 waits):

| stop | strand 0.50 → 0.55 | reversal ≥60 s | first miss (s) | p90 drift (s) |
|---|---|---|---|---|
| Winchester / Division (146) | **10.4 → 16.5%** | 2.6 → 7.0% | 80 → 95 | 168 → 170 |
| Division / Sheffield (49) | 9.6 → 11.4% | 6.1 → 11.4% | 74.5 → 91 | 170 → 170 |
| Division / Prospect (48) | **0 → 2.6%** | 5.2 → 6.1% | 80 → 85 | **115 → 170** |
| Prospect / Hillside (104) | 0 → 0% | 5.4 → 9.8% | 74 → 74.5 | **115 → 170** |
| SCL (113) | 0 → 0% | 4.5 → 8.1% | 80 → 95 | **115 → 170** |
| 130 Prospect St (S) (4) | 0.9 → 0.9% | 5.6 → 6.5% | 101 → 108.5 | 131.5 → 170 |

Stop 48 — the one the ring estimator took from 21.7% strands to 0 — starts
stranding again at 0.55. **The single column that improves is the departure
poll**: displayed drift ≥180 s on 15 → 9 riders, max 290 → 230 s, because a
higher quantile of the lead-leg mixture is closer to the post-departure number
and the collapse is therefore smaller. That is real, and it is one column
against six.

This is the measurement that settles it, and it **overturns §5**: the
approach-level strand proxy said 0.55 was free, and at rider level it costs 42%
more strands and 42% more reversals on the line the operator watches.

## 7. §3's own optimality argument, checked

§3 claims the optimum sits where the arrival hazard equals 1/headway. It does —
that is the first-order condition of the right loss. Write it out. A rider
consults once and times the walk to the shown number `q`; they wait
`max(0, T−q)` seconds, and if the bus beats them by more than their own slack
`m` they have missed it and wait a headway `H`:

> `L(q) = E[(T−q)⁺] + H·P(T < q−m)`, so `dL/dq = −P(T>q) + H·f(q−m)`, and the
> optimum is where the hazard `f/(1−F)` equals `1/H`.

Both sides are measurable here: `P(T>q)` is the share of pairs the bus beat the
promise, and `f` is `ΔP(T<q−m)/Δq̄` between neighbouring arms. Pooled, at
`H = 1,200 s`:

| slack m | step | Δq̄ | measured f(q) /s | H·f | P(T>q) | **dL/dq** | waiting s saved per extra miss |
|---|---|---|---|---|---|---|---|
| 0 s | 0.45→0.50 | +19 s | 2.52e−3 | 3.02 | 0.57 | **+2.45** | 199 |
| 0 s | 0.50→0.55 | +19 | 2.67e−3 | 3.20 | 0.52 | **+2.69** | 170 |
| 120 s | 0.45→0.50 | +19 | 8.40e−4 | 1.01 | 0.57 | **+0.44** | 595 |
| 120 s | 0.50→0.55 | +19 | 1.02e−3 | 1.22 | 0.52 | **+0.71** | 446 |
| 180 s | 0.35→0.45 | +36 | 4.27e−4 | 0.51 | 0.63 | **−0.12** | 1,352 |
| 180 s | 0.45→0.50 | +19 | 5.95e−4 | 0.71 | 0.57 | **+0.15** | 840 |

`dL/dq > 0` means the promise is already too high. **Taken literally, §3's
argument does not endorse τ = 0.5 — it demands far less.** With no rider slack
the hazard near the median is 2.5e−3 per second, three times the 1/H the
condition asks for, and the optimum lies below the swept range entirely. The
mechanism is not subtle: the estimator is *tight* relative to the service. A
median error of 60 s against a 16-minute headway means the arrival density right
at the promise is high, so a second of added pessimism buys a lot of miss
probability at a very expensive price.

The τ that the loss endorses is therefore a direct function of how much slack a
rider builds in:

| rider slack m | 0 s | 60 | 90 | 120 | 150 | 180 | **240** | 300 |
|---|---|---|---|---|---|---|---|---|
| pooled loss-optimal τ | 0.35− | 0.35− | 0.35− | 0.35− | 0.35− | 0.45 | **0.50** | 0.55 |
| Red's | 0.35− | 0.35− | 0.35− | 0.35− | 0.45 | 0.50 | 0.60 | 0.70 |
| Pink's | 0.35− | 0.35− | 0.35− | 0.45 | 0.50 | 0.55 | 0.60 | 0.70 |

("0.35−" = the loss was still falling at the bottom of the swept range, so the
optimum lies below it; the sweep did not go lower because no shipped display
would.)

**τ = 0.5 is exactly the loss-optimal choice for a rider who leaves about four
minutes of slack** (Red: three). That is a defensible description of how people
use a shuttle app — you leave when it says a few minutes, not at the last
second — and it is the strongest single justification the shipped constant has.
It is also the whole of that justification: assume a rider who commits to one
reading with no slack, and the same argument says show them something near
q10.

The two brackets, then, straddle the constant:

* a rider who **commits to one reading** → τ well below 0.5 (§7);
* a rider who **watches the live countdown**, whom only the last number can
  catch out → τ 0.6–0.7, on the approach-level proxy (§5).

The app shows a countdown that refreshes every five seconds *and* a q10–q90
band the point estimate sits inside, so real riders are somewhere between. The
upper bracket is the weaker of the two: §6 simulates exactly that
countdown-watching rider, one rider at a time, and finds 0.55 already worse
than 0.50. Nothing the app logs would settle it directly — no reading is
recorded against whether its rider caught the bus.

## 8. The incident that prompted this: τ could not have fixed it

The operator watched Red #307 stand 11:07 (667 s) at 344 Winchester while the
app promised a typical 4:48. That stop's served stand table on the 9/4 payload
is

```
344 Winchester (stop 11): q = [28, 115, 140, 148, 242, 309, 376, 450, 491, 668]
                          at the 0.05 … 0.95 knots, n = 57, P(stop) = 0.947
```

so the median stand is ≈275 s — the 4:48 the app showed — and **667 s is the
0.95 knot.** The τ that would have promised #307's stand is **0.95**, and it
would have priced every ordinary visit to that stop at 668 s, six and a half
minutes late. Moving τ to 0.60 would have covered 68 s of the 392 s shortfall.

What *did* carry it was the interval: q90 of that stand table is ≈615 s, so a
row priced on it was already saying ten minutes at the top of its band while the
point said five. (The row's own `high` was not recorded at the time; the stand
table is what the estimator had in hand.) §3's own
sentence stands — "nothing in the feed says when a driver intends to go; the
interval carries it, the point cannot" — and the levers that would move this
number are the ones already on the list: a per-route (or per-stop) bias
correction, and the anchor. Headway to the leading bus was measured at this
exact stop and does not help (R² 0.04, n = 53).

## 9. Recommendation

**Keep `DISPLAY_TAU = 0.5`.** Not because it is optimal under any one reading,
but because it is the only value that is *near*-optimal under all of them, and
because every argument for moving it is met by an equally measured argument for
moving it the other way:

| the case for raising τ (→0.55/0.60) | the case for lowering τ (→0.45) |
|---|---|
| median \|err\| 59.5 → 57.9 s, within-120 68.9 → 69.6% | detector truth is the mirror image: 75.7 → 78.0 s |
| median bias −7.7 → +1.3 s; ten of twelve routes promise early at 0.5 | Green promises 113 s late at 0.5 and gets worse |
| optimistic ≥120 s 17.1 → 14.5% | pessimistic ≥120 s — the dangerous tail — 14.0 → 16.0% |
| the departure poll settles faster: drift ≥180 s on 15 → 9 chain riders (§6) | **the rider simulator: strands 38 → 54, reversals 133 → 189, jumps 93 → 108, drops 18 → 23 on 2,001 paired Red waits (§6)** |
| | §7's loss, with any realistic slack, is already past its optimum at 0.5 |
| | changes the shown minute on a third of all readings |

**The right-hand column now holds the strand evidence that used to sit on the
left.** Before the rider simulator was run, the case for 0.55 was "better
median, zero strand cost". The strand cost is not zero — §5 measured it at the
wrong grain and §6 at the right one — and with that line moved across, the case
for raising τ is one aggregate statistic and one settled-departure column
against six rider-level regressions. **0.55 is not the step to take.** If the
operator wants it anyway it should go out per route (Red and Pink want a higher
τ; Blue Day, Orange Day and Green want a lower one) and behind a rider-sim run
on each route it touches — not as one global constant.

**The higher-value work is not τ.** A single global quantile is being asked to
absorb a per-route bias that ranges from −55 s (Pink) to +113 s (Green). Fixing
that bias per route is worth more than any τ in this sweep — it would move
Pink's median error further than the whole 0.35–0.70 range does — and the
anchor remains the largest single lever on record.

## 10. Sanity: what τ does *not* touch

τ is a display choice and must stay one. Checked on the 226,052 pairs of every
arm:

* **The interval is not a function of τ.** `low`/`high` are q10/q90 of the same
  mixture (`arrival.ts` `mixedQuantiles(parts, [0.1, tau, 0.9])`). Median band
  width across the whole sweep: 297.4 → 298.4 s. Coverage: 76.5 → 76.7% pooled,
  and under a point on every route bar Gold (the smallest sample, four).
* **The one path by which τ reaches the band is the #119 clamp, and it is the
  designed one.** Between τ = 0.50 and 0.55 an endpoint moves on 13.9% of
  pairs — **30.8% of pairs with the bus at a stop against 3.0% with it
  moving**, a 10:1 concentration on exactly the state the clamp acts in. The
  clamp lowers the shown remainder to the least it has shown under that stand
  and shifts `low`/`high` by the same delta; that delta inherits a τ-dependent
  history, so a clamped band is a clamped band at any τ. The clamp's *rule* —
  the number may pause and never climb while the lead stands, the floor is kept
  but not applied while it moves, and it ends with the rest — reads `eta`
  whatever quantile produced it and is unchanged.
* **The "5 → 1 on the departure poll" gate is unchanged in kind.** The
  departure lands on the poll it is seen because the lead LEG's standing and
  moving variants are mixed by their mass; τ picks a quantile of that mixture
  and does not decide which variants are in it. What τ changes is the size of
  the step, and only slightly: inside the last minute — where the departure
  collapse lands — the median shown number moves 1.4 s between 0.50 and 0.55
  (§4).
* **The three accuracy suites** (`accuracy-approach-rest`, `accuracy-layover`,
  `accuracy-closing-bus`) pass, inside the full 2,044-test run, with the
  measurement patch applied. They could not be re-run at another τ without
  editing the shipped constant, which this branch deliberately does not do;
  their tightest numeric assertions are near-arrival ones (`lastEta < 30` with
  the bus 11 s out, `|error| < 120` at the layover) and §4 shows τ moves that
  region by single-digit seconds up to 0.60.
* **Nothing pins τ.** No test imports `DISPLAY_TAU`; `arrival.test.ts` and
  `params.test.ts` pass `0.5` as a literal. A change to the constant would go
  out green. A test pinning the shipped value should land with any change to it.

## 11. Caveats

* **The window is an evening.** 9/4 15:51–22:04 ET. Headways measured on it are
  evening headways (Red 940 s; four lines are down to a single bus, a whole lap
  between arrivals). A short headway makes a miss cheap and therefore argues for
  a *higher* τ, so a daytime window would push §7's optimum up — the evening
  window is the conservative direction for the "keep 0.5, don't raise it"
  conclusion, and the aggressive direction for "don't lower it". Evening stands
  are also longer and more variable, which is where the optimistic bias comes
  from; a daytime sweep may find a smaller bias and a flatter τ curve. **A
  daytime replay is the first thing to run before acting on any of this.**
* **Two truths, one conclusion.** §2 shows the truth choice moves the optimum
  more than τ does. Neither truth is wrong; they measure different instants.
* **Strand counts are thin at approach level** — 1,721 approaches, 435 strands,
  a ±21 Poisson band — which is part of why §5 read the trade wrong. §6's
  rider-level counts (38 vs 54 on 2,001 paired waits) are also small in
  absolute terms, but they are *paired*: the same 2,001 riders, the same
  capture, the same tables, one constant changed, so the 20 introduced against
  4 fixed is a within-subject count and not a difference of two noisy means.
* **§6 is Red only, and one day.** The 9/3 capture, `ROUTES=Red`,
  `POP=uniform` plus the 344 Winchester chain. A route whose bias runs the
  other way (Blue Day, Orange Day, Green) could well move the opposite way
  under the same τ, which is precisely the argument in §3 against one global
  constant. Two runs were needed, not the one this measurement was budgeted
  for: the archived `cand11-0903.waits.jsonl` is not pairable with this tree
  (different worktree, and `POP=both` against this run's `POP=uniform`), so a
  τ = 0.50 baseline had to be produced from the same tree to pair against.
* **The loss model's miss cost is assumed, not measured.** Nothing records
  whether a rider caught the bus. `H` per miss is an upper bound and the slack
  `m` is a free parameter; §7 reports the whole curve rather than one number for
  that reason.
* **Hour-of-day and per-bus effects are already excluded** (±6% and a selection
  artefact, PR #164) and the calibration window is current, so the quantile was
  genuinely the last untried display lever. It is now tried.
## 12. Reproducing

```bash
cd services/shuttle-v2
# apply the two-line patch in §1, then, per arm:
TZ=America/New_York DISPLAY_TAU=0.55 \
  REPLAY_DB=./store/snap-0904-2205.db \
  PAYLOAD_PATCH=./scripts/.eta-replay/model-patch-all-0904.json \
  REPLAY_OUT=./scripts/.eta-replay/tau/t0.55 \
  PAIRS_OUT=./scripts/.eta-replay/tau/t0.55/pairs.jsonl \
  npx tsx scripts/eta-replay/gps-replay.ts
```

Two minutes an arm on the Pi. `DISPLAY_TAU` unset reproduces master exactly;
that identity is the first thing to re-check if any of these numbers move.

The rider simulator (§6), about 22 minutes an arm:

```bash
TZ=America/New_York DISPLAY_TAU=0.55 \
  REPLAY_DB=./store/snap-0904-2205.db \
  CAPTURE=$HOME/shuttle-captures/positions-20260903.jsonl \
  PAYLOAD_PATCH=./scripts/.eta-replay/model-patch-all-0903.json \
  ROUTES=Red HOLDOUT= POP=uniform \
  REPLAY_OUT=./scripts/.eta-replay/tau/sim OUT_NAME=tau055 \
  npx tsx scripts/eta-replay/rider-sim/run.ts
# then pair the arms
TZ=America/New_York npx tsx scripts/eta-replay/rider-sim/run.ts --compare \
  scripts/.eta-replay/tau/sim/tau050.waits.jsonl \
  scripts/.eta-replay/tau/sim/tau055.waits.jsonl
```
