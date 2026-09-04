# The ETA as a posterior: findings, negative results, and the estimator design

**Status: research, 2026-09-03/04. Nothing here is shipped.** Measurements are
from `services/shuttle-v2/scripts/eta-replay/belief-scoreboard.ts` (transition
level, paired against the real `computeUpcomingArrivals` with its own
`AnchorStore`), `priors.ts` (detector-only passes over the captured corpus),
and one pass over the `arrivals` table. Baseline is `origin/master` 972c5ba
(PRs #67, #72, #73, #74, #77 included). Corpus: `~/shuttle-captures/positions-*.jsonl`,
116,733 rows, 09:51–21:09 ET on 2026-09-03; calibration tables from a
production snapshot taken 17:36 ET.

Read `docs/eta-error-budget.md` and `docs/layover-clock.md` first. This
document supersedes the stability numbers in the former where they disagree,
for the reasons in "What the earlier harnesses measured".

---

## Summary

1. **The predecessor's belief-anchor result was real and is still
   disqualified.** Handing the filter's leg to the ETA directly (not through a
   lat/lon that `findRouteAnchor` re-derives) halves jitter and cuts eventless
   jitter 61% against production-with-gate — and is **a full lap wrong at 7.5%
   of departures** (Purple 31%, Green 27% of theirs). The mechanism is branch
   lock on out-and-back routes, and it means **a point-valued anchor of any
   kind is the wrong object**. The anchor has to be a distribution.
2. **The departure cliff is a production defect, not an arm's.** Over 569 clean
   layover departures the promise for the next stop is +16 s at the departure
   instant, **+115 s at +30 s, +151 s at +45–60 s**. Cause: the hop is priced
   arrival-to-arrival, so its seconds are piled at metre zero, and the moment
   `at_stop_id` clears the code switches to distance proration.
3. **The elapsed-dwell clock earns its keep; its form is the defect.** Dropping
   it costs 68 s MAE and +141 s bias at layover stops. The shipped
   `E[T] − min(r, med)` is right until the median and then optimistic by
   −29…−101 s. The conditional **median** of `(T − r | T > r)` beats both at
   every `r` with flat bias (127 s / +7 s). It is a per-stop table, not a filter.
4. **`last_stop_id` is the last stop passed**, lagging the nearest index with
   ~60–75% of its mass on {nearest−1, nearest} and a long tail both ways —
   informative enough to separate branches on a fold, far too broad to obey.
5. **9% of stops are skipped more often than not; buses never stop at VA
   Entrance Inbound.** Rider-facing; flagged separately.
6. The estimator that follows is a Gaussian-sum IMM with a Tobit update on 1-D
   road-constrained progress, with the rest component a lookup table. No
   particles are needed: at most two legs share a coordinate on this network.

---

## What the earlier harnesses measured, and what they got wrong

Three fidelity gaps, each of which changed a conclusion:

