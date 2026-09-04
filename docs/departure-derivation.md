# The departure instant, derived: stand, drive and hold from positions

**Status: derived and validated offline over the archived corpus, 2026-09-03.
Nothing rider-visible changes.** The reducer (`services/shuttle-v2/src/collector/departure.ts`)
is the collector's code, run over `~/shuttle-captures/positions-*.jsonl` by
`scripts/eta-replay/departure-replay.ts`. The collector now runs the same
reducer live and persists its events to `stop_visits` and `legs` (migration
`0010`), retained with `arrivals`/`segments`; every figure below is from the
offline run, made before that wiring touched anything.

Corpus: 119,736 unique `raw_positions` (the two capture files re-dump the
retention window, de-duplicated on `(bus_id, collected_at)`), 8,635 polls,
09:51–21:57 ET on Thursday 2026-09-03, 22 buses, 13 routes. Stops and routes
from a production snapshot taken 17:36 ET; where that snapshot's `arrivals`
overlap the capture, the replayed detector reproduces production's own events
on **98.1%** of arrivals, so everything below is about production's anchors.

Reproduce:

```bash
cd services/shuttle-v2
REPLAY_DB=./store/snap2.db npx tsx scripts/eta-replay/departure-replay.ts
#  -> scripts/.eta-replay/departures.md, departures.json, departure-tables.json
```

The deliverable tables — per-stop `stand` quantiles and per-hop `drive`, for
every stop and hop, on three clocks — are checked in as
`docs/data/departure-tables-2026-09-03.json`.

---

## The gap this closes

`detector.ts` measures one interval per anchor transition — arrival at A to
arrival at B — and emits it twice, as `DwellEvent.dwellSec` and as
`SegmentEvent.travelSec` (`docs/eta-error-budget.md`; 119,329 of 119,329
joined rows identical). Nothing in either table says when the bus **left** A.
So `segments.travel_sec` on a layover hop is a layover with a hop stapled to
it, and the moment `at_stop_id` clears the client prorates that whole number
over the metres — the departure cliff (`docs/eta-estimator-design.md`).

The operator's case: **Red, 344 Winchester → Winchester / Division, 112 m,
served today as one number (median 380 s in this corpus, 557 s calibrated).**

Quantiles are p5/p10/p20/p30/p40/p50/p60/p70/p80/p90/p95. Written to `scripts/.eta-replay/departure-tables.json` for every stop and hop, on all three clocks.

| clock | stand n | mean | sd | stand quantiles (s) | drive n | mean | sd | drive quantiles (s) |
|---|---|---|---|---|---|---|---|---|
| pinned (at_stop_since → plateau end) | 24 | 327.2 | 177.3 | 118.1 136.5 145.1 176.5 242 302.8 386.3 451.6 479.6 566.5 598.1 | 25 | 17.1 | 4.8 | 10 10.1 14 15 15 15.1 20 20 20.1 23.2 25.1 |
| clear (at_stop_since → at_stop clears) | 24 | 340.5 | 177 | 134.3 155 158 191.5 253.1 315.3 398.3 466.6 492.6 579.1 609.8 | 25 | 4 | 2.1 | 0 0 3.9 5 5 5 5.1 5.1 5.1 5.1 5.2 |
| rest (first rest → plateau end) | 24 | 323.7 | 175.7 | 113.8 134.9 140.1 176.5 242 302.8 382.4 450.6 470 565.5 594.8 | 25 | 21.8 | 4.4 | 15 16.9 19.9 20 20 20.1 20.2 25 25.1 28.1 30 |

P(stop) at 344 Winchester 0.96 over 25 passes; hold on the hop: mean 0 s, P(hold>0) 0. Today the hop is served as one number: travel_sec median 380.1 s.

Read the row the consumer wants. PR #81 conditions on `r = now − at_stop_since`,
so its `stand` is the *pinned* or *clear* clock, not the physical one; on that
clock the hop's drive is **17 s** (plateau end → `at_stop_since` at the next
stop) or **4 s** (from the moment `at_stop` clears — the two 75 m radii overlap
on a 112 m hop, so the bus is often pinned at Winchester / Division before it
has cleared 344 Winchester; those legs are reported as 0, not dropped). Against
a served 557 s, that is the whole cliff.

Short drives are never floored or discarded: a leg is dropped only when it is
≤ 0 s, over 45 min (`MAX_SEGMENT_SEC`), or more than 5 hops.

| bus | anchored | to | travel_sec | visit | approach | stand | drive | hold | how | rest polls | shuffles |
|---|---|---|---|---|---|---|---|---|---|---|---|
| #304 | 10:04 | Winchester / Division | 190.2 | stopped | 30 | 140.1 | 20.1 | 0 | next | 8 | 2 |
| #309 | 10:23 | Winchester / Division | 628.8 | stopped | 20.1 | 593.5 | 20.2 | 0 | next | 9 | 2 |
| #316 | 10:37 | Winchester / Division | 516.2 | stopped | 40.4 | 455.8 | 30 | 0 | next | 5 | 4 |
| #304 | 10:58 | Winchester / Division | 345.1 | stopped | 15 | 315 | 20.1 | 0 | next | 6 | 2 |
| #309 | 11:28 | Winchester / Division | 325.6 | stopped | 20 | 290.6 | 19.8 | 0 | next | 7 | 3 |
| #316 | 11:38 | Winchester / Division | 462 | stopped | 25 | 421.9 | 19.8 | 0 | next | 8 | 2 |
| #304 | 12:00 | Winchester / Division | 310 | stopped | 20.1 | 270 | 25 | 0 | next | 7 | 3 |
| #309 | 12:21 | Winchester / Division | 732.4 | stopped | 31.8 | 680.7 | 24.9 | 0 | next | 8 | 2 |
| #316 | 12:33 | Winchester / Division | 675.1 | passed | 665 | 0 | 15 | 0 | next | 0 | 0 |
| #304 | 13:01 | Winchester / Division | 380.1 | stopped | 220 | 140.1 | 25.2 | 0 | next | 6 | 2 |
| #309 | 13:26 | Winchester / Division | 695.3 | stopped | 535.1 | 135 | 25.1 | 0 | next | 6 | 4 |
| #316 | 13:34 | Winchester / Division | 690.2 | stopped | 210 | 460.1 | 25.1 | 0 | next | 7 | 2 |
| #304 | 13:53 | Winchester / Division | 630.1 | stopped | 15.1 | 595 | 25 | 0 | next | 8 | 2 |
| #309 | 14:29 | Winchester / Division | 180 | stopped | 25.2 | 134.8 | 20.1 | 0 | next | 6 | 2 |

