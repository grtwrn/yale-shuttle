# Does upstream's own ETA help ours? A measurement

**Question (operator, 2026-09-06):** "if we already have etas you can test if
they help?" — the official Downtowner app publishes a per-stop ETA
(`routes_eta.php`) that `src/collector/upstreamEta.ts` has logged into
`predictions_log` (`surface = "upstream"`) since 2026-09-04 15:07 ET. Does it
carry information the ring estimator lacks, and if so how should it enter —
as a likelihood term on the arrival distribution (design doc §1), or as the
direction / out-of-service evidence the filter has no source for?

**Status: measurement only. Nothing in the estimator changed.** Scripts are
`scripts/eta-replay/upstream-eta-*.ts`; raw outputs live under
`scripts/.eta-replay/upstream-eta/` (git-ignored, regenerable with the
commands at the end).

## The short answer

| | number | where it lives |
|---|---|---|
| Upstream alone, all rows paired to a detected arrival | **\|err\| p50 227 s**, ≤120 s 30.4%, bias +96 s (pessimistic) | Q1 |
| Same (bus, stop, moment), 31,810 pairs, all routes | ours **187 s** vs upstream 227 s; ≤120 s 38.2% vs 30.6% | Q2 |
| …the 26,029 pairs on routes the ring estimator prices | ours **154 s** vs upstream 223 s; ≤120 s 42.8% vs 31.1% | Q2 |
| …the 5,781 pairs on the legacy-arithmetic routes (Green, Grocery Ham) | ours 494 s vs upstream **236 s** | Q2 |
| Incremental information, ring routes, out of sample (fit one day, score another) | 0–2 min **0 s**, 2–5 min −5 s, 5–10 min −18 s, 10–30 min −31 s (shrink blend vs raw ours); full linear blend −1 s at every horizon | Q2 |
| Incremental information on Purple (the fold route) | full blend **+19 to +57 s** on the median, every fold; partial R² 0.09–0.11 | Q2 |
| Direction on a fold from upstream's ETA SET (Purple, Green) | right branch **85.5%** of ambiguous moments where it has evidence (80% of them); on STANDING moments — where the filter has nothing — 89% (Green) / 75% (Purple); heading decides only 17% / 40% of standing moments | Q3 |
| Out of service | upstream's rows stop **with** the feed, never before it: 0 of 31 last-appearances flagged at any lead; 100% of them carried promises past the end (1,062 rows) | Q4 |

**Recommendation (form c).** On the downtown loops upstream adds nothing
measurable — the two apps read the same feed and their errors are correlated
(0.5–0.9 on the daytime lines), and every blend is a wash or worse out of
sample. What upstream carries that we do not is the *sequence position* of a
bus on a fold: its ETA set names the branch 85% of the time, including while
the bus stands, which is the case the design doc calls unknowable. Enter it
there — as a categorical likelihood on the branch (§3 below), not as a number
on the arrival distribution — and only there. The out-of-service signal does
not exist. The three forms are spelled out at the end.

## Data

- **Snapshot** `store/snap-0906-1230.db` (production, Sun 2026-09-06 12:30 ET).
  `predictions_log` upstream rows: **43,075** from 9/4 15:07 to 9/6 11:25 ET —
  14,890 on Fri 9/4 (15:07–24:00, the weekday lines 1, 2, 3, 8, 9, 10, 13, 14,
  15, 16, 17, 19), 21,798 on Sat 9/5 (all day, the weekend lines 4, 9, 10, 13,
  14, 16, 17, 18) and 6,387 on Sun 9/6 morning (4, 9, 10, 18). **Two of the
  three days are weekend.** Red, Orange Day and Blue Day — what riders use —
  appear only in the Friday-afternoon slice (1,157 / 1,095 / 1,772 pairs).
- Upstream is per stop and SAMPLED (12 stops per 30 s: five focus stops every
  cycle — Prospect / Canner, Division / Prospect, 344 Winchester, 72 LEPH /
  60 College, 333 Cedar — plus a rotation), whole minutes, and nothing beyond
  30 min is recorded. 61–66% of its rows are at 10–30 min.
- **Truth**: `arrivals` (the detector). **A prediction made while the bus is
  already standing at the predicted stop is not a forecast**: its latest
  arrival there has not departed, both apps print ~0 while a layover runs,
  and the "first arrival at or after the prediction" is a lap away. These
  rows are counted as *bus already there* and kept out of every error table
  (`truthFor` in `upstream-eta-common.ts`). Measured first: 2,183 of the
  2,219 upstream rows at 0–2 min that "did not arrive" were exactly this.
  Otherwise the truth is the first arrival at or after the prediction within
  45 min; none = *did not arrive*. A proximity truth (first capture fix within
  50 m, as `gps-replay.ts` defines it) is scored beside it; the detector fires
  a median 15 s (p90 85 s) before the 50 m entry, so both arms carry the same
  small pessimistic offset.
- **Positions** for the replay and the proximity truth: the Pi's captures
  `~/shuttle-captures/positions-2026090{4,5,6}.jsonl` (`raw_positions` is
  retention-swept; the snapshot holds 9/6 05:26–11:25 only).
