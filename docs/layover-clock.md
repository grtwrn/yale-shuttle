# The layover clock resets on half of all layovers

Measured 2026-09-03 by `services/shuttle-v2/scripts/eta-replay/layover-replay.ts`,
which replays the **real** detector (`src/collector/detector.ts`, including the
`stationarySince` guard from #36) over a copy of production `raw_positions` and
scores its clock against a ground truth built from what each bus does next.

Reproduce:

```bash
cd services/shuttle-v2
# raw_positions is retained for 6 h only — take the snapshot the same day
printf 'const D=require("/app/node_modules/better-sqlite3");new D("/data/shuttle-v2.db",{readonly:true}).backup("/tmp/snap.db").then(()=>process.exit(0))' \
  | ~/.fly/bin/flyctl ssh console -a yale-shuttle -C "node -"
~/.fly/bin/flyctl ssh sftp get /tmp/snap.db ./store/snap.db -a yale-shuttle
curl -s https://yale-shuttle.fly.dev/api/buses -o ./store/buses.json

REPLAY_DB=./store/snap.db BUSES_JSON=./store/buses.json \
  npx tsx scripts/eta-replay/layover-replay.ts   # -> scripts/.eta-replay/layover.json
```

## The window is 7 hours, not 7 days — and cannot be more

`RAW_POSITION_RETAIN_MS` in `collector.ts` is **6 h**. Production held 81,617
positions spanning 13:51–20:55 UTC on 2026-09-03: 21 buses, 40.2 parked-hours,
879 stop visits of 60 s or more, 186 of them layovers (≥180 s, median 430 s).
A multi-day GPS replay of this logic is not possible without first extending
retention. Every figure below is that 7.07 h window.

## 1. A parked bus does not drift. It shuffles, once, just before leaving

The premise behind a 75 m tolerance is GPS jitter. **There is almost none.** In
the unambiguous core of a layover (60 s after arrival to 120 s before the last
poll at the stop, n=9,619):

| parked-bus motion | value |
|---|---|
| consecutive polls with **identical** coordinates | **99.7 %** |
| 30 s net displacement, p50 / p90 | 0 m / 0 m |
| 30 s net displacement, p99 / p99.9 / max | 30.3 m / 59.2 m / 66.6 m |

Movement arrives in a ~30 m quantum, and while genuinely parked it barely
arrives at all. So the resets are not noise being mistaken for movement — they
are **real movement**: the bus repositioning inside the stop, overwhelmingly in
the last minute or two before it pulls out.

Bus #316 at 344 Winchester, all six layovers in the window, is the operator's
reported incident and it is perfectly periodic:

| layover | parked | clock destroyed at | seconds thrown away |
|---|---|---|---|
| 14:37:44 | 486 s | 14:44:50 (65 s before departure) | **395.7** |
| 15:38:41 | 427 s | 15:44:48 (60 s before) | **335.0** |
| 17:38:23 | 475 s | 17:44:58 (80 s before) | **345.1** |
| 18:41:39 | 235 s | 18:44:39 (55 s before) | **150.0** |
| 19:38:39 | 455 s | 19:45:14 (60 s before) | **395.1** |
| 20:39:38 | 405 s | 20:45:23 (60 s before) | **340.1** |

The 20:45:23 row is reports #80/#81/#82: 340 s of standing time discarded 60 s
before departure, which is exactly the "3 min → 8 min" the rider saw.

## 2. Reset rate while parked

"Has not departed" is decided by what happens next, never by a radius (see §7).

| | |
|---|---|
| stop visits ≥60 s | 879 |
| visits with ≥1 false reset | **562 (63.9 %)** |
| layovers (≥180 s) | 186 |
| layovers with ≥1 false reset | **137 (73.7 %)** |
| false resets total | 673 (669 from the 75 m breach, 4 from re-anchor) |

Scored only over the polls a rider can actually see — where the payload serves
`at_stop` (within 75 m of the anchor stop, after 15 s) — **50.0 % of layovers**
carry an inflated ETA at some point.

## 3. The separation, and why no radius alone can work

The guard measures distance from **where the bus was when the clock last
restarted**. That anchor is set during roll-in, so it sits at the edge of the
stop, and the bus then settles somewhere else.

| distance while parked | p50 | p90 | p99 | max |
|---|---|---|---|---|
| from the **stop**, every poll | 19.0 | 54.8 | 92.3 | 214.8 |
| from the **arrival point**, every poll | 35.0 | 72.5 | 117.8 | 280.2 |
| per-visit max, from the stop | 60.0 | 73.8 | 156.3 | 214.8 |
| **per-visit max, from the arrival point** | **64.4** | **94.7** | 155.5 | 280.2 |
| per-layover max, from the stop | 62.9 | 97.7 | 157.0 | 157.1 |

After the departure instant:

| polls after departure | from the stop (p10 / p25 / p50 / p90) |
|---|---|
| +1 | 26.3 / 31.2 / 38.2 / 67.6 |
| +2 | 31.4 / 42.6 / 64.5 / 110.6 |
| +3 | 35.8 / 57.3 / 86.1 / 150.9 |
| +4 | 38.7 / 64.4 / 103.2 / 187.7 |

**The two populations overlap in distance and no threshold separates them.** A
parked bus's per-visit maximum (p50 = 60 m from the stop) is the same size as a
departed bus two polls out (p50 = 64.5 m). A bus one poll into its departure has
moved just 32.4 m from where it rested — one quantum, indistinguishable from a
shuffle.

What separates them is not how far but **from what**: measured from the stop
rather than from the bus's own last position, the parked p99 falls from 117.8 m
to 92.3 m while the departure signal is unchanged, because the stop does not
drift along with the shuffle. That is the whole finding — the frame matters far
more than the radius or any amount of hysteresis.

## 4. Which stops — layover stops own the damage, not the rate

| stop | false resets | visits | layovers | layovers hit | per parked hour |
|---|---|---|---|---|---|
| 22 Building 400 | 57 | 22 | 12 | **12 / 12** | 45.2 |
| 10 333 Cedar | 43 | 68 | 53 | 32 / 53 | 5.3 |
| 11 **344 Winchester** | 43 | 20 | 16 | **15 / 16** | 20.5 |
| 72 LEPH / 60 College | 35 | 34 | 1 | 1 | 43.8 |
| 115 State St Station | 28 | 29 | 0 | — | 36.1 |
| 43 Congress / Cedar | 26 | 23 | 0 | — | 57.7 |
| 121 Union Station (N) | 23 | 29 | 23 | 18 / 23 | 5.7 |
| 149 York / Cedar | 17 | 21 | 18 | 14 / 18 | 6.3 |

**Half-refuted.** Depot and layover stops do *not* dominate the raw rate — the
highest per-parked-hour rates are ordinary on-street stops (Congress / Cedar
57.7/h, Building 400 45.2/h, LEPH 43.8/h) where buses creep forward in traffic
and a visit is 60–90 s. But those resets are nearly free: there is no long
layover to re-bill. The *harm* is concentrated exactly where the operator said —
344 Winchester (15 of 16 layovers), Building 400 (12 of 12), Union Station (18
of 23), York / Cedar (14 of 18), 333 Cedar (32 of 53).

## 5. What a reset costs

The client cancels `min(stallCredit, dwell.med, segAvg)` off the first hop
(`web/src/arrivals.ts`). A reset drops `stallCredit` to zero, so the ETA gains
back the whole cancellable amount. Over 21,893 rider-visible parked polls, with
the live `dwells`/`segments` tables:

| ETA inflation | p90 | mean (when >0) | max | share of polls >60 s |
|---|---|---|---|---|
| all parked polls | 35.0 s | 13.8 s | **585.2 s** | **4.8 %** |
| layover polls | 39.9 s | 16.6 s | 585.2 s | — |

## 6. Variants

`falseN` = false resets. `lay%` = layovers carrying an inflated ETA. `late` =
seconds the first hop is inflated (the harmful direction — a rider told 8 min
for a 3 min bus misses it). `long` = the opposite error, a stale clock
over-cancelling the dwell. `lag` = polls (5 s) from the departure instant to the
clock restarting.

| policy | falseN | lay% | late p90 | late max | late>60s | long max | lag p50 | lag p90 | lag mean |
|---|---|---|---|---|---|---|---|---|---|
| **a) bus-anchored R=75 — SHIPPING** | 419 | 50.0 % | 35.0 | 585.2 | 4.8 % | 120.2 | 1 | 7 | 12.2 s |
| a) bus-anchored R=100 | 263 | 29.0 % | 15.1 | 652.2 | 3.0 % | 135.1 | 2 | 11 | 17.8 s |
| a) bus-anchored R=125 | 223 | 20.4 % | 10.2 | 433.2 | 2.7 % | 125.4 | 2 | 12 | 23.0 s |
| c) bus-anchored R=75 K=3 | 288 | 36.0 % | 20.0 | 450.3 | 2.6 % | 115.4 | 3 | 8 | 19.8 s |
| d) monotonic bus R=75 K=3 | 53 | 5.9 % | 5.1 | 475.4 | 0.4 % | 865.3 | 4 | 17 | 33.7 s |
| b) stop-pinned R=75 | 129 | 19.4 % | 0 | 475.4 | 1.0 % | 0 | 2 | 11 | 20.7 s |
| b) stop-pinned R=100 | 54 | 8.6 % | 0 | 335.1 | 0.2 % | 0 | 3 | 13 | 27.1 s |
| **b) stop-pinned R=125** | **34** | **6.5 %** | **0** | **0** | **0 %** | **0** | 4 | 15 | 31.5 s |
| b) stop-pinned R=150 | 17 | 4.3 % | 0 | 0 | 0 % | 0 | 4 | 16 | 36.1 s |
| c') stop-pinned R=100 K=2 | 32 | 6.5 % | 0 | 0 | 0 % | 0 | 4 | 14 | 30.7 s |
| c') stop-pinned R=125 K=2 | 29 | 6.5 % | 0 | 0 | 0 % | 0 | 4 | 16 | 34.7 s |
| d') monotonic pinned R=100 K=3 | 12 | 3.2 % | 0 | 0 | 0 % | 0 | 5 | 19 | 40.3 s |