- **`at_stop_since`.** Production serves `stationarySince` (stop-pinned since
  PR #67); `eta-stability.ts` and `anchor-belief.ts` built it from `enteredAt`.
  That variant has 15% more big jumps and 40–60 s more optimistic bias before
  a departure than production. `jitter-audit.ts` (PR #77) corrected this;
  `belief-scoreboard.ts` uses the production field and keeps the old one
  reproducible via `SINCE=entered` there.
- **The anchor channel.** `eta-stability.ts` fed every arm through
  `computeUpcomingArrivals` as a lat/lon, which re-derives the anchor; the
  cause attribution read the arm's *own* leg. Re-run: the believed leg equals
  the anchor actually used on **60.5%** of polls (filter) / 62.4% (detector).
  So "anchor flips fell 84%" counted the wrong anchor, and `detTrue` was never
  a ceiling — the detector's `nearestIndex` switches at the midpoint between
  stops while the client's anchor means "the segment the bus is on".
  **Anchoring's true ceiling is unmeasured.**
- **Wraps.** A (bus, stop) series *must* flip to the next lap when the bus
  reaches the stop; the metric requires it. 3,278 of production's 16,573
  jumps ≥300 s are this. `belief-scoreboard.ts` counts a wrap as legitimate
  only when the bus is within 75 m of the stop, and reports **jitter** = big
  jumps minus those.
- **Shipped must be the gated client.** Production passes `liveAnchorStore` on
  every call site; a baseline without a store is the pre-#72 client. The
  scoreboard's `shipped` arm calls the real function with its own per-run
  store, `replica` is the copy with a second store (0 mismatches over 2.33 M
  transitions), `ungated` is the explicit pre-#72 reference.

## Transition-level scoreboard (rebased, 2.33 M transitions)

| arm | jitter | eventless jitter | frozen / while moving | bias all / next-10-min |
|---|---|---|---|---|
| shipped (gated) | 13,295 (0.57%) | 5,025 | 37.2% / 16.5% | +84 / +273 s |
| ungated (pre-#72) | 18,149 (0.78%) | 11,096 | 36.0 / 13.9 | +80 / +248 |
| beliefFull (as audited) | 6,472 | 4,515 | **46.2** / 2.1 | +98 / +182 |
| beliefFullFixed | 6,986 | 5,404 | **33.8** / 1.3 | +89 / +182 |
| beliefA (filter leg + production credit) | 6,359 (0.27%) | **1,976** | 34.5 / 11.4 | +74 / +174 |

`beliefFullFixed` repairs two defects of the audited arm: the standing clock
stamped when P(standing) crossed 0.5 rather than at the last distinct fix
(20–35 s of credit short for the whole dwell), and standing granted only within
75 m of the leg's *start* when an arriving bus sits at its *end*. The freeze
share drops from 46.2% to 33.8% — below production — and 9 of the 14 s of
extra bias come back. The +141 s bias quoted against the filter was a
strawman; the branch lock below is not.

### The branch lock (why every filter arm is disqualified)

Paired at 3,674 production departures (`at_stop_id` non-null → null), every
filter arm is >300 s later than shipped at the departure poll on **274
(7.5%)**, p99 +4,870 s: Purple 118/380, Green 104/383, Pink 29/297, Red 17/698.
Worst case, Green #326 → Building 400: shipped `28 23 12 6 2`, filter
`5174 5187 5212 …`. On an out-and-back the two branches are the same
coordinates; a forward-only filter commits to one and no later fix can move
it — the `at_stop` refine cannot either, since it requires ≤1 stop ahead.
Green and Purple are exactly where the filter wins on jitter and where it is a
lap wrong 30% of the time. The off-path reset in `progress-filter.ts`
(no candidate within 70 m → progress 0) was a separate bug, fixed here, and is
**not** this mechanism. PR #72's gate is a point anchor too and therefore
cannot reach this class; it is helping (−27% on the folding routes) and is
bounded by the same fact.

Also measured and rejected today (PR #77): EMA on the raw fix makes eventless
jumps 3–7× worse because a smoother keeps converging on polls that carry no
observation — it manufactures motion. And a displacement-only corroboration
gate (`corroborated`, my reading of the error-budget recommendation) bought 7%
because a moving bus reopens it every three polls; PR #72's forward-consistency
rule is the version that works.

### The departure cliff (production)

569 clean layover departures, departure instant by the plateau walk-back of
`docs/layover-clock.md` §7 (no radius any arm uses), truth = the bus's own
track entering 50 m of the next stop. Median signed error of the promise to the
next stop:

| offset from departure | −60 s | −10 s | 0 | +5 | +10 | +20 | +30 | +45 | +60 |
|---|---|---|---|---|---|---|---|---|---|
| shipped | +9 | +11 | +16 | +27 | +29 | +47 | **+115** | **+151** | +151 |

Mechanism: `segAvg(A→B)` is arrival-to-arrival and contains every second the
bus stood at A (40% of hop seconds; 72% of within-hop variance). While
`at_stop`, the first hop bills `segAvg − credit` and ticks down. The instant
`at_stop_id` clears (75 m out — on a 112 m hop that is t ≈ 0.67) the code
switches to `segAvg × (1 − t)`, spreading seconds that were piled at metre
zero evenly along the metres: 344 Winchester → Winchester/Division, 557 s over
112 m, bills 0.33 × 557 ≈ 184 s for ≤37 m of road. The rider's number goes
82 → 184 on the correct event. A hop must carry `stand(A)` and `drive(A→B)`
separately and proration may only ever scale `drive`; the departure-derivation
lane is producing that split from the archive.

## The rest term: a conditional table, not a credit

`arrivals` table, 168,027 hops / 30 days, fit on the first 23, evaluated on the
last 7; every 30 s a bus stood is one poll. T = hop time (arrival to arrival),
r = seconds already stood. Error = promise − actual, seconds.

| predictor at elapsed r | layover stops (37, median ≥180 s) MAE / bias | ordinary stops (222) MAE / bias |
|---|---|---|
| no clock: E[T] regardless of r | **203 / +141** | 55 / +13 |
| shipped form: E[T] − min(r, med), floored | 135 / +6 | 46 / −14 |
| conditional mean E[T − r \| T > r] | 134 / +30 | 45 / −4 |
| **conditional median of (T − r \| T > r)** | **127 / +7** | **42 / −19** |

The shipped form's flat overall bias hides a sign change: +34 at r = 30 s,
−3 at 180, **−29 at 240, −43 at 300, −71 at 420, −101 at 600** — a bus that has
sat past its median is promised at the floor while the data says two more
minutes (the #309 "steady but wrong" number). At an ordinary stop holding
abnormally (r ≥ 180 s) it is −100 to −185 s. The conditional median's bias is
flat across r (+7, +6, +5, +4, +11, +12, +7, −3, +2, +20). Variance falls with r
on most layover stops (344 Winchester sd 221 → 120 at r = 600 s; 333 Cedar on
route 16 316 → 149) but not all (Union Station (N) on Brown 254 → 231).

Sparsity (measured by the coordinator's lane: 1.42 traversals per hop per
hour; a (stop, hour, dow) cell holds ~8 samples over 30 days) means the table
is **per stop, pooled over the day** — which is how it was measured — with
night routes shrunk toward a route-level layover shape.

## Priors, all measured

| quantity | value | source |
|---|---|---|
| position deadband (censoring limit) | 30 m (p1 30.1, p10 30.7 m) | error-budget doc |
| fix noise while still | median 0 m | layover-clock doc |
| P(frozen \| standing) / P(frozen \| running) | 0.919 / 0.159 | error-budget doc |
| off-stop mode hazards, run→stand / stand→run | 0.01612 / 0.01457 per s | error-budget doc |
| on-stop departure hazard | hazard of the per-stop table above | `arrivals` |
| first fresh fix after ≥60 s frozen | 66% departure, 14% shuffle, 20% ambiguous; first step 30–35 m in both; second poll fresh 70% vs 24% | corpus, 775 cases |
| `heading` | derived from displacement (0.5° from motion bearing) — carries nothing | corpus |
| `last_stop_id` vs nearest index, fresh fix | nearest−1 35.0%, = 26.2%, −2 6.6%, −3 4.2%, −8 3.9%, +1 3.7% | `priors.ts` |
| … frozen fix | −1 42.9%, = 31.2%, −2 3.9%, −3 2.6% | `priors.ts` |
| P(stops \| pass) | 87.7% overall; per-stop p10/p50/p90 0.63/0.97/1.00 | `priors.ts` |
| running speed on fresh fixes, m/s p10/p50/p90 | downtown 6.1 / 6.6–7.1 / ~13; West Campus (9, 10) 6.2 / 12–12.6 / 23 | `priors.ts` |
| mid-leg polls frozen | 39.1% by poll (hold share by seconds is 14.9%, run-based) | `priors.ts` |

**The p10 of 6.1 m/s on every route is 30 m / 5 s — the deadband quantum, not
a speed.** Nothing below ~6 m/s is observable; acceleration is not either. This
belongs beside the mass/inertia note in `docs/bus-speed.md`.

### Stops buses skip (rider-facing; needs a product decision)

Passes with ≥15 s within 75 m, stops with ≥20 passes in the corpus:

| route | stop | P(stop) | passes |
|---|---|---|---|
| 8 | VA Entrance Inbound | **0.00** | 25 |
| 10 | 100 Church Street South | 0.20 | 51 |
| 10 | Union Station (S) | 0.21 | 56 |
| 3 | Division / Sheffield | 0.32 | 25 |
| 9 | Orange / Pearl (N) | 0.38 | 39 |
| 9 | Building 750 | 0.43 | 23 |

9% of stops have P(stop) < 0.5. An arrival time at a stop the bus does not
stop at is a rider stranded at a kerb, not an estimation error.

## The estimator

**One question per bus: given everything observed, what is the distribution of
the instant it reaches each stop?** The rider sees a summary (median and an
interval — the app already shows ranges for rests).

- **Coordinates.** 1-D progress along the published polyline, one hypothesis
  per leg that could hold the fix (road-constrained tracking: Ulmke & Koch;
  Cheng & Singh). On this network at most two legs share a coordinate (the
  out-and-backs and the (N)/(S) twins), so the branch mixture has at most two
  components.
- **State per (branch, mode):** Gaussian over `(s, v)` — along-leg progress
  and speed — plus the deterministic accumulator `r`. Modes {standing, running}
  form an IMM (Blom & Bar-Shalom; the stop-and-go parametrisations of Kaempchen
  et al.). Standing: `s` fixed, `r += dt`. Running: `s += v·dt`, `v` a bounded
  random walk with the route-class prior above; crossing a leg end advances the
  leg, resets `r`, and stops with the measured P(stops | stop). Mode
  transitions: on-stop, the hazard of the per-stop table; off-stop, the
  measured rates.
- **Observations.** Fresh fix: linear in `s` via the projection onto the
  branch, σ ≈ 10 m; the perpendicular residual is the branch likelihood.
  **Repeated fix: a Type I censored measurement** — displacement since the
  last fresh fix is observed only as `< 30 m` — handled by the Tobit Kalman
  update (Allik, Miller, Piovoso & Zurakowski, IEEE TCST 2016): the censored
  observation is replaced by its truncated-normal conditional expectation,
  gain and covariance scaled by the censoring probability and the truncated
  variance. In the running mode the innovation is large, so the censored
  update is what moves IMM weight to standing — the step a constant-velocity
  filter cannot take and the opposite of EMA. `last_stop_id`: a categorical
  likelihood from the table above, never obeyed. `at_stop_*`: a function of
  the same GPS, not an observation; seeds `r` on a cold client. `heading`:
  dropped.
- **Output.** For stop j, a mixture over (branch, mode) of [standing:
  conditional quantiles of `(stand − r | stand > r)`; running: remaining
  `drive × (1 − t)` bounded by the 22 m/s floor, plus expected `hold`] + the
  served hop distributions ahead. Chord projection for `t` (115 vs 117 s
  against the polyline; not worth it). If the second branch holds more than a
  small mass the summary says so rather than picking. The stand/hold/drive
  split per hop is an input from the departure-derivation lane, not derived
  from `segAvg`.
- **Why not particles.** ≤2 branches × 2 modes = 4 Gaussians per bus; the
  continuous part is 2-D with a linear measurement; the censored update is
  closed-form; the rest term is a lookup. Particles would add sampling noise
  to a problem with no intractable component. They remain the fallback if a
  route ever presents more than a handful of coincident legs.
- **Departure.** The mode posterior moves ~0.7 on the first fresh fix and
  ~0.9 on the second (measured likelihood ratios), so the number moves in the
  right direction in the same poll and completes one poll later — the soft
  rule the coordinator chose over "first fresh fix = departed", which would
  reverse itself one time in three.

### What is and is not identifiable

- Branch: identifiable off the folds; on them, from direction over two fresh
  fixes and from `last_stop_id`; while stationary on a shared segment with no
  history, **not** — and the output says so.
- Progress: ±30 m. Mode: after ~2 polls. Speed: to the 6 m/s quantum, and only
  above it; it enters only remaining drive (5% of within-hop variance).
- `r`: exact for spells observed since the page loaded; before that, the
  server's stop-pinned clock.
- **Rest remaining given `r`: identifiable at the population level (the
  table), not for an individual bus.** Nothing in the feed says when a driver
  intends to pull out. This is 71% of the error budget and the posterior
  carries it as an interval instead of hiding it in a point.
- Hop times ahead: population only (own-bus pace measured harmful, +18.5 s).
  Traffic lights: observable as spells, inside `hold`, not predictable ahead.
  Mass/inertia: not identifiable.

### Validation

Against the rider-centric accelerated replay when it lands (unit = one
person's wait at one stop): median error, calibration of the 10–90 interval,
per-wait sequence stability, departure behaviour on the four browser-observed
incidents. Three arms — production, the nested no-`r` model, the full
posterior — plus the transition-level tables here as a regression guard. The
filter arms above are not candidates.

## Scripts

- `scripts/eta-replay/belief-scoreboard.ts` — the transition-level scoreboard:
  JSONL corpus (deduplicated across day files), production detector, real
  gated `computeUpcomingArrivals` as `shipped`, replica guard, per-arm internal
  attribution, wrap/jitter split, pass-resolved truth, layover departure
  episodes (plateau walk-back), the verifier's paired departure metric, and
  fixed-target incident traces.
- `scripts/eta-replay/arrivals-anchored.ts` — the replica with an anchor
  override and a diagnostics channel, re-derived from `arrivals.ts` at 972c5ba.
- `scripts/eta-replay/progress-filter.ts` — the off-path reset fixed (hold the
  belief, widen the perp budget, never jump to progress 0).
- `scripts/eta-replay/priors.ts` — the `last_stop_id` table, P(stops | pass),
  speed distributions, hold share.