- **Our arm** (Q2) is the real client — `computeUpcomingArrivals`, the ring
  estimator on every route it serves, the legacy arithmetic where it declines
  (Green's bridged ring, the grocery lines) — replayed over the capture with
  the detector replay for `at_stop_id`/`at_stop_since`, the time-travelled
  calibration and a `model-patch.ts` table bounded at each day's 00:00 ET
  (`MODEL_NOW`), one shared per-vehicle store stepped on every poll in time
  order, exactly as `gps-replay.ts` does. At the poll nearest each upstream
  (bus, 15 s bucket) — within 12.5 s — it prices the stops upstream listed.
  Error = predicted − actual, negative = optimistic, each arm from its own
  instant.

## Q1 — upstream on its own

Detector truth, by upstream's promised horizon (43,075 rows):

| horizon | rows | paired | bus already there | did not arrive (bus vanished) | signed p10 | p50 | p90 | \|err\| p50 | p90 | ≤60 s | ≤120 s | opt ≥120 s | pes ≥120 s |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 0-2 min | 4295 | 1004 | 3255 = 75.8% | 36 = 0.8% (5) | -235 | -3 | 46 | 33 | 235 | 80.6% | 85.2% | 14.8% | 0.0% |
| 2-5 min | 4285 | 3356 | 742 = 17.3% | 187 = 4.4% (70) | -416 | 16 | 116 | 84 | 416 | 36.2% | 66.3% | 24.8% | 8.9% |
| 5-10 min | 6257 | 4873 | 1083 = 17.3% | 301 = 4.8% (182) | -409 | 57 | 240 | 145 | 439 | 20.6% | 41.9% | 24.0% | 34.1% |
| 10-30 min | 28238 | 22713 | 3211 = 11.4% | 2314 = 8.2% (1360) | -385 | 182 | 602 | 290 | 725 | 10.1% | 20.2% | 23.1% | 56.7% |
| all | 43075 | 31946 | 8291 = 19.2% | 2838 = 6.6% (1617) | -386 | 96 | 522 | 227 | 664 | 16.6% | 30.4% | 23.1% | 46.5% |

Three-quarters of upstream's "0–1 min" rows are a bus sitting at the stop; the
rest are good (33 s median, 85% within 2 min). From 10 min out it is
systematically pessimistic — +182 s median, 57% of rows more than two minutes
late-promised — which is the same right-skewed-stand story the ring model
prices with medians. 6.6% of rows never arrived inside 45 min; 57% of those
buses had left the feed by then (Q4).

By route (detector truth):

| route | rows | paired | already there | did not arrive (vanished) | signed p50 | \|err\| p50 | \|err\| p90 | ≤120 s | opt ≥120 s | pes ≥120 s |
|---|---|---|---|---|---|---|---|---|---|---|
| Blue Day (1) | 2056 | 1772 | 8.4% | 5.4% (111) | -43 | 131 | 441 | 47.2% | 34.8% | 18.0% |
| Orange Day (2) | 1249 | 1096 | 6.4% | 5.8% (50) | 87 | 118 | 292 | 50.3% | 10.4% | 39.3% |
| Red Day (3) | 1446 | 1157 | 11.3% | 8.7% (126) | 162 | 267 | 617 | 29.8% | 16.3% | 53.8% |
| Blue Wknd (4) | 4905 | 4286 | 9.2% | 3.4% (98) | 95 | 259 | 745 | 31.0% | 22.4% | 46.7% |
| Pink (8) | 353 | 211 | 17.8% | 22.4% (59) | 12 | 247 | 987 | 30.3% | 34.1% | 35.5% |
| Green WC (9) | 6860 | 4956 | 23.4% | 4.4% (185) | 45 | 245 | 579 | 26.6% | 32.6% | 40.8% |
| Purple WC (10) | 9255 | 5389 | 30.8% | 11% (220) | 208 | 280 | 714 | 22.1% | 16.8% | 61.1% |
| Blue Night (13) | 4460 | 3218 | 20.8% | 7% (209) | 54 | 174 | 698 | 37.0% | 25.2% | 37.8% |
| Orange Night (14) | 6327 | 5433 | 9.1% | 5.1% (297) | 117 | 205 | 506 | 31.5% | 18.8% | 49.7% |
| Gold (15) | 377 | 224 | 35.3% | 5.3% (20) | 124 | 124 | 621 | 45.1% | 0.4% | 54.5% |
| Blue West (16) | 1820 | 1372 | 19.3% | 5.3% (96) | 135 | 375 | 1239 | 24.7% | 24.3% | 51.0% |
| Orange East (17) | 2243 | 1609 | 22.8% | 5.5% (123) | 227 | 251 | 585 | 22.8% | 5.0% | 72.2% |
| Grocery Ham (18) | 1166 | 801 | 28.6% | 2.7% (7) | -70 | 188 | 899 | 36.3% | 42.7% | 21.0% |
| Brown (19) | 558 | 422 | 14.2% | 10.2% (16) | -682 | 702 | 1584 | 19.0% | 76.8% | 4.3% |

By day: 9/4 (Fri) 190 s, 9/5 (Sat) 243 s, 9/6 (Sun morning) 271 s — the route
mix, not a drift. Proximity truth moves every median by 10–20 s toward
optimistic and changes no ranking (`upstream-score.md`).

## Q2 — our estimator at the same moments

**Coverage** (43,084 upstream rows across the three replays): 8,081 bus
already there, 2,841 did not arrive (1,620 of them vanished from the feed),
32,162 arrived; our client had **no number for 723** (715 with the bus judged
off-route by `isBusOnRoute`, 8 with no priced arrival) — where the bus then
did arrive (352 rows), upstream's own median error was 408 s, so those are
not moments it knew better. **31,810 pairs.**

### Paired errors, by TRUE horizon (how long the bus actually took) — all routes

| true horizon | pairs | arm | signed p10 | p50 | p90 | \|err\| p50 | p90 | ≤60 s | ≤120 s | opt ≥120 s | pes ≥120 s | corr(errors) | upstream closer | truth in our 10–90 | upstream in our 10–90 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 0-2 min | 2545 | upstream | -8 | 69 | 553 | 69 | 553 | 45.8% | 67.8% | 0.0% | 32.2% | 0.23 | 39.9% | 34.4% | 48.4% |
| | | ours | 1 | 42 | 476 | 43 | 476 | 60.5% | 76.9% | 0.0% | 23.1% | | | | |
| 2-5 min | 3723 | upstream | -45 | 117 | 610 | 127 | 610 | 26.9% | 48.1% | 2.4% | 49.5% | 0.27 | 41.0% | 53.1% | 60.5% |
| | | ours | -31 | 80 | 594 | 91 | 594 | 37.1% | 57.6% | 2.6% | 39.7% | | | | |
| 5-10 min | 5897 | upstream | -163 | 169 | 592 | 219 | 592 | 16.0% | 30.2% | 13.1% | 56.7% | 0.29 | 44.1% | 56.0% | 63.3% |
| | | ours | -130 | 93 | 675 | 139 | 675 | 25.6% | 44.9% | 10.7% | 44.4% | | | | |
| 10-30 min | 17456 | upstream | -348 | 127 | 521 | 250 | 591 | 12.4% | 24.7% | 24.5% | 50.9% | 0.33 | 50.0% | 64.6% | 74.2% |
| | | ours | -336 | 111 | 820 | 244 | 848 | 14.6% | 29.1% | 21.9% | 49.0% | | | | |
| 30-45 min | 2189 | upstream | -1490 | -546 | -188 | 546 | 1490 | 2.3% | 5.6% | 94.4% | 0.0% | 0.20 | 40.3% | 61.5% | 55.0% |
| | | ours | -839 | -136 | 868 | 405 | 1172 | 7.6% | 14.8% | 51.3% | 33.9% | | | | |
| **all** | 31810 | upstream | -376 | 98 | 525 | **227** | 658 | 16.7% | 30.6% | 22.7% | 46.8% | 0.31 | 46.4% | 59.0% | 67.2% |
| | | ours | -283 | 82 | 769 | **187** | 820 | 22.5% | 38.2% | 17.9% | 43.9% | | | | |

The 30–45 min row is selection against upstream by construction (it never
promises past 30 min; a bus that took 35 was always under-promised). Our p90
is the worse one from 10 min out: the legacy-arithmetic routes below.

### The same, on the routes the ring estimator prices (excluding Green and Grocery Ham) — 26,029 pairs

| true horizon | pairs | arm | signed p50 | \|err\| p50 | \|err\| p90 | ≤120 s | opt ≥120 s | pes ≥120 s | corr | upstream closer |
|---|---|---|---|---|---|---|---|---|---|---|
| 0-2 min | 2083 | upstream | 67 | 68 | 529 | 69.3% | 0.0% | 30.7% | 0.42 | 36.7% |
| | | ours | 40 | 41 | 262 | 80.7% | 0.0% | 19.3% | | |
| 2-5 min | 3103 | upstream | 111 | 119 | 572 | 50.4% | 1.8% | 47.8% | 0.42 | 37.2% |
| | | ours | 74 | 81 | 351 | 61.9% | 0.9% | 37.1% | | |
| 5-10 min | 4880 | upstream | 172 | 206 | 575 | 32.5% | 10.5% | 57.0% | 0.41 | 38.9% |
| | | ours | 87 | 118 | 566 | 50.5% | 7.0% | 42.5% | | |
| 10-30 min | 14423 | upstream | 150 | 259 | 612 | 23.6% | 22.7% | 53.6% | 0.53 | 43.2% |
| | | ours | 75 | 202 | 680 | 33.4% | 23.6% | 42.9% | | |
| **all** | 26029 | upstream | 110 | **223** | 667 | 31.1% | 20.4% | 48.6% | 0.51 | 40.7% |
| | | ours | 62 | **154** | 652 | 42.8% | 18.7% | 38.5% | | |

By day on these routes: 9/4 ours 110 s vs 188; 9/5 190 vs 245; 9/6 249 vs
280. Bus at a stop: 155 vs 210; moving: 153 vs 235.

### By route (all 31,810 pairs)

| route | pairs | ours \|err\| p50 | upstream \|err\| p50 | ours ≤120 s | upstream ≤120 s | corr(errors) | upstream closer |
|---|---|---|---|---|---|---|---|
| Blue Day (1) | 1772 | 106 | 131 | 53.2% | 47.2% | 0.89 | 37.9% |
| Orange Day (2) | 1095 | 65 | 118 | 74.1% | 50.3% | 0.55 | 28.9% |
| Red Day (3) | 1157 | 78 | 267 | 71.0% | 29.8% | 0.70 | 20.4% |
| Blue Wknd (4) | 4283 | 233 | 259 | 26.4% | 30.9% | 0.67 | 49.4% |
| Pink (8) | 211 | 126 | 247 | 46.4% | 30.3% | 0.51 | 40.8% |
| Green WC (9), legacy | 4978 | 573 | 241 | 18.0% | 27.0% | 0.21 | 72.8% |
| Purple WC (10) | 5452 | 285 | 280 | 29.8% | 22.2% | 0.45 | 48.9% |
| Blue Night (13) | 3038 | 101 | 170 | 55.7% | 38.3% | 0.31 | 35.0% |
| Orange Night (14) | 5394 | 112 | 205 | 52.3% | 31.6% | 0.73 | 36.2% |
| Gold (15) | 224 | 108 | 124 | 55.4% | 45.1% | 0.60 | 49.6% |
| Blue West (16) | 1372 | 275 | 375 | 29.5% | 24.7% | 0.52 | 45.3% |
| Orange East (17) | 1609 | 238 | 251 | 29.9% | 22.8% | 0.54 | 43.4% |
| Grocery Ham (18), legacy | 803 | 308 | 188 | 15.4% | 36.2% | 0.67 | 65.1% |
| Brown (19) | 422 | 142 | 702 | 43.6% | 19.0% | 0.54 | 16.1% |

The daytime lines have error correlations of 0.55–0.89: same feed, same
information, two arithmetics. The two routes upstream beats are the two the
ring estimator DECLINES (Green's bridged ring, the grocery line's unmeasured
drive) — a statement about the legacy fallback, not about the model, and the
known open item (Green's sequence, upstream).

### The increment — regression, out of sample

In-sample per day (T = actual seconds, O = ours, U = upstream), ring routes:

| bucket (upstream's promise) | fit day | n | R² ours | R² upstream | R² both | **partial R² of upstream given ours** | blend |
|---|---|---|---|---|---|---|---|
| 10-30 min | 9/4 | 7608 | 0.57 | 0.27 | 0.57 | 0.01 | 101 + 0.77·O + 0.11·U |
| 10-30 min | 9/5 | 8711 | 0.40 | 0.25 | 0.42 | 0.05 | 124 + 0.48·O + 0.28·U |
| 10-30 min | 9/6 | 2109 | 0.28 | 0.33 | 0.36 | 0.11 | −35 + 0.24·O + 0.62·U |
| all | 9/4 | 10961 | 0.70 | 0.51 | 0.72 | 0.04 | 36 + 0.74·O + 0.18·U |
| all | 9/5 | 12244 | 0.52 | 0.45 | 0.58 | 0.12 | 82 + 0.44·O + 0.34·U |
| all | 9/6 | 2824 | 0.49 | 0.55 | 0.57 | 0.15 | −4 + 0.26·O + 0.58·U |

At ≤10 min the partial R² is 0.00–0.03 on every day and every route set. All
routes pooled (with Green) it reaches 0.16–0.25 at 10–30 min on the weekend
days — that is Green's legacy arithmetic being corrected, see the per-route
folds.

**Fitted on one day, scored on another** (six folds: 9/4↔9/5, 9/4↔9/6,
9/5↔9/6 both ways). Two blends: the full `a + b·O + c·U`, scored against the
BETTER of raw ours and ours re-calibrated (`a + b·O`) on the fit day, so a
bias correction is not credited to upstream; and the one-parameter shrink
`O + w·(U − O)` (no intercept — the form a likelihood term takes, and immune
to the day-to-day route mix an intercept absorbs), scored against raw ours.
Median \|err\| gain in seconds, positive = the blend helps:

| bucket | ring routes: full blend, median gain (range) | ring: shrink gain (range) | ring: w (range) | all routes: full blend | all: shrink | all: w |
|---|---|---|---|---|---|---|
| 0-2 min | −1 (−32 .. 0) | −2 (−8 .. 1) | 0.47 (0.10 .. 0.71) | −57 (−59 .. −14) | −2 (−10 .. −1) | 0.92 |
| 2-5 min | −16 (−66 .. 1) | −5 (−15 .. 2) | 0.44 (0.26 .. 0.67) | −46 (−83 .. −14) | −8 (−20 .. 6) | 0.89 |
| 5-10 min | −5 (−24 .. 7) | −18 (−34 .. −2) | 0.58 (0.29 .. 0.71) | −19 (−38 .. −3) | −23 (−40 .. −3) | 0.87 |
| 10-30 min | −1 (−50 .. 16) | −31 (−87 .. −2) | 0.44 (0.18 .. 0.78) | +11 (−51 .. 63) | +8 (−105 .. 130) | 0.80 |
| all | −1 (−34 .. 24) | −41 (−61 .. −10) | 0.51 (0.22 .. 0.76) | +2 (−36 .. 64) | −9 (−72 .. 43) | 0.84 |

The in-sample weight on upstream (w ≈ 0.5 on ring routes) does not survive the
day boundary: the shrink blend is worse than raw ours at every horizon out of
sample, and the full blend is a wash (−1 s) with a range that straddles zero.
The cross-day folds also cross the weekday/weekend route mix, which is the
best this data can do and is why the per-route folds are the read that counts:

| route | fit → score | n | ours raw | ours recal. | full blend | upstream | **gain vs better ours** | shrink w | shrink gain vs raw |
|---|---|---|---|---|---|---|---|---|---|
| Blue Wknd (4) | 9/5 → 9/6 | 1328 | 253 | 194 | 202 | 239 | −7 | 0.20 | −4 |
| Blue Wknd (4) | 9/6 → 9/5 | 2955 | 219 | 238 | 218 | 269 | +2 | 0.26 | +4 |
| **Purple (10)** | 9/4 → 9/5 | 3216 | 288 | 216 | 189 | 280 | **+28** | 0.79 | −7 |
| Purple (10) | 9/4 → 9/6 | 1450 | 248 | 210 | 167 | 309 | **+43** | 0.79 | −74 |
| Purple (10) | 9/5 → 9/4 | 786 | 322 | 172 | 128 | 222 | **+44** | 0.78 | +86 |
| Purple (10) | 9/5 → 9/6 | 1450 | 248 | 217 | 160 | 309 | **+57** | 0.78 | −74 |
| Purple (10) | 9/6 → 9/4 | 786 | 322 | 135 | 116 | 222 | **+19** | 0.88 | +88 |
| Purple (10) | 9/6 → 9/5 | 3216 | 288 | 187 | 156 | 280 | **+30** | 0.88 | 0 |
| Blue Night (13) | 9/4 → 9/5 | 1676 | 103 | 115 | 122 | 166 | −19 | 0.25 | −22 |
| Blue Night (13) | 9/5 → 9/4 | 1347 | 97 | 125 | 131 | 170 | −34 | 0.25 | −26 |
| Orange Night (14) | 9/4 → 9/5 | 2959 | 119 | 169 | 169 | 211 | −50 | 0.36 | −33 |
| Orange Night (14) | 9/5 → 9/4 | 2430 | 99 | 130 | 134 | 194 | −36 | 0.39 | −27 |
| Blue West (16) | 9/4 → 9/5 | 693 | 235 | 314 | 318 | 399 | −83 | 0.21 | −137 |
| Blue West (16) | 9/5 → 9/4 | 663 | 322 | 314 | 327 | 350 | −13 | 0.18 | −56 |
| Orange East (17) | 9/4 → 9/5 | 745 | 270 | 170 | 159 | 281 | +11 | −0.05 | −3 |
| Orange East (17) | 9/5 → 9/4 | 854 | 210 | 123 | 116 | 228 | +7 | 0.11 | −3 |
| Green (9), legacy | six folds | 466–2875 | 337–594 | 272–377 | 167–264 | 188–255 | +39 .. +129 | — | — |
| Grocery Ham (18), legacy | two folds | 186–617 | 287–366 | 200–259 | 212–262 | 157–311 | −3, −12 | — | — |

Purple is the one ring-priced route where upstream adds information on every
fold: +19 to +57 s on the median beyond the better of our own two baselines
(partial R² 0.09–0.11, all of it in the 10–30 min bucket: +4 to +62 s there,
−18 to −192 s at 2–10 min). That is the fold — and Q3 says what the
information is. Green is upstream beating the legacy arithmetic by a mile
(241 vs 573 s), which the model's shadow-leg and sequence work would address
without upstream.

### σ(h) — what a likelihood term would carry (ring routes, by upstream's promise)

| bucket | n | σ of upstream's error (SD) | robust σ (1.4826·MAD) | σ after ours is partialled out | corr(errors) | σ of OUR error (SD) | robust σ of our error |
|---|---|---|---|---|---|---|---|
| 0-2 min | 791 | 223 | 47 | 215 | 0.26 | 193 | 26 |
| 2-5 min | 2729 | 349 | 101 | 326 | 0.35 | 413 | 79 |
| 5-10 min | 4081 | 373 | 168 | 351 | 0.34 | 367 | 131 |
| 10-30 min | 18428 | 437 | 324 | 359 | 0.57 | 409 | 282 |

Upstream's robust σ is 1.2–1.8× ours at every horizon and its error is
correlated with ours (0.26–0.57): a Gaussian likelihood with these σ(h) would
move our posterior by at most a few percent of the gap, which is what the
shrink weights above went and lost out of sample. The proximity truth
(`blend-prox.md`) tells the same story: all routes ours 158 s vs upstream 207.

## Q3 — direction on a fold from upstream's ETA set

Purple (10) and Green (9) run out to West Campus and back on one road; the
design doc's open case is a bus on the fold that is STANDING, where two fixes
cannot give a direction. Upstream lists an ETA per (bus, stop) and a stop on
the far branch is minutes away one way and most of a lap the other, so the
SET it lists — and the horizons — is a direction observation.

Method (`upstream-eta-fold.ts`): one capture fix per 15 s; a moment is
*ambiguous* when the legs whose road (`traceStopLegs`) passes within 150 m of
the fix fall into two or more BRANCHES (runs of sequence-consecutive legs —
the leg into a stop and the leg out of it are adjacency, not a fold); the
truth branch is the detector's, from the `stop_visits` before and after the
moment (≤ 2 stops skipped, every leg between them on one branch). Upstream's
branch is the candidate whose hop-table times (median `legs.leg_sec` per hop,
median stand per stop index, from the snapshot) best fit the horizons upstream
listed in its latest 30 s cycle; a focus stop it did NOT list (333 Cedar and
72 LEPH on Purple, polled every cycle) counts as "> 30 min". Baselines: the
nearer road (a coin flip on a true fold) and the feed's heading, which decides
only when exactly one branch's road bearing is within 90°.

20,882 fixes on the two routes, 13,187 ambiguous (63%), 6,300 with a settled
detector truth:

| slice | moments | upstream has evidence | **upstream right** | …margin ≥5 min | right when confident | nearest-road right | heading decides | heading right |
|---|---|---|---|---|---|---|---|---|
| Green (9) | 3815 | 67.7% | **86.9%** | 66.4% | 86.9% | 66.9% | 39.8% | 99.3% |
| — moving | 1963 | 67.9% | 84.9% | 74.6% | 83.7% | 65.7% | 61.0% | 99.2% |
| — **standing** | 1852 | 67.5% | **89.0%** | 57.7% | 91.4% | 68.3% | **17.4%** | 99.7% |
| Purple (10) | 2485 | 98.4% | **84.1%** | 55.8% | 92.7% | 75.6% | 69.7% | 98.8% |
| — moving | 1819 | 98.1% | 87.3% | 60.9% | 92.5% | 80.8% | 80.8% | 99.0% |
| — **standing** | 666 | 99.4% | **75.4%** | 41.8% | 93.1% | 61.4% | **39.5%** | 97.7% |
| all | 6300 | 79.8% | 85.5% | 61.2% | 89.5% | 70.3% | 51.6% | 99.0% |

Per day the agreement is 83–98% (Green 97.7 / 85.9 / 83.1; Purple 84.3 / 81.6
/ 90.3). Spells (a run of ambiguous moments on one truth branch, ≥ 2 moments):

| route | spells | median length | with evidence | right at first evidence | ever right | lead before the detector settles it (median, p10–p90) | right then wrong later |
|---|---|---|---|---|---|---|---|
| Green (9) | 346 | 0.9 min | 78.3% | 77.1% | 82.7% | 0.8 min (−0.1 .. 6.8) | 16.1% |
| Purple (10) | 268 | 2.3 min | 99.3% | 93.2% | 98.9% | 1.4 min (0.2 .. 3.7) | 29.7% |

What carries the evidence on Purple is mechanical and readable straight off the
rows: 333 Cedar (the terminus, a focus stop) is listed for 0–5% of outbound
moments (legs 1–5) and for 66–100% of return moments (legs 6–14), at 28–30 min
on the West Campus outbound side and 18–19 min on the return. On Green there
is no focus stop, so evidence exists only when a rotation stop is polled
(68%), and it is the horizon *magnitude* to Willow / Whitney, Building 900
and Building 400 that separates the branches.

Heading is nearly perfect when it decides, and it decides on 61–81% of moving
moments but 17–40% of standing ones — exactly the gap the doc names. Upstream
fills 68–99% of it at 75–89% accuracy, with a margin the filter can weight:
where the best branch beats the runner-up by ≥ 5 min of misfit (56–66% of the
evidence) it is right 92–93% of the time on Purple.

## Q4 — going out of service

`upstream-eta-eos.ts`: for each bus's last appearance of the service day
(4 am–4 am ET; presence runs with gaps ≤ 10 min; runs ending within 20 min of
the data end censored — 31 EOS windows), the 15 min before, against 867
control windows every 15 min through every run where the bus went on ≥ 30 min;
windows with the poller active < 80% of minutes skipped.

| | windows | gap to the bus's last upstream row, p25 / p50 / p75 | no row in last 2 / 3 / 5 / 10 min | rows early but none late | horizon shrink p50 | windows with a promise past the end | rows promised past the end | rows written after the last fix |
|---|---|---|---|---|---|---|---|---|
| **EOS** | 31 | 0.2 / 0.2 / 0.5 min | 0% / 0% / 0% / 0% | 0% | 0.0 min | **100%** | 1,062 | 3.2% (1 window) |
| control | 867 | 0.1 / 0.3 / 0.6 min | 9.5% / 7.5% / 5.3% / 4.5% | 1.3% | 0.0 min | 93.3% | 26,675 | — |

Per route every EOS row reads the same (0% flagged on all 14 routes; full
table in `eos.md`). Upstream predicts a bus until the instant it leaves the
feed and not a second less: no earlier vanishing, no shrinking horizon, and
every one of the 31 buses had 34 rows on average promising arrivals that never
came. The rule "no upstream row in the last k min" has 0% recall at every k
and a 4.5–9.5% false-positive rate (the sampling — a bus more than 30 min from
every polled stop). **There is no out-of-service signal in upstream.** (n = 31
is two evenings and a Sunday morning; the shape — 0 of 31, 100% promising
past the end — would need a very different Monday to move.)

## The live `etaVsOfficial` number on `/stats`

On 2026-09-06 13:00 ET `/api/stats` read: ours n=91 paired=63 median \|err\|
450 s within-120 3.2%; official n=20,662 paired=19,238 median 281 s within-120
24.9%. That is not "the official app is better"; it is four things about what
was compared (`upstream-eta-stats-check.ts`, reproduced from the snapshot:
ours 88 / 62 / 456 s / 1.6%, official 20,957 / 19,551 / 280 s / 25.0%).

**What the "ours" rows are.** `officialComparison` (`src/server/predictions.ts`)
takes every rider-surface row in the trailing 24 h. A rider row is what a
sampled browser (25% of page loads, `web/src/shownLog.ts`) had on screen,
deduplicated to one row per (bus, stop, 15 s) — posted once a minute, so every
poll while the screen shows it, for as long as it is shown. In the last 24 h
(a Saturday afternoon to a Sunday morning) that was **88 rows: 79 from the
route cards and 9 from a trip card**, on Blue Weekend 32, Purple 22, Green 20
and Grocery Ham 14 — **no Red, Orange Day or Blue Day at all** — and the route
cards list *every* stop of every visible line, so the median row was 8 stops
ahead and **41 of the 88 (47%) promised more than 30 min**, where upstream by
construction has no rows.

**How they are paired.** First `arrivals` row for that (bus, route, stop) at or
after `predicted_at`, within **2 hours**, no horizon cap and no standing check
— so a card listing the terminus while the bus sits there (23 of the 88 rows,
26%, a bus standing a median 11.4 min at the predicted stop) is paired with
the bus's NEXT visit, a lap later, and scored as an error of a whole lap. The
same rule does the same to the official arm: its 0–2 min bucket reads a
median error of **2,627 s** (24% within 2 min) under the server's rule and
**35 s** (81%) once standing buses are excluded.

**Same horizon buckets, both rules, last 24 h** (from `stats-check.md`):

| horizon (promised) | arm | rows | server rule: paired / \|err\| p50 / ≤120 s | standing-aware, 45 min: paired / already there / \|err\| p50 / ≤120 s |
|---|---|---|---|---|
| ≤ 30 min | ours | 47 | 35 / 308 s / 2.9% | 24 / 11 / 296 s / 4.2% |
| ≤ 30 min | official | 20,957 | 19,551 / 280 s / 25.0% | 15,244 / 4,331 / 246 s / 27.9% |
| 30–60 min | ours | 36 | 25 / 1,076 s / 0% | 18 / 9 / 1,115 s / 0% |
| all | ours | 88 | 62 / 456 s / 1.6% | 42 / 23 / 383 s / 2.4% |

The horizon mix and the standing rows explain the gap from 450 s to ~300 s;
the rest is the route mix: on this weekend the rider rows were 39% Green +
Grocery Ham, the two routes on the legacy arithmetic, where the replay shows
upstream genuinely ahead (Q2: Green 241 vs 573 s). Blue Weekend and Purple —
the other 61% — replay at 233 vs 259 and 285 vs 280 s: a wash. With n = 24
usable rows the dashboard number has no resolution anyway; `compare-upstream.ts`
withholds its head-to-head on this window at 12 shared pairs (< 50).

**Same (bus, stop, minute) pairs, same arrival**, the whole snapshot (9/4
15:07–9/6 11:25), standing-aware truth, 146 shared pairs: ours **134 s** vs
official 177 s (≤120 s 45.9% vs 32.9%); 5–10 min 132 vs 158 (29 pairs), 10–30
min 137 vs 197 (91); Red 86 vs 177 (34), Orange Day 114 vs 208 (23), Blue Day
137 vs 137 (29). The replay is the same comparison at 31,810 pairs (Q2).

Two things follow for the dashboard, neither done here (measurement only):
`officialComparison` and `paired()` should (1) exclude rows whose bus is
standing at the predicted stop, or score them as 0 — under the current rule
they are a lap of error on both arms — and (2) compare on a shared horizon
cap (≤ 30 min) and, as `compare-upstream.ts` already does, only on shared
(bus, stop, minute) pairs, withholding below 50. Until then the line should be
read as "the route cards, on a weekend, paired to the next lap", not as a
ranking of the two apps.

## Caveats

- **Two and a bit days, mostly weekend.** Friday 15:07–24:00 is the only
  weekday slice; Red / Orange Day / Blue Day have ~1,100–1,800 pairs each and
  no cross-day fold of their own. The cross-day folds cross the weekday/
  weekend route mix; the per-route folds are the clean read and exist only
  for routes running on two of the three days (4, 9, 10, 13, 14, 16, 17, 18).
- **Upstream only within 30 min**, whole minutes, sampled 12 stops / 30 s.
  Q3's evidence rate on Green (68%) is the sampling, not upstream; on Purple
  two focus stops make it 98%. A fold estimate in production would see the
  same coverage the poller gives it.
- The detector truth fires ~15 s before the physical arrival; both arms carry
  it. The "already there" exclusion is symmetric and deliberate; scoring those
  rows as 0 instead moves neither arm's ranking (they would be near-zero
  errors for both).
- Our arm is the replayed client at each day's 00:00 ET tables, one bus per
  call in time order (as `gps-replay.ts`), not what a browser displayed;
  `predictions_log`'s rider rows are too few and too card-heavy to score at
  this scale (Q5).
- Q3's decision rule is deliberately crude (hop medians from `legs`, mid-leg
  start, absolute misfit); a rule tuned on one day and scored on another
  would be the next step and could only do better than the 85% here. Green's
  road geometry comes from a ring the estimator itself declines as bridged.
- Q4 has 31 end-of-service events.

## Recommendation, in three forms

**(a) "adds nothing measurable — do not blend."** True for the arrival-time
number on every route the ring estimator prices. On 26,029 shared pairs ours
is 154 s to upstream's 223 s; the errors are correlated 0.26–0.57 (0.55–0.89
on the daytime lines) because both read one feed; the in-sample partial R² of
upstream given ours is 0.00–0.03 at ≤ 10 min and 0.01–0.11 at 10–30 min; and
out of sample every blend is a wash or a loss — the shrink `O + w·(U − O)`
costs 2–41 s at every horizon, the full linear blend is −1 s (range −34 .. +24).
Do not put upstream's minute into the arrival distribution.

