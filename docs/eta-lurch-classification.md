# Is the jump information, or is it jitter? — classifying every ETA lurch

**Status: measured. One thing recommended for building, one candidate
disproved, one rejected candidate priced for the record.** Measured 2026-09-03
against a production snapshot taken at 17:35 ET: 89,624 `raw_positions`
(09:51–17:35 ET, 21 buses, 8 routes), 437,649 (bus, stop) poll-to-poll
transitions, replayed through the real `computeUpcomingArrivals`.

Harness: `services/shuttle-v2/scripts/eta-replay/eta-lurch.ts`. Read
`docs/eta-accuracy.md` and `docs/eta-error-budget.md` first; this extends both
and **overturns the premise it was given**.

---

## Lead: the drop is not the bug. The number before it is.

The operator's ruling:

> "I don't want a slew limiter. it can go 5->1 if it leaves early. but if it is
> jitter we need a fix."

The measurement agrees with them, and quantifies it. Of the 343 catastrophic
DROPS (a promise moving ≥ 300 s sooner in one poll), **317 — 92.4% — have a
real-world event behind them**: the bus departed, arrived, advanced a stop, or
physically moved. Smoothing those is withholding the truth.

The jitter is real too, and it has the opposite sign. Of the 380 catastrophic
jumps with **no** event behind them, **354 (93%) are the number jumping UP** —
a countdown at 5 min snapping back to 7 min while the bus sits exactly where it
was. That is what makes the eventual drop look like a lurch: the app spends the
layover being wrong in the pessimistic direction, and the correction, when it
finally comes, is the whole error at once.

**And the candidate I was handed to fix it — arm A, releasing the served-dwell
credit — cannot work, because the bound it relaxes is almost never reached.**
Across 39,944 observations of a bus standing at its anchor stop, the credit is
at its cap on **11.5%**. The median standing bus has served **0.4** of its
expected rest. The credit is limited by the *clock*, not by the cap: the
collector's standing clock keeps restarting on a bus that has not gone
anywhere, and the credit collapses with it.

The fix is therefore in the clock, not in the cap.

---

## The metric

For one (bus, stop) followed across consecutive 5 s polls, the predicted
arrival instant is `A(t) = t + eta(t)`. A healthy countdown holds `A` still and
ticks the displayed number down by the poll interval; a lurch is `A` moving.

```
jump = A(t') - A(t)      seconds — "the change in eta, net of elapsed time"
jump < 0   promised SOONER   (the 5 min -> 1 min drop)
jump > 0   promised LATER    (the countdown stalls or climbs)
```

Same definition as `eta-stability.ts`, so the numbers are comparable. This
harness follows the next 5 stops ahead of each bus rather than every stop on
the route, so its absolute counts are smaller than the error budget's; all
comparisons here are paired within this run.

### The replica guard

Arm A cannot be expressed by post-processing, so `arrivalsFor()` is a hand copy
of `computeUpcomingArrivals`'s first-hop pricing. At its shipped setting it is
compared with the **real** function on every observation:

```
replica: 0 mismatches in 444,409 checks, worst 0.000 s
```

A mismatch fails the run. This matters because `gps-replay.ts` on master is
**not** currently replaying the shipped client, in two ways:

