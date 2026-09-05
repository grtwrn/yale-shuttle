# The ETA on the ring: one probabilistic model, and what it replaced

**Status: built 2026-09-04/05, behind a route allowlist (Red).** Code:
`services/shuttle-v2/web/src/eta/` (`ring.ts`, `filter.ts`, `dist.ts`,
`tables.ts`, `arrival.ts`, `index.ts`), dispatched from
`computeUpcomingArrivals` in `web/src/arrivals.ts`. Server fields:
`segments[r]["A-B"].dq/dqn`, `dwells[r][stop].pstop`, top-level `pace` and the
`segments[r]["__pace"]` carrier (`src/calibrator/calibrator.ts`,
`src/server/v1compat.ts`). Measurement: `scripts/eta-replay/rider-sim/`
(paired against master), `scripts/eta-replay/gps-replay.ts` (`PAYLOAD_PATCH`,
`MODEL_ROUTES`), `scripts/eta-replay/model-patch.ts`.

Read `docs/eta-error-budget.md`, `docs/eta-estimator-design.md` and
`docs/rider-sim.md` first: they hold the measurements this design rests on and
the negative results it must not repeat (EMA, constant-velocity Kalman, the
Gaussian-sum IMM of PR #88, slew limiters).

---

## The question, and what is knowable

One question per bus: **given everything observed, what is the distribution of
the instant it reaches each stop?** The measurements say what the answer is
made of:

| term | knowable? | how |
|---|---|---|
| where the bus is on the loop | to ±30 m, the feed's deadband | a posterior over cells on the published line |
| whether it is standing or moving | after one or two polls | the deadband: a repeated fix is "same cell" |
| how long a standing bus will still stand | **only as a distribution**, given how long it has stood | the stop's stand table, conditioned on the elapsed clock |
| how long each drive ahead takes | as a distribution, tight (5% of within-hop variance) | `legs.leg_sec` quantiles per hop |
| whether it stops at each stop ahead | as a probability | the mass at zero of the stand table |
| which of two coincident legs (a fold) | while moving, from two fixes; while standing with no history, **not** | both carried; the display holds the lead with hysteresis |

Standing time is 71% of the error budget and nothing in the feed says when a
driver pulls out. Headway to the leading bus was measured first, as the plan
required, and **does not help**: R² 0.04 at 344 Winchester (n = 53), 0.00 at
Union Station (N) (n = 56), stand quantiles by gap tercile within noise. It is
not in the model.

## 1. State: a distribution on the ring (`ring.ts`, `filter.ts`)

The route's published polyline is cut into cells of 30 m — the sensor's own
quantum — with a cell on every stop (`traceStopLegs`, the same projection that
fixed the drawn route lines). The hidden state is (cell, STAND | MOVE); the
elapsed clock is observed (`stationary_since`, or the client's own rest clock
with the collector's 125 m rule).

**The observation model is the deadband**: a repeated fix means the bus is in
the same cell; a fresh fix means it changed cell and is near the new
coordinate (σ = 20 m). That is exact on the grid. A standing bus that reports
a fresh fix has departed or shuffled, split 0.76 : 0.24 — the collector's own
measured departure prior — and the next poll settles it (a departure moves
again, a shuffle re-freezes). Shuffles are bidirectional within a stop's zone
(a yard reposition is not progress); progress is forward-only.

The kernel is table-free: it reads geometry and the feed, so
`resolveAnchorIndex` runs the same step with the arguments it already has and
the map marker, the "N stops away" column and the countdown come from one
posterior. Mass flows along every allowed transition every poll, so the
filter cannot branch-lock (docs/eta-estimator-design.md, "The branch lock").

The screen's leg is the argmax with hysteresis only where it is needed: a leg
ahead is followed one at a time; a leg far away (a fold, a lap) needs 0.8 of
the mass; a leg behind is held (the ring rule) for five minutes.

## 2. Price: distributions, summed once (`dist.ts`, `tables.ts`, `arrival.ts`)

Every table is a piecewise-linear CDF over the served quantile knots — no
parametric family. Stands shrink toward the ordinary-stop prior with
k = 2 (k = 8 pulled 344 Winchester's median from ~300 s to 184 s on the
recorded pass; the prior is a different *shape*, so only thin cells lean on
it); drives shrink toward chord × route pace with k = 8.

A chain from a situation (leg, mode, mass) to a stop is
`start + Σ (S_s + D_s)`; the residual stand `(S_j − r | S_j > r)` is the
survival form `hopPricing.ts` already bills at the median. Sums are taken by
stratified common-random-number sampling (K = 256, fixed permutations per
term) against precomputed prefix sums along the ring, so a chain is one vector
subtraction and the number is a deterministic function of the belief and the
tables. A hold on the road is **not** priced on top of the drive: `leg_sec`
already contains the lights.

## 3. Display: a decision rule (`arrival.ts`)

Per (bus, stop): `eta` = quantile τ of the lead cluster, `low`/`high` = its
10th and 90th percentiles. Situations whose medians lie within 12 minutes of
the lead's are one cluster (a bus standing vs just departed); a lap apart they
are not, and the number follows the lead leg's hysteresis instead of racing
across the gap as a branch weight passes 0.5 — #88's failure. τ ships at 0.5.

The #119 clamp stays, as a display rule: while the lead is in a stop's zone,
the shown remainder may pause and never climb, keyed on the clock so a yard
shuffle does not reset it, released the poll the bus leaves the zone.

## What the existing rules became

| today's rule | in the model |
|---|---|
| `findRouteAnchor` candidates < 150 m, road not chord | emission over cells on the polyline |
| `gateAnchor` rules 1–4 | the transition kernel: forward-only, speed-bounded |
| `noteFix` direction filter | two consecutive fresh-fix emissions |
| `last_stop_id` excludes within 5 hops | a tempered categorical likelihood, on change only |
| `standingAt` memo, 125 m hold radius | STAND mass in the stop's zone; the rest clock |
| approach zone (200 m, 150 s, 120 s typical) | the layover stop's approach cells, priced as that stop |
| yard shuffle (#67) | bidirectional shuffle kernel; the clock survives |
| 75 m publication flash | `at_stop_id` is not an input |
| stall credit and its three bounds | the residual distribution given `r` |
| chord proration | `D_i × (1 − t)` on the drive only |
| ±1σ band | q10–q90 of the mixture |

## Measurement

### gps-replay, Red, 2026-09-04 15:51–22:04 ET (6.2 h, 21k pairs, next 1–5 stops)

Both arms in one process, same `PAYLOAD_PATCH` (model-patch-0904), same
per-vehicle store, `MODEL_ROUTES=""` vs `"3"`. Error = promise − truth,
negative = the bus came later than promised.

| truth | arm | median \|err\| | p90 | median bias | pessimistic ≥120 s (bus beat the promise) | optimistic ≥120 s | within 120 s | 10–90 interval covers |
|---|---|---|---|---|---|---|---|---|
| proximity (45 m) | legacy | 52.8 s | 248 | −5.5 | **10.1%** | 13.4% | 76.5% | 65.8% (±1σ band) |
| proximity | model | 49.4 s | 264 | −22.6 | **4.4%** | 19.8% | 75.8% | **76.6%** |
| detector | legacy | 54.9 | 248 | +20.3 | 12.9% | 11.5% | 75.7% | 62.5% |
| detector | model | 53.4 | 248 | +4.0 | 5.7% | 17.2% | 77.1% | 71.2% |

The median is a wash; the dangerous tail — a rider told five minutes for a bus
two minutes away — is halved, and the safe tail grows by the same amount:
the model sums medians of right-skewed stands where the legacy summed means.
The interval is close to its nominal 80% on Red (it is the legacy's ±1σ, not a
quantile, that reads 66%).

### rider-sim, 9/3 capture (13:51–24:00 UTC), paired against master 2a5568c

Same capture, snapshot `snap-0904-2205.db`, tables bounded at 9/3 end
(`model-patch-0903.json` for the candidate, `split-patch-0903.json` for
master — the same `q`/`drive`), 8,199 paired waits. Green and Purple are
untouched (the allowlist), byte-identical.

**The 344 Winchester chain, stop by stop (675 waits):**

| stop | strand | jump ≥180 s | jump ≥300 s | reversal ≥60 s | first miss | p90 drift |
|---|---|---|---|---|---|---|
| Winchester / Division (146) | 9.6 → 6.1% | 12.2 → 2.6% | 5.2 → 0 | 6.1 → 8.7% | 80 → 80 s | 235 → 170 |
| Division / Sheffield (49) | 38.6 → 14.0% | 12.3 → 0.9% | 5.3 → 0 | 6.1 → 5.3% | 91 → 68 s | 230 → 170 |
| **Division / Prospect (48)** | **21.7 → 3.5%** | **16.5 → 0%** | 5.2 → 0 | 6.1 → 3.5% | 85 → 70 s | 235 → 170 |
| Prospect / Hillside (104) | 7.1 → 3.6% | 12.5 → 0% | 5.4 → 0 | 10.7 → 3.6% | 62 → 74 s | 230 → 170 |
| SCL (113) | 4.5 → 0% | 18.0 → 0% | 5.4 → 0 | 10.8 → 5.4% | 64 → 83 s | 235 → 170 |
| 130 Prospect St (S) (4) | 0.9 → 1.9% | 16.7 → 1.9% | 5.6 → 0 | 6.5 → 5.6% | 70 → 106 s | 253 → 170 |

Departure poll (657 watching riders): displayed drift ≥180 s on **38 → 0**
riders, p90 0 → 0 s; the raw number 30 s after `at_stop` clears sits 15 → 27 s
beyond the clock (the reposition prior holds a little mass at the stop for two
or three fixes).

**Red as a whole (6,021 scored waits):** first-promise |miss| median 54 → 40 s
(early >60 s 26.2 → 24.2%, late 20.3 → 17.3%); jump ≥180 s 11.3 → 10.6%; jump
≥300 s 6.1 → 2.0%; strand 6.1 → 3.2%; pin changed 9.2 → 4.3%; dropped while
approaching 4.5 → 3.4%; reversal ≥60 s 5.6 → 7.6%; worst drift p90 230 → 190 s,
max 1570 → 595 s; the 10–90 interval at first sight covers 78% (12.4% earlier,
9.6% later).

**Paired, FIXED / INTRODUCED (Red, 7,107 waits):** strand 406 / 162, jump ≥180 s
552 / 369, dropped 265 / 194, **reversal 398 / 510**; worst drift improved
3,276 / worsened 1,518 / same 2,800; first-promise |miss| improved 2,275 /
worsened 1,573.

The reversal is the one column that is net worse, and its mechanism is
known: a bus leaving a depot stop that pulls out, reverses into the yard and
sits (Red #304 at 14:06Z on 9/3 went 85 m past 344 Winchester, back 130 m,
sat a minute, then left). The reposition prior after a long stand halved the
count (580 → 510 introduced); what is left is the number honestly following a
bus that really did turn round. The next lever is a per-stop reposition prior
from `stop_visits.shuffles`, which the calibrator does not serve yet.

### rider-sim, 9/4 capture (the re-dumped window: 9/3 09:51 – 9/4 22:15), paired against master

18,460 paired waits (Red 15,530), `model-patch-0904.json`. Chain, Division /
Prospect (261 waits): strand 19.5 → 3.4%, jump ≥180 s 13.8 → 0.4%, reversal
3.8 → 2.3%, p90 drift 230 → 170 s; departure-poll ≥180 s riders 38 → 6. Red
(12,809 waits): first-promise |miss| 50 → 45 s, strand 6.1 → 2.0%, jump ≥180 s
13.8 → 6.7%, jump ≥300 s 2.9 → 1.5%, pin changed 7.9 → 5.1%, dropped 2.0%,
reversal 5.1 → 7.1%, worst drift p90 230 → 170 s, interval coverage 78.7%.
Paired FIXED / INTRODUCED: strand 890 / 196, jump ≥180 s 1,751 / 629, dropped
442 / 226, reversal 674 / 1,107; worst drift improved 8,152 / worsened 2,453.

### The three archived Red riders at Division / Prospect (docs/rider-sim.md acceptance cases)

| rider | master (2a5568c) | ring estimator |
|---|---|---|
| #309, 21:21Z | miss −125 s, worst drift 115, no strand; `5 → 4 → 1 → <1 → now` | miss −125 s, drift −170: `5 → 1` at 21:25:52, then "in 1" for 3.5 min to the kerb |
| #316, 20:36Z | miss 0, drift 55; "in 4" held 3 min, `3 → 2 → 1 → now` | miss +15, drift −55; "in 1" from 20:40 to the kerb at 20:47 |
| #304, 20:58Z | **strand**: `4 → <1`, bus 66 s later | no strand: `5 → 1 → 1 → 4 → 1 → <1 → now` (one reversal) |

The strand is gone; what replaces it is the honest residue of a stand that
has out-sat its table (#316 stood 12 min against a p95 of 10) and of a depot
bus that pulls out and pauses (#309, #304). Nothing in the feed says when a
driver intends to go; the interval carries it, the point cannot.