**(b) "adds X at horizon Y — enter as a likelihood on the arrival distribution
with noise σ(h)."** Not supported as a general term. If one were added anyway
the measured σ(h) for a Gaussian likelihood on upstream's promise would be the
robust 47 / 101 / 168 / 324 s at 0–2 / 2–5 / 5–10 / 10–30 min (SD 223 / 349 /
373 / 437), with a +67 to +150 s pessimistic offset from 2 min out and a 0.26–
0.57 error correlation with ours that the term would have to discount — and
the out-of-sample folds say the resulting posterior weight (0.4–0.6 in sample)
loses 5–41 s on the median the next day. The one route where a number-level
blend earned its keep was Purple (+19 to +57 s beyond our better baseline, all
at 10–30 min), and that gain is the fold, which (c) captures without a second
ETA in the sum.

**(c) "the direction / out-of-service signals are worth Z — enter as …"** The
out-of-service signal is worth nothing (0 of 31, and 100% of last appearances
carried promises past the end). The direction signal is worth the standing
half of the fold ambiguity the design doc leaves open: on 6,300 ambiguous
moments upstream's ETA set names the branch correctly 85.5% of the time
(Green 86.9, Purple 84.1), on STANDING moments 89% / 75% where heading decides
only 17% / 40% of them, and 92–93% when its margin is ≥ 5 min. Enter it as a
**categorical likelihood on the branch**, on the per-poll step, from the
upstream rows for the bus in its latest cycle (the collector already writes
them; the payload would carry `{stop → minutes}` per bus, ≤ a dozen entries):
for each branch b, `L(b) ∝ exp(−Σ_S |U(S) − T_b(S)| / τ)` over the listed
stops, with a focus stop that is NOT listed contributing `max(0, 1800 −
T_b(S))`, and `T_b(S)` the model's own chain price from mid-branch (not the
crude hop medians used here). Multiply it into the mass of the cells on each
branch — never into a single leg, never as a position — at a temperature τ set
so that a 5-min margin moves the branch posterior to ~0.9 (the measured
precision at that margin). It applies only where `situations()` holds two
branches on one road, so on the downtown loops it is inert; and it is worth
building only for Purple and, once its ring is traceable, Green — the routes
where Q2 shows an increment and every other route shows none.