1. it calls `computeUpcomingArrivals` with no `dwellTimes` argument, which
   silently disables the dwell-derived stall-credit bound (PR #53 fixes this);
2. it derives `at_stop_since` from `BusState.enteredAt`, which is the
   **pre-hotfix** collector — production has keyed it on `stationarySince`
   since 4cc38d2 (PR #57), and `enteredAt` understates standing time on exactly
   the parked buses this investigation is about.

This harness does both correctly. Its replica corresponds to
`web/src/arrivals.ts` at **992aca2**, which is the version on master
(61f32ce).

---

## Classifying the jumps

Is there a real-world event behind this transition? Three signals decide it,
all stateful or measured, none invented here:

- **the feed's 30 m deadband** (`docs/eta-error-budget.md`): upstream reports a
  new coordinate only once the vehicle has moved ~30 m, so a displacement at or
  above it is the feed *saying* the bus moved, and one below it is a censored
  observation meaning it did not;
- **the detector's own anchor** advancing;
- **a confirmed departure or arrival** — the at-stop flag changing together
  with movement or a restarted stationary clock.

One refinement earned its place during the run. A single 31 m fix clears the
deadband, but a bus manoeuvring in a layover lot clears it every few polls
while going nowhere: #309 at 344 Winchester moved 31–36 m on nearly every fix
for three minutes and its distance to the stop walked 174 → 5 → 95 → 46 m. So
"moved" is split by **net progress over the trailing 90 s**: under 100 m the
transition is a `shuffle`, not movement, and it is counted as eventless.

### |jump| ≥ 300 s, shipped — n = 1,217 (0.28% of transitions)

| cause | n | of which drops ≤ −300 s |
|---|---|---|
| **eventful — 837 (68.8%)** | | |
| movement (net progress ≥ 100 m / 90 s) | 464 | 215 |
| departure | 309 | 63 |
| arrival | 34 | 17 |
| detector anchor advance | 30 | 22 |
| **EVENTLESS — 380 (31.2%)** | | |
| **standing-clock reset** | **250** | **0** |
| shuffle (moved, but went nowhere) | 111 | 23 |
| at-stop flag flipped, no movement | 11 | 0 |
| client anchor flipped, no movement | 8 | 3 |
| re-price (calibration changed) | **0** | 0 |
| unexplained | **0** | 0 |

Every one of the 269 zero-displacement eventless jumps has a mechanism; nothing
is left in "unexplained".

**Calibration crossing a threshold mid-poll is not a mechanism here.** It was
the coordinator's leading candidate. It accounts for **0** of the ≥ 300 s jumps
and 30 of the 7,745 ≥ 60 s ones (0.4%). Caveat: this replay re-calibrates
hourly while production does so every 5 minutes, so production crosses that
boundary 12× more often in 12× smaller steps — which makes the ceiling lower,
not higher.

At the ≥ 60 s threshold the split is 6,203 eventful / 1,542 eventless (19.9%),
and the drop asymmetry holds: 3,500 of 3,723 big drops (94%) are eventful.

### Why this says 31.2% and `eta-error-budget.md` says 46.4%

The same question was measured the same day by `eta-stability.ts` (PR #62),
which reports 46.4% of catastrophic jumps as having no event behind them and
attributes them to the anchor moving while the bus did not. Both conclusions
point the same way — there IS a jitter population and it is the only thing
worth suppressing — but the numbers differ, and the reason is worth recording
rather than splitting the difference.

`eta-stability.ts` builds `at_stop_since` from `BusState.enteredAt`:

```ts
const at = st && cand && distanceMeters(o, cand) <= AT_STOP_MAX_M
  ? { id: st.nearestStopId, since: st.enteredAt } : null;   // eta-stability.ts:293
```

That is the **pre-hotfix** collector. Production has keyed it on
`stationarySince` since 4cc38d2 (PR #57, merged earlier the same day, live as
v308 when the canary ran), precisely because `enteredAt` restarts whenever a
different stop becomes nearest — which is what a bus shuffling in a garage lane
does every few polls. So that harness sees the resets production used to have
rather than the ones it still has, and since a reset of `enteredAt` coincides
by construction with `nearestStopId` flipping, the resulting ETA relocation
lands in its "the anchor moved while the bus did not" bucket.

The direction is consistent: more resets, more eventless jumps, a larger share
attributed to anchor movement. Neither number is wrong for what it measures;
this one is the shipped client, and it is checked as such on every observation.
The residual matters as well — the hotfix reduced the reset rate but did not
remove it, and 3.4% per standing poll-pair is what is left.

### The mechanism behind the eventless jumps

`collector.ts` grants the stall credit from `at_stop_since`, which is
`BusState.stationarySince`. On **3.4%** of consecutive standing polls where the
bus is at the same stop and has not moved (1,110 of 32,254), that clock
restarts — median 25 s of standing thrown away, p99 663 s. Because the credit
is `min(elapsed, cancellable, segAvg)`, a restart returns the first hop to its
full uncredited price in one poll. That is the +463 s step below, on a bus
whose coordinate is byte-identical across the two polls:

```
14:21:04  #306 Pink  Congress / Cedar   91 s -> 548 s   displacement 0 m
          anchor 0->0   detector 0->0   at_stop 149->149   calibration unchanged
```

By the moment a bus pulls out, **64.8% of layovers have lost standing time**
(median 15 s, p90 80 s, p99 555 s); among the layovers whose departure produced
a ≥ 300 s jump it is **81.9%** (p90 195 s). The clock is the dominant term, and
it is upstream of everything the client can do.

### A second mechanism, at departure only

The first hop is priced by one of two rules, chosen by whether the bus is
flagged at its stop: standing → credit, no proration; moving → proration, no
credit. Switching rule is a step change with no motion behind it. On the first
poll after the flag clears the progress factor is **p50 = 0.50**, and **49% of
departures re-price the first hop by half or more** in that single poll. #309's
berth projects 65% of the way along the chord to the next stop, so the same bus
in the same place went from 420 s to 184 s the instant the flag dropped.

---

## The arms

All computed from the same replayed inputs, so every comparison is paired.

| arm | what it changes |
|---|---|
| `shipped` | the real client |
| `A-cap` | credit bounded by `segAvg − driveFloor` instead of the dwell median. `driveFloor` is the straight-line distance at `BUS_SPEED_M_S`, already the client's price for an unmeasured hop, so no new constant |
| `A-sq` | A-cap's bound released as `g(r) = min(1, r²)`, `r = observed/expected` — little credit early, full credit once the expected rest is served |
| `C-clock` | the standing clock is held while the **detector still anchors the bus to that stop** and it is within 150 m of it. A flicker of `at_stop_id`, or a restart of `at_stop_since`, no longer zeroes the credit |
| `D-prorate` | proration applies in **both** regimes, so the parked number already knows where in the leg the bus is parked |
| `B45` | the output-side slew limiter at 45 s/poll — **baseline only, rejected** |

`A-lin` (`g(r) = min(1, r)`) was measured and is *arithmetically identical* to
`A-cap`: `min(elapsed, cap·r) = elapsed` whenever `cap ≥ expected`, which the
bound guarantees. Its row was a duplicate and is dropped.

The 150 m apron in arm C is measured, not chosen: `AT_STOP_MAX_M` is 75 m, and
#309 reached 95 m from 344 Winchester while plainly still serving it. The
detector-anchor gate is what stops a bus merely driving past from inheriting a
stale clock.

### Results — 437,649 transitions

| arm | \|jump\| p50 | p90 | p99 | p99.9 | ≥60 s | ≥300 s | **eventless ≥300 s** | frozen | up | median AE | opt > 2 min | pes > 2 min |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| shipped | 4.9 | 17.5 | 83.7 | 572.6 | 7,745 (1.8%) | 1,217 (0.28%) | **380 (31.2%)** | 29.7% | 10.8% | 97.8 | 25.7% | 18.5% |
| A-cap | 4.9 | 17.5 | 84.3 | 572.6 | 7,853 | 1,222 | 385 (31.5%) | 29.3% | 10.8% | 98.1 | 25.8% | 18.5% |
| A-sq | 4.9 | 15.8 | 79.9 | 559.8 | 6,665 | 1,124 | 315 (28.0%) | 29.1% | 10.5% | 97.2 | 23.2% | 21.1% |
| C-clock | 4.9 | 15.1 | 80.5 | 524.5 | 6,983 | 910 | **72 (7.9%)** | 31.7% | 9.0% | 97.1 | 27.7% | 16.3% |
| A-sq+C | 4.8 | 14.0 | 77.1 | 507.4 | 6,078 | 851 | **72 (8.5%)** | 30.5% | 8.8% | 96.9 | 25.0% | 19.2% |
| D-prorate | 4.9 | 17.9 | 84.7 | 556.6 | 7,810 | 1,161 | 360 (31.0%) | 29.4% | 11.2% | 98.2 | 25.9% | 18.4% |
| C+D | 4.9 | 16.1 | 85.5 | 546.8 | 7,735 | 961 | 82 (8.5%) | 30.2% | 9.5% | 97.6 | 28.0% | 16.0% |
| **A-sq+C+D** | 4.9 | 15.0 | 79.9 | 514.8 | **6,564** | **882** | **82 (9.3%)** | **29.2%** | 9.4% | **96.7** | 25.3% | 18.8% |
| B45 *(rejected)* | 4.9 | 22.8 | 45 | 61.4 | 446 | 73 | 6 | 28.3% | 13.0% | 97.6 | 25.8% | 18.2% |

"frozen" is the share of polls on which the displayed ETA does not move at all
— the anti-freeze guard. "up" is the share on which the countdown climbs.
Accuracy is scored against the bus's own track entering 50 m of the stop,
n = 401,454 pairs; it is a paired guard rail across arms, not an absolute (it
scores stops up to five ahead).

### The subpopulation where the lurch lives

**Layover departures** — the bus leaves a stop it was standing at, n = 14,203:

| arm | p50 | p90 | p99 | p99.9 | ≥300 s |
|---|---|---|---|---|---|
| shipped | 20.0 | 69.1 | 408.9 | 676 | 309 (2.2%) |
| A-cap | 20.0 | 69.2 | 419.9 | 676 | 309 (2.2%) |
| A-sq | 17.2 | 61.6 | 372.4 | 592 | 284 (2.0%) |
| C-clock | 5.1 | 60.3 | 310.1 | 573 | 152 (1.1%) |
| A-sq+C | 5.1 | 52.0 | 284.0 | 515 | 139 (1.0%) |
| **A-sq+C+D** | 9.2 | 56.1 | **269.7** | 515 | **128 (0.9%)** |
| B45 *(rejected)* | 20.0 | 45.0 | 45.0 | 218 | 7 (0.05%) |

**While standing** — both polls at the stop, n = 195,687: shipped has 367 jumps
≥ 300 s; every arm containing C has **46**. That is the jitter, removed.

**Paired big drops** (≤ −300 s), against shipped's 343:

| arm | removed | added | net |
|---|---|---|---|
| A-cap | **0** | **0** | 0 |
| A-sq | 4 | 28 | **+24** |
| C-clock | 38 | 12 | −26 |
| A-sq+C | 37 | 10 | −27 |
| D-prorate | 41 | 0 | −41 |
| A-sq+C+D | **52** | 10 | **−42** |
| B45 | 294 | 24 | −270 |

---

## The #309 case, poll by poll

The operator's case. #309 is the only Red bus at 344 Winchester in that window;
it was there **17:25:07 → 17:27:52**, and it reached Division / Prospect (the
board stop, three hops on) at 17:29:22. The 17:21:25 in the report is the
canary's watch time, not the lurch.

`stood` is the standing time the credit was granted for; `lost` is the standing
time the collector's clock had thrown away; `f` is the proration factor.
`truth` is seconds until the bus physically reached the stop.

| time | stood | credit | lost | f | shipped | A-sq+C+D | truth | rider reads |
|---|---|---|---|---|---|---|---|---|
| 17:25:12 | 15 s | 15 | 0 | 1 | 410 | 424 | 250 | 6 min → 7 min |
| 17:25:17 | **5 s** ⟵ reset | 5 | 15 | 1 | **420** | 423 | 245 | 7 min → 7 min |
| 17:25:42 | 30 s | 30 | 15 | 1 | 395 | 381 | 220 | 6 min → 6 min |
| 17:26:02 | 50 s | 50 | 15 | 1 | 375 | 302 | 200 | 6 min → 5 min |
| 17:26:27 | 75 s | 75 | 15 | 1 | 350 | 373 | 175 | 5 min → 6 min |
| 17:26:37 | 85 s | 85 | 15 | 1 | 340 | 377 | 165 | 5 min → 6 min |
| 17:26:42 | **0 s** ⟵ flag dropped | 0 | 0 | 1 | **425** | 372 | 160 | **7 min** → 6 min |
| 17:26:47 | 0 s | 0 | 0 | 1 | 425 | 367 | 155 | 7 min → 6 min |
| 17:26:52 | 0 s | 0 | 0 | 1 | 425 | 361 | 150 | 7 min → 6 min |
| 17:26:57 | 15 s | 15 | **105** | 1 | 410 | 356 | 145 | 6 min → 5 min |
| 17:27:27 | 45 s | 45 | 105 | 1 | 380 | 317 | 115 | 6 min → 5 min |
| 17:27:42 | 60 s | 60 | 105 | 1 | 365 | 271 | 100 | 6 min → 4 min |
| 17:27:47 | **5 s** ⟵ reset | 5 | **165** | 1 | **420** | 201 | 95 | **7 min** → 3 min |
| 17:27:52 | 0 s | 0 | 0 | **0.35** | **184** | 184 | 90 | **3 min** → 3 min |
| 17:27:57 | 0 s | 0 | 0 | **0.07** | 81 | 81 | 85 | 1 min → 1 min |

What the rider actually read, in order, under **shipped**:

```
6 7 6 6 6 6 6 6 6 6 6 6 6 6 5 5 5 5 | 7 7 7 | 6 6 6 6 6 6 6 6 6 6 | 7 | 3 1
  ^                                   ^^^^^                         ^   ^^^
reset                            flag dropped                    reset  the collapse
```

Three times the number bounces back to 7 min with the bus standing still, while
the truth falls from 250 s to 95 s. Then the bus pulls out, proration engages
(f = 0.35, then 0.07) and it collapses 7 → 3 → 1 min.

Under **A-sq+C+D**:

```
7 7 6 6 6 6 6 5 5 5 5 6 6 6 6 6 6 6 6 6 6 5 5 5 5 5 5 5 5 5 4 3 3 1
```

The three resets are gone — the clock carries through the flag dropping out and
through both restarts, and by 17:27:47 it holds 165 s of standing the shipped
clock had discarded. The biggest single-poll move in the displayed number falls
from **−236 s** (420 → 184, with the bus still 90 s away) to **−103 s**, which
is the final poll before arrival and is a correction that is *right*. The
countdown a rider watches is monotone apart from one 1-minute bounce.

**Neither arm is right in absolute terms.** Both remain 100–250 s pessimistic
throughout the layover, because nothing in the system knows how much longer a
driver intends to sit. That is the standing-time term `docs/eta-error-budget.md`
priced at 71% of the whole error budget, and it is unsolved. What changes here
is that the app stops throwing away the part of the answer it *does* have.

---

## Answers to the questions asked

**Does arm A alone make the drop small enough that the limiter is unnecessary?**
No — arm A alone does essentially nothing. `A-cap` removes **0** big drops and
adds **0**; its median accuracy is 0.3 s worse. The cap it relaxes is reached on
11.5% of standing observations, because the clock feeding it keeps restarting.
`A-sq` (the shape the brief asked for — little credit early, full credit at
`r ≥ 1`) is worth something as a *shape*: p90 17.5 → 15.8, ≥ 60 s jumps −14%,
and the > 2 min optimistic share 25.7% → 23.2%. But it makes the big drops
slightly *worse* (net +24) and is pessimistic-heavy (18.5% → 21.1%). It is
worth keeping only in combination.

**Does the limiter leave the rider told a wrong-but-steady number?** Yes, and
worse than that — it *extends* the wrong-but-steady period. B45 removes 294 of
343 catastrophic drops, and 91.8% of what remains is eventful, meaning it is
suppressing information by construction. It does not touch the mechanism: the
standing-clock reset still zeroes the credit, the limiter just makes the ETA
climb to the wrong number over 10 polls instead of 1. Its ≥ 300 s eventless
count is low for the same reason its eventful count is: it blunts everything
equally. **Rejected, as the operator ruled.** Priced here only so the record
has the number.

**Is the combination better than either?** The useful combination is not A+B,
it is **A-sq + C + D**, and the three are genuinely orthogonal:

- **C** kills the jitter: eventless ≥ 300 s jumps 380 → 72 (−81%), while-standing
  ≥ 300 s jumps 367 → 46 (−87%).
- **D** removes the departure step: 41 big drops removed, **0** added.
- **A-sq** restrains C's extra credit early, which is what keeps the optimistic
  tail from growing (C alone: 25.7% → 27.7%; with A-sq: 25.3%).

**Best pair, chosen from the numbers:** `A-sq + C + D`. Against shipped:
≥ 300 s jumps −28% (1,217 → 882), of which the eventless share falls 31.2% →
9.3%; ≥ 60 s jumps −15%; layover-departure p99 409 → 270 s; 52 catastrophic
drops removed against 10 added; median absolute error **improves** 97.8 → 96.7 s
with the optimistic and pessimistic tails both within 0.4 pp of shipped.

**Anti-freeze check.** A-sq+C+D's frozen share is **29.2% against shipped's
29.7%** — the ETA moves *more* often, not less, so the win is not a stalled
number. (C alone is +2.0 pp, which is the shipped hard cap biting more often
once the clock is honest; A-sq's ramp gives that back.) The countdown climbs on
9.4% of polls against 10.8%, with the p90 rise 43 s against 50 s. Nothing here
resembles the earlier 96%-NaN pathology.

---

## What to build

**1. Fix the standing clock in the collector.** This is the whole jitter
population and it is not a client problem. `stationarySince` still restarts on
a bus that has not gone anywhere: 3.4% of standing poll-pairs, and 64.8% of
layovers have lost time by the moment the bus pulls out. The rule that works in
replay is *hold the clock while the detector still anchors the bus to that
stop and it is within 150 m of it* — which also carries it across `at_stop_id`
flickering to null, as it did for three polls in the #309 case. See PR #63,
which measures the same reset rate from the other direction.

**2. Prorate in both regimes.** Removing the standing/moving pricing switch is
41 catastrophic drops removed and none added, the only arm here with a clean
sign. It is a two-line change in `computeUpcomingArrivals` — drop the
`stallCredit === 0` gate on `firstSegProgressFactor` — but it interacts with
the credit, so it should ship with the clock fix and be re-replayed, not alone.

**3. Ship `A-sq` only as part of that combination**, and only for its shape.
Its cap raise is inert; its `r²` ramp is what pays, and it pays by offsetting
arm C.

**Do not build the slew limiter.**

## What this does NOT fix, and the limits

- **The parked number is still 100–250 s pessimistic** on a long layover, in
  every arm. Nothing observes how much longer a driver means to sit. That is
  the 71%-of-budget standing term, still open.
- **The window is one weekday, 09:51–17:35 ET**, 21 buses, 8 of 15 routes —
  `raw_positions` retains only a few hours. No morning peak, no evening, no
  weekend, no night routes.
- **The population is the next 5 stops ahead of each bus**, so lap wraps are
  excluded by construction and the counts are not comparable with
  `eta-error-budget.md`'s all-stops figures. Comparisons within this table are
  paired and valid.
- **Calibration is time-travelled hourly**; production recalibrates every
  5 minutes. This inflates the size of a re-price step and deflates its
  frequency — and re-price is 0 of the ≥ 300 s jumps either way.
- **Arm C is a replay of a collector change, implemented in the harness.** A
  real implementation lives in `BusState` and has to survive bus-id reissues
  and feed gaps, neither of which is modelled here.
- **`predictions_log` is still empty.** Nothing in production records what
  riders were told, so all of this is reconstruction.
