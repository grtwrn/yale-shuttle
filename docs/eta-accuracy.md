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

## Limits of the measurement

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
- `predictions_log` is empty: nothing in production records what riders were
  told, which is why this had to be reconstructed. The replay is the substitute
  until something does.