Read down the two halves: **every stop-pinned row beats every bus-anchored row**,
and the best bus-anchored variant (monotonic K=3, 53 false resets) still leaves a
475 s worst case and buys an 865 s over-credit to get there. Hysteresis on top of
pinning is nearly free but nearly pointless — R=125 K=1 (34) and R=100 K=2 (32)
are the same answer, and K=1 needs no extra state.

### Recommendation: anchor on the stop, radius 125 m, no hysteresis

Pin the stationary anchor to the **stop's** coordinates while the bus is at that
stop, never re-base it there, and restart the clock only when the bus is more
than **125 m** from that stop — or when it arrives at a **different** stop, which
must always restart it.

| | shipping | recommended | change |
|---|---|---|---|
| false resets | 419 | 34 | **−92 %** |
| layovers with an inflated ETA | 50.0 % | 6.5 % | **−87 %** |
| ETA inflation p90 / max | 35.0 s / 585.2 s | 0 s / 0 s | **eliminated** |
| parked polls inflated >60 s | 4.8 % | 0 % | **eliminated** |
| over-credit max | 120.2 s | 0 s | eliminated |
| departure lag, mean | 12.2 s | 31.5 s | **+19.3 s** |
| departure lag, p50 / p90 | 1 / 7 polls | 4 / 15 polls | +3 / +8 polls |