## Commands

```bash
cd services/shuttle-v2
O=scripts/.eta-replay/upstream-eta
export TZ=America/New_York REPLAY_DB=./store/snap-0906-1230.db

# Q1 — upstream alone (writes upstream-scored.jsonl, upstream-score.md/.json)
npx tsx scripts/eta-replay/upstream-eta-score.ts

# Q2 — tables at each day's start, then the replay arm per ET day, then the analysis
for d in 04 05 06; do
  MODEL_NOW=2026-09-${d}T04:00:00Z MODEL_OUT=$O/model-patch-09$d.json npx tsx scripts/eta-replay/model-patch.ts
done
PAYLOAD_PATCH=$O/model-patch-0904.json FROM=2026-09-04T04:00:00Z TO=2026-09-05T04:00:00Z OUT_NAME=ours-0904.jsonl npx tsx scripts/eta-replay/upstream-eta-align.ts
PAYLOAD_PATCH=$O/model-patch-0905.json FROM=2026-09-05T04:00:00Z TO=2026-09-06T04:00:00Z OUT_NAME=ours-0905.jsonl npx tsx scripts/eta-replay/upstream-eta-align.ts
PAYLOAD_PATCH=$O/model-patch-0906.json FROM=2026-09-06T04:00:00Z TO=2026-09-07T04:00:00Z OUT_NAME=ours-0906.jsonl npx tsx scripts/eta-replay/upstream-eta-align.ts
npx tsx scripts/eta-replay/upstream-eta-blend.ts                                   # blend-det.md
EXCLUDE_ROUTES=9,18,6 TAG=ring npx tsx scripts/eta-replay/upstream-eta-blend.ts    # ring routes only
ROUTES=9,18 TAG=legacy npx tsx scripts/eta-replay/upstream-eta-blend.ts
ROUTES=10 TAG=purple npx tsx scripts/eta-replay/upstream-eta-blend.ts
TRUTH=prox npx tsx scripts/eta-replay/upstream-eta-blend.ts

# Q3 — direction on the fold; Q4 — out of service
npx tsx scripts/eta-replay/upstream-eta-fold.ts        # fold.md, fold-moments.jsonl
npx tsx scripts/eta-replay/upstream-eta-eos.ts         # eos.md

# the /stats line
TO=2026-09-06T15:25:00Z npx tsx scripts/eta-replay/upstream-eta-stats-check.ts    # stats-check.md
TO=2026-09-06T15:25:00Z HOURS=24 npx tsx scripts/eta-replay/compare-upstream.ts
```

Each replay day takes about a minute on the Pi (80–90k observations); the
rest are seconds. Captures default to `~/shuttle-captures/positions-202609{04,05,06}.jsonl`
(`CAPTURES=` overrides).
