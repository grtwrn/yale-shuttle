# Showing a bus's speed

**Status: investigated, not built.** Rider report #63 asks for it. This
records what the data actually supports so the next person does not have to
re-measure it, and does not have to reach for a Kalman filter to find out it
was unnecessary.

Measured 2026-09-02 against 75,570 `raw_positions` rows (08:48–15:17 ET, 23
bus names across 8 routes) plus a 6-minute live poll of `routes_buses.php`.
One weekday daytime, 8 of 15 routes running: no night routes, no rush hour,
no bad weather. Every number below is from that sample.

## The feed does not move smoothly, and that is the whole problem

Upstream sends no speed field, so a speed has to be derived from consecutive
positions. Those positions stutter.

| | |
|---|---|
| Consecutive samples with identical lat/lon | 53.6% |
| Repeat run length, median / p90 / max | 3 / 11 / 331 samples (15 s / 55 s / 28 min) |
| Naive Δd/Δt readings of exactly 0 mph | 53.6% |
| …of those, buses actually averaging > 5 mph over the surrounding 60 s | 39.1% |

So **21% of all samples would call a moving bus stopped**. Poll cadence itself
is clean (Δt p50 5.0 s, p99 5.3 s); it is the position that repeats.

Two things that sound like problems and are not:

- **Absurd fast readings are mostly real.** Over 45 mph appears on 9.8% and
  8.3% of samples on routes 9 and 10 — the West Campus highway run — and on
  0.0–0.1% of the six campus routes. Only 0.01% of all samples exceed 80 mph,
  so a "discard above 110 km/h" rule would filter almost nothing.
- **`bus_id` reissue does not corrupt speed.** 14 id changes within a name in
  6.5 h, every one after a 35–600 s gap, max implied speed across a boundary
  4 mph. Keying on the track identity and dropping gaps over 20 s removes it.

## A Kalman filter earns nothing here

Compared on the same 55,926 samples, truth being the centred ±30 s path speed:

| estimator | median error (mph) | p90 error | jitter p90 | "stopped" while moving |
|---|---|---|---|---|
| naive Δd/Δt | 4.8 | 12.4 | 16.8 | 20.4% |
| **30 s trailing window** | **2.3** | **7.1** | **4.1** | **3.6%** |
| median of last 6 naive | 2.9 | 8.9 | 7.1 | 14.4% |
| along-route over 30 s | 2.6 | 11.6 | 6.8 | (MAE 22.1) |
| constant-velocity Kalman, best of 32 tunings | 2.29 | 7.5 | 4.2 | 4.8% |

The filter ties a plain trailing window and never beats it; against a ±20 s
truth it is 2.01 vs the window's 2.03. Skipping duplicate fixes made the
filter *worse* (7.3). Along-route projection is actively harmful, because
routes 9 and 10's out-and-back mis-projects: 11.3% of its readings exceed
45 mph against the window's 4.0%.

The lesson generalises: the error here is a stuttering sensor, not Gaussian
process noise, and a filter tuned for the latter has nothing to work with.

## What a speed readout is worth to a rider

Current 30 s speed as a predictor of the bus's mean speed over the next N
seconds, against the route's own long-run average as the baseline:

| horizon | correlation | speed error | route-average error | winner |
|---|---|---|---|---|
| 60 s | 0.754 | 4.57 mph | 5.89 mph | speed |
| 120 s | — | 4.61 | 4.72 | tie |
| 300 s | — | 5.43 | 3.61 | route average |

So the number is informative for about two minutes and anti-informative past
that. Riders usually wait longer than that, which is why **it must never feed
the ETA** — the ETA's own median error is 1.26 min and this would not improve
it. It answers exactly one question honestly: *is my bus crawling right now?*

The failure mode to respect: a bus stopped at a light reads 0 mph while its
ETA is fine, and the raw signal produces that reading spuriously 21% of the
time. Hence the window, and hence "stopped" only from the window.

## If it is built, the smallest honest version

Server-side, not in the browser: `/api/buses` carries no per-bus timestamp,
and the client poll drops to 30 s when the tab is hidden, so a browser-side
window would start cold and degrade in a background tab.

- `src/collector/collector.ts` already keys per-vehicle state through
  `planTracks`, which is the identity-safe key (see the `bus_id` invariant in
  CLAUDE.md). Add a small ring buffer per track; expose `speedMph` from
  `getLiveBuses()`; emit it in the bus mapping in `src/server/v1compat.ts`.
- Compute path distance ÷ elapsed over the trailing ≥25 s. Return **null**,
  not 0, when any gap in the window exceeds 20 s or the track key changed.
- Display rounded to 5 mph. Say "stopped" only when the whole window is under
  2 mph, never from a single poll.
- Never claim it is the vehicle's speedometer — upstream sends no speed field.
  Never let it feed an ETA. Never reuse `stationary`, which means
  `at_stop_id != null`, i.e. "at a stop", not "not moving".

One more thing the investigation turned up: the feed carries a GPS fix time,
`lastUpdate`, which `src/collector/upstream.ts` parses and then discards. It
is a useful staleness flag — the fix is frozen on 25% of samples — but not a
cure: another 26.8% read 0 mph with a *fresh* timestamp, a third of those
while moving.