25 segments (stopped 24, passed 1): travel_sec median 380.1; approach (anchor → rest, mostly the yard beyond 75 m) median 20 (p90 216); stand median 290.6 (p10 120, p90 556.2); drive median 20.1 (p10 16.9, p90 28.1); hold mean 0.

Two things in that table matter beyond the split itself:

- **`approach` is the yard.** 344 Winchester is a depot; buses park up to
  215 m from the stop. A visit whose bus rested *outside* 75 m before pulling
  in shows the yard wait as `approach` (anchor → first rest inside the
  radius), and the derivation books that time as a **hold in the inbound leg**
  (Canal / Munson → 344 Winchester: P(hold > 0) 12.5%, hold given hold 395 s)
  rather than as stand. That is the 75 m definition production already uses
  for `at_stop`, applied consistently — a rider at the kerb cannot board a bus
  parked in the yard — and the model lane should know that the layover's
  distribution is split between the two according to where the driver parks.
- **`shuffles`** — nearly every 344 Winchester visit repositions two or three
  times before it leaves. `departedAt` is the end of the *last* plateau, and
  `firstMovedAt` is recorded beside it for anyone who wants the other
  convention.

---

## The definition

One reducer, `stepVisit`, over `(previous visit state, detector state before
and after, observation)`, driven by `stepManyWithVisits`, which calls the same
`step` the collector calls today and returns its events unchanged (a test pins
this). Per pass of a stop it emits a **visit**; per hop a **leg**.

