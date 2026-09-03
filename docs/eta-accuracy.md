# ETA accuracy: what riders see vs what happened (measured 2026-09-02)

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
arrival to arrival, so `seg.avg` already contains the typical dwell at the
from-stop. `computeUpcomingArrivals` nevertheless subtracted every elapsed
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

Half was chosen over a quarter because a quarter turns pessimistic (+61 s
median) for buses that have sat more than 5 min, and half keeps the "about to
leave" reading honest for the layover stops riders watch most.
`STALL_CREDIT_MAX_FRACTION` in `web/src/arrivals.ts`.

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