**125 m rather than 150 m** because every measured error is already zero at 125,
150 buys nothing but 4.6 s more lag, and 125 stays under the 160 m widest
(N)/(S) stop pair on this network (see `MAX_HANDOFF_JUMP_M`'s note in
`detector.ts`) so the radius cannot reach a twin platform.

### The departure-lag cost, and why it is acceptable

**+19.3 s mean, +8 polls at p90.** The cost is close to nominal because the ETA
never reads the clock once the bus is away: `collector.ts` serves `at_stop` only
within `AT_STOP_MAX_M` (75 m) of the anchor stop, and `arrivals.ts` applies
`stallCredit` only when `bus.at_stop_id` is present and matches the GPS anchor.
Past 75 m the credit is zero whatever the clock says, so a clock that restarts
19 s later changes nothing a rider sees.

The one way lag could bite is a stale clock following the bus to its **next**
stop and over-cancelling the dwell there — the dangerous direction, since it
makes the ETA too short. That is ruled out by construction (arriving at a
different stop always restarts the clock) and confirmed by measurement:
over-credit max falls from 120.2 s to **0 s**, and no visit under the
recommendation carries any error over 60 s at all.

## 7. Method notes — the traps this measurement fell into

Three earlier versions of this replay produced confident, wrong numbers. They
are worth knowing because each looked right:

1. **A ground truth defined by a distance clamp reports its own clamp.** Calling
   a bus parked while within 150 m of a stop gave "max wander 150.0 m" and a
   departure p1 of 150.5 m — the boundary, measured twice. A visit must end
   because the bus *reaches another stop*, not because it crossed a line.
2. **The departure instant must not use a radius any candidate policy uses.**
   Defining departure as "the last poll within 75 m" hands stop-pinned-at-75 a
   perfect lag of 0 by construction; it scored 147 false resets and 13.5 % of
   layovers, both fiction. Departure is now found by walking back from an
   unambiguous 250 m to the start of the final resting plateau, using no
   threshold any policy shares.
3. **Percentiles over only the non-zero errors rank the reliable policy last.**
   A policy that is exactly right 99 % of the time has a *worse* p50 among its
   failures than one that is mildly wrong always. Zeros must be in the sample.

And one about the ground truth's own honesty: it must keep a bus's clock across
a feed dropout when the bus did not move, or it manufactures errors and blames
the guard. #45 sat bit-identical at Prospect / Huntington through a 7.5 min gap;
before that fix the recommended policy was charged with 465 s of over-credit for
being right.

## What this does NOT say

- Nothing here re-derives a segment average as "dwell + drive". `detector.ts`
  emits one `elapsedSec` as both `DwellEvent.dwellSec` and
  `SegmentEvent.travelSec`, so `arrivals.dwell_sec == segments.travel_sec` for
  every row; any reasoning built on those being independent is false.
- This is not the reverted adjacent-stop dwell credit (315a5d9). Nothing here
  moves credit between stops; the clock is only stopped from restarting at the
  stop where the bus is standing.