| instant | definition |
|---|---|
| `anchoredAt` | the detector's arrival at this anchor — `arrivals.arrived_at`, the join key |
| `pinnedAt` | first poll within `AT_STOP_PIN_M` (75 m) of the stop while anchored there — production's `at_stop_since` |
| `arrivedAt` | start of the **first resting plateau** inside the radius: the poll on which the coordinate that then repeated was first reported. The roll-in is motion and belongs to the leg. A bus that never rests inside the radius has `arrivedAt = departedAt` at its closest approach |
| `departedAt` | end of the **final resting plateau**: the last poll before the run of fresh fixes that carried the bus away. Backdated from the confirming poll to where the movement began (PR #57's pattern) |

`stand = departedAt − arrivedAt`. Both ends are quantised by the same
~30 m deadband, so the stand is unbiased to within a poll.

**Outcomes.** `stopped` — rested at least `MIN_DWELL_SEC` (15 s, three
repeated polls at the feed's jittered cadence); `passed` — rolled through, or
never came within 75 m (`closestM` says how far); `unresolved` — the track
broke before the bus was seen leaving (`lastAtRestAt` bounds the stand from
below). A skipped stop is an outcome, not a 0 s stand: the stand quantiles
below are over stopped visits only, with P(stop) beside them.

**Candidates and confirmation.** A fresh fix after the bus has rested opens a
candidate; the next polls decide it. A parked bus does not drift, but it
shuffles, and a shuffle's first fix is the same 30 m quantum as a departure's,
so:

- it refreezes inside 75 m for three polls → a **shuffle**; the plateau
  restarts there (`shuffles` counts, `firstMovedAt` keeps the first move);
- it reaches `DEPART_FAR_M` (150 m) → **`far`**, confidence 1;
- the detector pins it at a **different** stop → **`next`**, confidence 1;
- the detector's stationary clock restarts without a stop (its 125 m radius)
  → **`clock`**, confidence 0.96 (`docs/layover-clock.md`: 34 false restarts
  in 879 visits);
- the track breaks with the candidate open → **`gap`**, confidence from the
  measured table below.

A single repeated fix inside the outbound run is **not** a shuffle: a bus
pulling out under 6 m/s cannot clear the deadband every poll (16% of running
polls repeat), and calling each one a stop split a departure into a shuffle
plus a departure ten seconds late — the first draft did exactly that and
reported a shuffle on 94% of visits. Every threshold that means "long enough to
be standing" allows one second of poll jitter, because three repeats can span
14.6 s and a real refreeze slipped through on the VA loop until they did.

**Legs.** From `departedAt` at A (its closest approach, when passed) to
`arrivedAt` at B (its closest approach, when passed). `hold` = seconds in
frozen runs of ≥ 15 s between the two — a light, a queue, a yard;
`drive = leg − hold`. Hops come from the detector's own sequence indices, so
the West Campus out-and-backs (routes 9 and 10 list stops twice) are indexed
by position, never by `stops.indexOf(id)`.

**Identity.** Keyed like the detector (`bus_name`, qualified by id only while
contended), reconciled with the same plan. A visit carries `anchorBusId`, the
id in force at the anchor, because an id reissue mid-layover is routine and the
`arrivals` row it joins to was written under the old one.

---

## Validation

Candidates (a fresh fix after the bus had rested at a stop): 4575 — far 788, next 849, clock 1756, shuffle 1179, gap 3.

| k outbound polls | candidates reaching k (decided) | departures | shuffles | P(departure) |
|---|---|---|---|---|
| 1 | 4572 | 3393 | 1179 | 74.2 |
| 2 | 3739 | 3254 | 485 | 87.0 |
| 3 | 2987 | 2840 | 147 | 95.1 |
| 4 | 2045 | 2006 | 39 | 98.1 |
| 5 | 1097 | 1078 | 19 | 98.3 |
| 6 | 345 | 341 | 4 | 98.8 |

After a plateau of ≥ 60 s (the measured gate): 600 candidates — departures 426 (71.0%), shuffles 172 (28.7%), cut off 2 (0.3%).
Where a shuffle preceded the exit, seconds from the first movement to the final plateau's end: p10/p50/p90 19.8/40.2/312.7 (n 947).
First step (m): departures p10/p50/p90 30.4/32.3/36.6; shuffles 30.2/31.4/34.3 (n 4572).
Seconds from first fresh fix to confirmation: p50 15.2, p90 45.3, max 680.6.
Stopped visits with ≥ 1 shuffle before leaving: 947 of 2560 (37.0%).

The brief's gate (775 production cases: 66% departure, 14% shuffle, 20%
ambiguous) is reproduced in kind — after a ≥ 60 s plateau 71% of first fresh
fixes are departures and 29% shuffles, with the "ambiguous" fifth resolved by
waiting — and the second and third polls carry the decision: 74% → 87% → 95%.
Those measured shares are `DEPARTURE_PRIOR_BY_STEPS` in the reducer, the
confidence written on a departure cut off by a feed break.

Against the walk-back (first movement that never comes back closer): compared 2551 stopped departures (4 never reached 250 m before the horizon). reducer − walk-back: identical 42.9%, within one poll 53.7%, p10/p50/p90 -15.1/0/30 s, later by > 60 s: 100. The reducer dates a departure from the END of the last plateau, the walk-back from the first outward shuffle that was never undone; the gap between them is the shuffle-to-exit interval above.
Against the retrospective last plateau (same definition, computed after the fact): n 2488, identical 98.9%, within one poll 98.9%, p10/p50/p90 0/0/0 s, |lag| > 30 s: 27.

Two checks on the instant. Against the **retrospective last plateau** — the
reducer's own definition recomputed after the fact from the raw track, with no
candidate machinery — the online reducer is identical on 98.9% of stopped
departures; the residue is a handful of long yard excursions. Against the
layover doc's **walk-back** (the first outward move never undone) it differs by
design: that convention dates a departure from the first shuffle, this one from
the end of the last plateau, and the gap between them is the shuffle-to-exit
interval (p50 40 s, p90 313 s over the 37% of stopped visits with a shuffle).
The model should take the last plateau: the bus is still standing, and a rider
at the kerb can still board.

**Hold**, recomputed independently from the raw track outside the reducer,
agrees on 100% of legs; with a 25 s minimum run instead of 15 s the hold mean
moves 20 → 17 s and P(hold > 0) 30% → 22%, so the split is not fragile to that
choice. **Decomposition identity**: `approach + stand + rest = travel_sec`
holds exactly on all 3,777 decomposed segments (0 failures).

| route | passes | stopped | passed (never ≤75 m) | passed (rolled through) | unresolved | far | next | clock | gap |
|---|---|---|---|---|---|---|---|---|---|
| Blue Day | 873 | 642 | 10 | 218 | 3 | 232 | 250 | 377 | 1 |
| Orange Day | 520 | 378 | 2 | 138 | 2 | 78 | 228 | 210 | 0 |
| Red | 718 | 485 | 2 | 231 | 0 | 160 | 195 | 361 | 0 |
| Blue Weekend | 4 | 0 | 2 | 2 | 0 | 1 | 0 | 1 | 0 |
| Pink | 335 | 206 | 27 | 102 | 0 | 92 | 54 | 160 | 2 |
| Green | 504 | 199 | 48 | 254 | 3 | 103 | 151 | 199 | 0 |
| Purple | 533 | 202 | 103 | 226 | 2 | 125 | 50 | 252 | 1 |
| Blue Night | 177 | 108 | 10 | 58 | 1 | 43 | 25 | 98 | 0 |
| Orange Night | 242 | 159 | 1 | 79 | 3 | 48 | 62 | 127 | 1 |
| Gold | 134 | 65 | 0 | 68 | 1 | 37 | 31 | 64 | 1 |
| Blue West | 66 | 32 | 0 | 34 | 0 | 25 | 6 | 35 | 0 |
| Orange East | 84 | 37 | 12 | 35 | 0 | 15 | 14 | 43 | 0 |
| Brown | 89 | 47 | 9 | 33 | 0 | 17 | 0 | 63 | 0 |
| **all** | 4279 | 2560 | 226 | 1478 | 15 | 976 | 1066 | 1990 | 6 |

Departures (visits with a departure instant): 4038; of which stopped ≥ 15 s: 2560.

---

## Red, in full

Route 3, 31 stops, three buses, 718 passes. `P(stop)` is the share of decided
passes with a rest of ≥ 15 s; the next column is the priors lane's "≥ 15 s
inside 75 m", which is **not the same thing** — see Winchester / Sachem, where
80% of passes spend 15 s inside the radius (it takes three polls to cross
150 m of it at 7 m/s) and 12% actually stop. Quantiles are of `stand` on the
rest clock; the pinned and clear clocks for every stop are in the JSON.

| idx | stop | passes | stopped | P(stop) % | P(≥15 s inside 75 m) % | stand p10 | p25 | p50 | p75 | p90 | mean |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 0 | Union Station (N) [0] | 26 | 26 | 100.0 | 100.0 | 106.6 | 336.3 | 439.3 | 538.5 | 660 | 417.5 |
| 1 | State St Station [1] | 25 | 24 | 96.0 | 100.0 | 31.6 | 54 | 76.6 | 121.4 | 144.6 | 86.2 |
| 2 | Court / Olive [2] | 25 | 14 | 56.0 | 100.0 | 15 | 16.2 | 27.5 | 62.6 | 91 | 46.8 |
| 3 | Olive / Chapel [3] | 25 | 20 | 80.0 | 100.0 | 25 | 30 | 52.4 | 71.2 | 84.9 | 61.5 |
| 4 | Chapel / Church [4] | 25 | 22 | 88.0 | 100.0 | 24.9 | 31.5 | 47.6 | 69.8 | 89.7 | 53.7 |
| 5 | Chapel / College [5] | 25 | 16 | 64.0 | 96.0 | 15.1 | 28.7 | 49.9 | 54.8 | 60.1 | 42.8 |
| 6 | College / Wall (N) [6] | 24 | 23 | 95.8 | 100.0 | 15 | 17.5 | 24.8 | 37.7 | 54 | 31.3 |
| 7 | Wall / Church [7] | 22 | 12 | 54.5 | 100.0 | 25 | 25 | 32.5 | 37.8 | 40 | 32.7 |
| 8 | Church / Grove [8] | 22 | 12 | 54.5 | 81.8 | 25.5 | 37.3 | 47.5 | 50 | 50.1 | 42.5 |
| 9 | Whitney / Audubon [9] | 22 | 8 | 36.4 | 100.0 | 15 | 15 | 15.1 | 31.1 | 77.1 | 39.4 |
| 10 | Trumbull / Hillhouse [10] | 24 | 19 | 79.2 | 91.7 | 20.1 | 30 | 39.9 | 49.9 | 56.1 | 38.7 |
| 11 | 130 Prospect Street (N) [11] | 25 | 18 | 72.0 | 100.0 | 18.5 | 31.6 | 37.6 | 60.3 | 76 | 45.6 |
| 12 | Winchester / Sachem [12] | 25 | 3 | 12.0 | 80.0 | 14.9 | 14.9 | 15 | 15.1 | 15.1 | 15 |
| 13 | Canal / Munson [13] | 25 | 22 | 88.0 | 96.0 | 26 | 46.2 | 77.6 | 115.2 | 125.3 | 108.7 |
| 14 | 344 Winchester [14] | 25 | 24 | 96.0 | 96.0 | 134.9 | 143.9 | 302.8 | 456.8 | 565.5 | 323.7 |
| 15 | Winchester / Division [15] | 25 | 8 | 32.0 | 84.0 | 15.1 | 18.7 | 22.5 | 26.4 | 34.4 | 24.4 |
| 16 | Division / Sheffield [16] | 25 | 4 | 16.0 | 64.0 | 15 | 15 | 15.1 | 16.4 | 18.6 | 16.3 |
| 17 | Division / Prospect [17] | 25 | 22 | 88.0 | 100.0 | 20.1 | 26.2 | 35.1 | 55 | 64.5 | 40.5 |
| 18 | Prospect / Hillside [18] | 25 | 22 | 88.0 | 100.0 | 30.9 | 69.9 | 82.6 | 118.7 | 130.3 | 90 |
| 19 | SCL [19] | 25 | 8 | 32.0 | 92.0 | 14.9 | 15 | 15 | 16.4 | 21.5 | 16.9 |
| 20 | 130 Prospect Street (S) [20] | 25 | 16 | 64.0 | 100.0 | 15 | 18.7 | 20.2 | 26.4 | 37.4 | 24.1 |
| 21 | College / Wall (S) [21] | 25 | 20 | 80.0 | 100.0 | 23.7 | 25 | 37.5 | 54.9 | 105.6 | 47.5 |
| 22 | Phelps Gate [22] | 25 | 19 | 76.0 | 100.0 | 15 | 15.1 | 40.1 | 65.1 | 85 | 44.7 |
| 23 | College / Crown [23] | 25 | 20 | 80.0 | 96.0 | 24.3 | 30 | 37.5 | 58 | 70.3 | 50.8 |
| 24 | College / George [24] | 25 | 25 | 100.0 | 100.0 | 26.8 | 40.1 | 75 | 109.9 | 140.9 | 84.6 |
| 25 | LEPH / 60 College [25] | 25 | 15 | 60.0 | 92.0 | 15 | 15.3 | 25 | 42.6 | 57.9 | 31.4 |
| 26 | Gilbert / Cedar [26] | 26 | 22 | 84.6 | 100.0 | 20.6 | 26.5 | 50.1 | 63.7 | 88.5 | 50.2 |
| 27 | Amistad / Cedar [27] | 26 | 2 | 7.7 | 80.8 | 15.9 | 17.4 | 19.9 | 22.4 | 23.9 | 19.9 |
| 28 | Amistad / Church St South [28] | 26 | 19 | 73.1 | 96.2 | 29 | 42.5 | 55.1 | 85.1 | 116.1 | 71.6 |

Union Station (N) [0] and 344 Winchester [14] are the two layovers; State St
Station and Prospect / Hillside are the next tier. Winchester / Sachem, Amistad
/ Cedar, Division / Sheffield, SCL and Winchester / Division are skipped more
often than not.

| from idx | hop | hops | n | drive mean | sd | p10 | p50 | p90 | hold mean | P(hold>0) % | hold | >0 | leg mean |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 0 | Union Station (N) → State St Station | 1 | 25 | 112.1 | 11.3 | 95 | 113 | 128 | 45.2 | 88.0 | 51.4 | 157.4 |
| 1 | State St Station → Court / Olive | 1 | 25 | 55.4 | 8.9 | 45.2 | 54.9 | 68 | 21.7 | 48.0 | 45.2 | 77.1 |
| 2 | Court / Olive → Olive / Chapel | 1 | 25 | 14.8 | 7.7 | 5 | 14.9 | 20.1 | 0 | 0.0 | - | 14.8 |
| 3 | Olive / Chapel → Chapel / Church | 1 | 25 | 74.2 | 12.9 | 57.2 | 74.8 | 90.1 | 56.1 | 88.0 | 63.7 | 130.3 |
| 4 | Chapel / Church → Chapel / College | 1 | 25 | 43.7 | 10.5 | 30 | 45.2 | 57.9 | 13.2 | 40.0 | 32.9 | 56.8 |
| 5 | Chapel / College → College / Wall (N) | 1 | 24 | 59.7 | 9.3 | 50 | 60.1 | 70.1 | 30.2 | 70.8 | 42.7 | 89.9 |
| 6 | College / Wall (N) → Wall / Church | 1 | 22 | 46.5 | 8.1 | 35 | 47.6 | 55.1 | 5.2 | 22.7 | 22.9 | 51.8 |
| 7 | Wall / Church → Church / Grove | 1 | 22 | 18.2 | 3.7 | 15 | 19.9 | 20.2 | 0 | 0.0 | - | 18.2 |
| 8 | Church / Grove → Whitney / Audubon | 1 | 22 | 26.4 | 8.6 | 15 | 25 | 39.5 | 0 | 0.0 | - | 26.4 |
| 9 | Whitney / Audubon → Trumbull / Hillhouse | 1 | 22 | 48 | 12 | 30.6 | 45.6 | 64.4 | 47.9 | 95.5 | 50.2 | 95.9 |
| 10 | Trumbull / Hillhouse → 130 Prospect Street (N) | 1 | 24 | 44.7 | 12.5 | 29.8 | 46.6 | 60 | 22.9 | 45.8 | 50 | 67.6 |
| 11 | 130 Prospect Street (N) → Winchester / Sachem | 1 | 25 | 32.4 | 10.3 | 20.1 | 30 | 45 | 3.6 | 8.0 | 45 | 36 |
| 12 | Winchester / Sachem → Canal / Munson | 1 | 25 | 96.6 | 13.1 | 80.1 | 99.9 | 113 | 12.4 | 52.0 | 23.9 | 109 |
| 13 | Canal / Munson → 344 Winchester | 1 | 24 | 54.8 | 21.5 | 39.9 | 45.1 | 70 | 49.4 | 12.5 | 395.2 | 104.2 |
| 14 | 344 Winchester → Winchester / Division | 1 | 25 | 21.8 | 4.4 | 16.9 | 20.1 | 28.1 | 0 | 0.0 | - | 21.8 |
| 15 | Winchester / Division → Division / Sheffield | 1 | 25 | 15.6 | 4.1 | 10.1 | 15 | 20 | 0 | 0.0 | - | 15.6 |
| 16 | Division / Sheffield → Division / Prospect | 1 | 25 | 29.4 | 3.9 | 24.9 | 30 | 35.1 | 0 | 0.0 | - | 29.4 |
| 17 | Division / Prospect → Prospect / Hillside | 1 | 24 | 48.4 | 10.6 | 35.1 | 50 | 60.2 | 23.9 | 29.2 | 82 | 72.3 |
| 18 | Prospect / Hillside → SCL | 1 | 25 | 39.5 | 8.8 | 30.1 | 39.9 | 50.1 | 2.2 | 8.0 | 27.5 | 41.7 |
| 19 | SCL → 130 Prospect Street (S) | 1 | 25 | 47.3 | 12.3 | 35 | 45 | 68.9 | 17 | 56.0 | 30.4 | 64.3 |
| 20 | 130 Prospect Street (S) → College / Wall (S) | 1 | 25 | 72.5 | 14.2 | 59.9 | 74.8 | 88 | 42.1 | 92.0 | 45.7 | 114.6 |
| 21 | College / Wall (S) → Phelps Gate | 1 | 25 | 46 | 11.7 | 32.3 | 44.8 | 64.1 | 29.2 | 68.0 | 42.9 | 75.2 |
| 22 | Phelps Gate → College / Crown | 1 | 25 | 38.7 | 8.7 | 30 | 40 | 50.1 | 19.6 | 44.0 | 44.6 | 58.3 |
| 23 | College / Crown → College / George | 1 | 25 | 16.2 | 6.5 | 9.9 | 15 | 23.1 | 0 | 0.0 | - | 16.2 |
| 24 | College / George → LEPH / 60 College | 1 | 25 | 30.3 | 10.1 | 20 | 30 | 42 | 32.5 | 68.0 | 47.8 | 62.8 |
| 25 | LEPH / 60 College → Gilbert / Cedar | 1 | 25 | 33.6 | 8.6 | 25 | 30 | 48.5 | 3.2 | 12.0 | 26.6 | 36.8 |
| 26 | Gilbert / Cedar → Amistad / Cedar | 1 | 26 | 40.6 | 11.7 | 27.6 | 40.1 | 57.4 | 0 | 0.0 | - | 40.6 |
| 27 | Amistad / Cedar → Amistad / Church St South | 1 | 26 | 23.5 | 6.3 | 15.2 | 22.6 | 30.1 | 0 | 0.0 | - | 23.5 |
| 28 | Amistad / Church St South → Union Station (N) | 1 | 26 | 80.6 | 8.8 | 70 | 80 | 91.8 | 24.4 | 65.4 | 37.3 | 105 |

`drive` is tight on nearly every hop — a standard deviation of 4–14 s against
`travel_sec`'s 87 s within-hop — and `hold` is where the mid-leg variance
lives: Olive / Chapel → Chapel / Church holds on 88% of traversals (the
downtown lights), Whitney / Audubon → Trumbull / Hillhouse on 95%.

---

## What the arrival-to-arrival segment contains

3868 segments: decomposed 3783 (97.8%), pass-through at A (no stand) 76 (2.0%), still standing at A when the anchor moved on 9 (0.2%), unresolved 0, no matching visit 0. Identity approach + stand + rest = travel_sec failed on 0.

- approach(A), anchor → 75 m of A: n 3783, mean 34.2, sd 71.1, p10/p50/p90 4.9/15/75
- stand(A): n 3783, mean 55, sd 119.7, p10/p50/p90 0/20.1/99.8
- rest, departure → anchor at B: n 3783, mean 45.5, sd 60.4, p10/p50/p90 10.1/25/100
- travel_sec of those segments: n 3783, mean 134.8, sd 163.8, p10/p50/p90 30/85/279.7
- kerb leg A → B (drive + hold): n 3770, mean 76.9, sd 103.9, p10/p50/p90 19.9/44.9/160.1
- residual travel_sec − (stand + leg) = approach(A) − approach(B): n 3770, mean 2.8, sd 87.1, p10/p50/p90 -40.3/0/45.1

Variance of travel_sec across decomposed segments: 26827.9 s²; of stand alone 14326 (53.4%), of rest 3646.7 (13.6%), of approach 5058.4 (18.9%); stand's share of a segment's seconds: mean 31.9%, p90 70.8%.

Within-hop (about each hop's own mean, 3541 dof): travel_sec sd 87.4 s; stand alone accounts for 77.9% of that variance, the kerb leg (drive + hold) for 24.5%.

Two readings of that. Across segments, `travel_sec` is `approach + stand +
rest` by identity, and the kerb-to-kerb leg differs from `stand + rest` by
`approach(A) − approach(B)`: mean 3 s, sd 87 s, median 0 — the two reference
points (the detector's midpoint anchor and the 75 m radius) are the same on
average and differ per segment by the roll-in. **Within a hop, stand alone is
78% of `travel_sec`'s variance** (the error budget's 72.5% by a different
method); the leg — drive and hold together — is 25%. That is the residual the
current model has been absorbing blindly, and it is almost entirely the
standing time at the origin stop.

---

## Stopped versus passed through

| route | stop [index] | passes | stopped | P(stop) % | P(≥15 s inside) % | stand p10 | p25 | p50 | p75 | p90 | mean |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Purple | West Haven Train Station [4] | 59 | 9 | 15.3 | 83.1 | 19.2 | 24.9 | 30 | 30.1 | 66 | 41.7 |
| Purple | Union Station (S) [3] | 57 | 8 | 14.0 | 21.1 | 21.9 | 25.1 | 52.6 | 127.9 | 177.6 | 85.2 |
| Pink | VA Entrance Outbound [8] | 52 | 35 | 67.3 | 94.2 | 21.9 | 32.6 | 54.9 | 62.4 | 82.9 | 51.7 |
| Purple | 100 Church Street South [2] | 51 | 4 | 7.8 | 13.7 | 18 | 22.5 | 40 | 56.2 | 58.6 | 38.8 |
| Purple | LEPH / 60 College [14] | 46 | 24 | 52.2 | 69.6 | 15 | 15.1 | 29.1 | 55 | 87.5 | 40.7 |
| Green | West Haven Train Station [18] | 39 | 8 | 20.5 | 87.2 | 29.2 | 39 | 235.1 | 393.8 | 465.3 | 238.9 |
| Green | Building 900 [19] | 39 | 14 | 35.9 | 76.9 | 15 | 15.2 | 22.7 | 33.8 | 43.4 | 27.6 |
| Green | Orange / Bradley (N) [20] | 39 | 4 | 10.3 | 38.5 | 16.4 | 18.7 | 29.9 | 40 | 40.1 | 28.7 |
| Green | Orange / Pearl (N) [21] | 39 | 6 | 15.4 | 43.6 | 15 | 16.3 | 20 | 23.8 | 29.9 | 21.7 |
| Purple | 300 George St [1] | 33 | 24 | 72.7 | 78.8 | 36.5 | 50 | 67.5 | 92.7 | 157.2 | 83.4 |
| Blue Day | College / Wall (N) [28] | 30 | 27 | 90.0 | 96.7 | 20 | 27.6 | 34.9 | 49.9 | 71.3 | 39.6 |
| Blue Day | Prospect / Canner [4] | 30 | 22 | 73.3 | 86.7 | 15 | 19.9 | 20 | 24.9 | 39 | 23 |
| Blue Day | Huntington / Edgehill (E) [7] | 30 | 9 | 30.0 | 83.3 | 15 | 15 | 20 | 29.9 | 34 | 24.4 |
| Blue Day | Prospect / Trumbull [30] | 30 | 21 | 70.0 | 96.7 | 19.9 | 25 | 35 | 50.1 | 65.3 | 39.9 |
| Blue Day | Prospect / Edwards [2] | 30 | 23 | 76.7 | 96.7 | 30.2 | 50 | 70 | 105 | 140 | 79.4 |
| Purple | Building 400 [9] | 29 | 19 | 65.5 | 93.1 | 19 | 47.5 | 114.9 | 237.5 | 324.1 | 193 |
| Blue Day | 129 York [25] | 29 | 22 | 75.9 | 93.1 | 15 | 22.5 | 45.1 | 74.9 | 93.4 | 49.8 |
| Blue Day | Prospect / Highland (N) [5] | 29 | 21 | 72.4 | 89.7 | 20 | 34.8 | 40.1 | 70 | 165 | 120.3 |
| Purple | Building 600 [10] | 29 | 12 | 41.4 | 89.7 | 20.5 | 25.2 | 32.4 | 42.5 | 50.2 | 34.2 |
| Purple | Building 750 [11] | 29 | 0 | 0.0 | 72.4 | - | - | - | - | - | - |
| Blue Day | 180 York (A&A) [26] | 29 | 23 | 79.3 | 96.6 | 15 | 19.9 | 30 | 60 | 77.9 | 42.3 |
| Purple | Building 800 [12] | 29 | 20 | 69.0 | 96.6 | 15 | 15.1 | 22.6 | 30 | 47.5 | 42 |
| Purple | Building 900 [13] | 29 | 8 | 27.6 | 79.3 | 23.5 | 25 | 27.5 | 37.5 | 46.4 | 31.9 |
| Blue Day | Elm / York [27] | 29 | 26 | 89.7 | 100.0 | 39.8 | 45 | 52.6 | 88.8 | 114.8 | 66 |
| Blue Day | Becton / 15 Prospect [29] | 29 | 17 | 58.6 | 86.2 | 15 | 20 | 24.9 | 45 | 65.9 | 37.3 |
| Blue Day | Prospect / Sachem (N) [0] | 29 | 27 | 93.1 | 100.0 | 22.9 | 37.4 | 49.8 | 67.6 | 94 | 56 |
| Blue Day | Chemistry / 225 Prospect [1] | 29 | 11 | 37.9 | 75.9 | 15 | 15 | 19.9 | 20 | 29.8 | 20.4 |
| Blue Day | Divinity / 409 Prospect [3] | 29 | 23 | 79.3 | 93.1 | 15 | 15.1 | 20.1 | 25 | 33.1 | 21.8 |
| Blue Day | Phelps Gate [19] | 28 | 26 | 92.9 | 100.0 | 15 | 15.1 | 20.1 | 41.3 | 54.9 | 29.1 |
| Blue Day | College / Crown [20] | 28 | 18 | 64.3 | 85.7 | 23.5 | 31.2 | 45 | 53.7 | 69.5 | 48.9 |

(231 stops with ≥ 5 decided passes; all in the JSON.)

Stops skipped more often than not (P(stop) < 0.5, ≥ 5 passes): 72 of 202 — West Haven Train Station (Green) 0.2051; Orange / Pearl (S) (Orange Day) 0.4375; West Haven Train Station (Purple) 0.1525; SCL (Red) 0.32; Winchester / Sachem (Red) 0.12; Building 600 (Green) 0.4; Amistad / Cedar (Red) 0.07690000000000001; Whitney / Cottage (S) (Green) 0.15; Building 600 (Purple) 0.4138; Building 750 (Green) 0; Building 750 (Purple) 0; Chemistry / 225 Prospect (Orange Day) 0.1765; Audubon / Orange (Orange Day) 0.4375; Huntington / Edgehill (E) (Blue Day) 0.3; Building 900 (Purple) 0.2759; Building 900 (Green) 0.359; Whitney / Highland (Blue Day) 0.037; Davenport / Howard (Pink) 0.4815; Whitney / Cold Spring (S) (Blue Day) 0.2963; Building 600 (Green) 0.3158; Building 750 (Purple) 0; Union Station (S) (Purple) 0.1404; Foster / Cottage (Orange Day) 0.4; Chemistry / 225 Prospect (Blue Day) 0.3793; 100 Church Street South (Purple) 0.07840000000000001; Winchester / Sachem (Brown) 0.22219999999999998; Building 600 (Purple) 0.39289999999999997; 130 Prospect Street (S) (Brown) 0.22219999999999998; Orange / Bishop (S) (Orange Day) 0.4667; College / Wall (S) (Brown) 0.2778; Phelps Gate (Brown) 0.44439999999999996; Quigley Stadium Outbound (Pink) 0.24; Winchester / Division (Red) 0.32; Division / Sheffield (Red) 0.16; Chapel / Dwight (Gold) 0.25; Orange / Bradley (N) (Green) 0.1026; Orange / Pearl (N) (Green) 0.15380000000000002; Howe / Edgewood (Gold) 0.25; Front / Rt 1 (S) (Pink) 0.48; Orange / Bishop (N) (Green) 0.10529999999999999; Orange / Lawrence (N) (Green) 0.10529999999999999; Orange / Avon (Green) 0.0526; Orange / Willow (N) (Green) 0.38889999999999997; VA Entrance Inbound (Pink) 0; Whitney / Audubon (Red) 0.36360000000000003; Olive / Lyon (Gold) 0.4167; Olive / Greene (Gold) 0; Olive / Wooster (Gold) 0.4167; Union Station (N) (Gold) 0.1667; Divinity / 409 Prospect (Brown) 0.25; Howard / Park (Blue West) 0.3333; Congress / Cedar (Orange Night) 0.1; Howe / Edgewood (Blue West) 0.1667; Olive / Lyon (Orange East) 0.1667; Temple / Grove (Blue Night) 0.3333; Ashmun / Lock (Blue West) 0.1667; Nicoll / Edwards (Orange East) 0.3333; Amistad / Cedar (Orange Night) 0.4; Eagle / Nash (Orange East) 0.1667; LEPH / 60 College (Blue Night) 0.4375; Whitney / Humphrey (N) (Orange Night) 0.44439999999999996; Pauli Murray College (Blue West) 0.3333; Phelps Gate (Blue West) 0.3333; Orange / Bishop (S) (Orange Night) 0.44439999999999996; Orange / Pearl (S) (Orange Night) 0.22219999999999998; Olive / Wooster (Orange East) 0.1667; Congress / Cedar (Blue Night) 0; Audubon / Orange (Orange Night) 0.44439999999999996; Union / Fair (Orange East) 0; Grove / Temple (Orange Night) 0.22219999999999998; Union Station (N) (Orange East) 0; Elm / York (TYCO) (Blue Night) 0.42860000000000004.

Sparsity, pooled over the day: stops with ≥5 stopped visits 177/235, ≥10 108. Per (stop, hour) cells: n≥5 in 3/1371, median n 2.

All stopped visits pooled (n 2560): stand p10/p25/p50/p75/p90/p99 15.1/24.9/40/70/150.3/708.6 s.

Two named checks, both of which came back with something the numbers alone
would not have said:

**VA Entrance Inbound (Pink).** The brief expected `stand ≈ 0, drive ≈ 42 s`.
The derivation reports 25 passes, none pinned — and the raw track shows why
that is not the whole story. Inbound (123) and Outbound (124) are a **35 m
twin pair** across the entrance road. #306 at 13:53 rests for 15 s **22 m from
Inbound and 13 m from Outbound**, with upstream's own `last_stop_id` saying
Inbound; the detector's lookahead anchors it at Outbound (index 8) the moment
that is a metre closer, skips VA Hospital (index 7), and later jumps back to
the hospital through the global fallback. So production's 4,501 arrivals at
Inbound with a 42 s interval are the 123 → 124 anchor hop, the bus's actual
rest at the entrance is credited to the twin, and "buses never stop at VA
Entrance Inbound" is partly an anchoring artefact of a twin pair 35 m apart.
The derivation cannot fix that — it inherits the detector's anchor, and it
should — but it makes it visible: the twin's stand and the hop's `reached`
flag say where the time went. `neverPinnedClosestM` in the JSON is the
distance a "passed" stop was actually passed at.

**Winchester / Sachem (Red)**: P(stop) 12%, "inside ≥ 15 s" 80%. The bus rolls
through at ~7 m/s and slows for one poll; that is a slowdown, not a stop, and
the per-stop table above keeps them apart.

Stops skipped more often than not (P(stop) < 0.5, ≥ 5 passes): 72 of 202. The
list is in `departures.md`; on Red it is Winchester / Sachem, Amistad / Cedar,
Division / Sheffield, SCL, Winchester / Division and Whitney / Audubon.

---

## Sparsity, and what is pooled

Stops with ≥ 5 stopped visits over the day: 177 of 235 (≥ 10: 108). Hops with
≥ 5 legs: 231 of 242 (≥ 10: 153). Traversals per hop per hour, median **1.3**
(the other lane's 1.42). Per (stop, hour) cells with n ≥ 5: **3 of 1,371**,
median 2; per (hop, hour): 9 of 1,769. So every table here is **pooled over
the whole service day** and carries its `n`; an hourly conditioning has
nothing to stand on from one day, and the model lane has already decided not
to condition on hour.

---

## Departure → next arrival at the same stop, against the client's headways

| route | n | gap p50 (min) | p10 | p90 | HEADWAY_MIN |
|---|---|---|---|---|---|
| Blue Day | 621 | 15.6 | 7.6 | 22.5 | 10 |
| Orange Day | 352 | 26 | 12.7 | 47.7 | 10 |
| Red | 464 | 17 | 8.9 | 30.5 | 8 |
| Pink | 199 | 16.5 | 8.7 | 23.3 | 20 |
| Green | 189 | 24.6 | 13.7 | 42.3 | 15 |
| Purple | 196 | 17.8 | 5.1 | 49.1 | 20 |
| Blue Night | 98 | 22.4 | 12.8 | 40.8 | 20 |
| Orange Night | 144 | 19 | 4.5 | 43.4 | 20 |
| Gold | 61 | 38.7 | 31.4 | 41.6 | 20 |
| Blue West | 23 | 39.4 | 36.9 | 41.1 | 20 |
| Orange East | 33 | 37.7 | 33.1 | 44.8 | 20 |
| Brown | 39 | 57.2 | 47.8 | 62.2 | 15 |

One-hop kerb-to-kerb leg medians (s): Blue Day 35 (n 856); Orange Day 34.9 (n 515); Red 47.9 (n 712); Blue Weekend 235 (n 1); Pink 55 (n 279); Green 30 (n 379); Purple 70.6 (n 370); Blue Night 55 (n 141); Orange Night 35.1 (n 236); Gold 110 (n 132); Blue West 100 (n 65); Orange East 104.8 (n 65); Brown 120.1 (n 69).

A sanity check on the instants that turned into a finding about the client:
the measured gap between a departure and the next bus at the same stop is
consistent with the operator's stated ~16 min Red headway — and **not with
`HEADWAY_MIN` in `web/src/schedule.ts`**, which says 8 for Red, 10 for Blue
Day and Orange Day (measured 15 and 26) and 15 for Brown (measured 57). That
table prices the wait for future-date planning as `headway / 2`; it is a
separate, rider-facing fix and is flagged here rather than made.

---

## What is delivered, and what is next

- `src/collector/departure.ts` — the reducer; `departure.test.ts` (25 tests,
  including that the detector's events are untouched, that short legs are
  kept, and that the West Campus indices are by position).
- `scripts/eta-replay/departure-replay.ts` — the offline run and every table
  here.
- `docs/data/departure-tables-2026-09-03.json` — per stop: `pStop`,
  `standPinned` / `standClear` / `standRest`, each `{n, mean, sd, q[11]}` at
  p5/10/20/30/40/50/60/70/80/90/95; per hop: `drivePinned` / `driveClear` /
  `driveRest`, `holdMean`, `pHold`, `overlapLegs`.

- `stop_visits` and `legs` (`src/db/schema.ts`, migration `0010`): the same
  events, written live by the collector — one `stepManyWithVisits` call in
  place of `stepMany` (the detector's events are returned unchanged and
  persisted exactly as before), one insert per event, a `pruneVisits` beside
  `pruneStale`. No write on the request path; a few hundred rows a day; 90-day
  retention beside `arrivals`/`segments`.

Next: once the live tables hold a week, re-measure `DEPARTURE_PRIOR_BY_STEPS`
and the per-stop tables from them instead of a replay, and give the
calibrator a `stand`/`drive` pair per hop to serve.

## Limits

- One Thursday, 09:51–21:57 ET. No weekend, no morning peak before 09:51, no
  bad weather; Blue Weekend appears for four passes.
- Arrival is the first rest **inside 75 m**; the roll-in from 75 m to the kerb
  (a poll or two) is in the leg. Where a stop's radius overlaps the next stop's
  (112 m apart, two 75 m radii) the detector's anchor decides which stop owns
  the rest, and a `clear`-clock drive can be 0.
- The derivation inherits the detector's anchor. Where that anchor is wrong
  (the VA twin pair; Green / Purple folds) the stand is credited to the
  anchored stop. That is the right behaviour for a table the current client
  will read, and the wrong one for ground truth — the model lane's branch
  mixture is where that gets fixed.
- `confidence` on `gap` visits is measured on this corpus by this reducer's
  own shuffle rule; it should be re-measured once the live table has a week.
