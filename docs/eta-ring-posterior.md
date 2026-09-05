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
under the collector's 125 m rule).

**The observation model is the deadband**: a repeated fix means the bus is in
the same cell; a fresh fix means it changed cell and is near the new
coordinate (σ = 20 m, plus an off-route mixture weight so a detour keeps its
branch until the evidence accumulates). The per-poll emissions are the
measured ones — P(repeat | standing) 0.919, P(repeat | moving) 0.159, 0.5
inside a stop's zone where buses pull in and out — and they enter BOTH
branches of the joint transition, so a standing hypothesis pays for a fresh
fix as a moving one pays for a repeat.

**A move off a stand is a departure or a reposition**, and the split is the
competition of two rates: the stop's own departure hazard at the time already
stood, read off its stand table, against a per-poll reposition rate. One
minute into a 344 Winchester layover a move is a shuffle (P ≈ 0.08); five
minutes in it is a coin toss; at a kerb stop with a 30 s median it is the bus
leaving (P ≈ 0.9), which is the collector's pooled 0.76 recovered from the
tables rather than assumed. A first step that lands on a stop cell is
captured there as an arrival, like any other.

**The stand's identity is where the bus came to rest**: once a repeated fix
(or the server clock) shows a rest, the stop whose zone holds the standing
mass is the stand's stop, and every standing cell within the 125 m rest
radius belongs to it — whichever side of the marker the yard put the bus —
except a cell at another stop's own kerb. Shuffles reach four cells either
way inside that radius and nowhere else. On a fold the stop is chosen from
the belief, not from geometry, so a rest beside twin stops (130 Prospect
(N)/(S), 28 m apart) lands on the branch the bus is on.

**One observation per poll.** A step is taken only for a new payload object at
least 2.5 s after the last; every other call — the map, the cards, the chip,
each with its own clock — is a query of the stored belief. (Stepping on each
render fed the filter "the bus did not move" observations that never
happened, and a rendered clock behind the last step re-initialised it: the
review's first finding, invisible to the simulator, which polls once.)

The kernel's speed is the hop's own (road metres over the median drive) and
its far tail scales with it, so West Campus legs at 12–20 m/s are tracked
instead of dead-reckoned at 7 m/s; the stop capture uses each stop's P(stop).
These live on the ring, shared by every call site, and are set when the
tables are built.

The screen's leg is the argmax with hysteresis only where it is needed: a leg
ahead is followed one at a time once 0.8 of the mass has passed the stop; a
leg far away (a fold, a lap) needs 0.8; a leg behind is held for five
minutes. A yard reverse never reads as "behind": standing mass in the rest
radius belongs to the rest stop.

## 2. Price: distributions, summed once (`dist.ts`, `tables.ts`, `arrival.ts`)

Every table is a survival curve over the served quantile knots, interpolated
LOG-LINEARLY (a constant hazard on each segment) and continued past the last
knot at the last segment's hazard — no parametric family, no forced closing
knot, no saw-tooth. On 344 Winchester's table the residual median by elapsed
time used to read 79 s at 420 s, 120 at 480, 33 at 800 and 87 at 840; it is
now smooth in r and a bus that has out-sat every recorded stand is promised
the mean excess its own tail shows.

Stands are shrunk toward the ROUTE'S OWN pool of stops of the same class —
layover (median ≥ 120 s) or kerb — with an effective prior size of three
visits, so a thin layover cell leans on the other layovers' shape and never
on a kerb stop's. A stop the route visits twice has a table per occurrence
(`dwells[r]["<id>#<index>"]`, served for routes 9 and 10 where the two passes
differ). Drives shrink toward road metres × the route's pace with k = 8.

A chain from a situation (leg, mode, mass) to a stop is
`start + Σ (S_s + D_s)`; the residual stand `(S_j − r | S_j > r)` is the
survival form `hopPricing.ts` already bills at the median. Sums are taken by
stratified common-random-number sampling (K = 256, one fixed permutation per
term) against precomputed prefix sums along the ring, so a chain is one
vector subtraction and the number is a deterministic function of the belief
and the tables. A hold on the road is not priced on top of the drive:
`leg_sec` already contains the lights. A bus standing AT a stop has arrived
there: that stop's next arrival is now, not a lap later.

A route whose tables carry no measured drive (the grocery lines, until they
have `legs`) is priced by the legacy arithmetic, and so is a route whose
published line cannot be traced through its stop sequence (a leg bridged with
a chord): that is Green, whose buses call at West Haven station before
Building 900 on the return, so the served leg times carry a station stop
inside an 11 km highway hop and no model on that ring can be right (the
gps-replay put the model at 415 s median against the legacy's 289 on Green,
and every other line better). The dispatch is data-driven; the open item is
Green's sequence, upstream.

## 3. Display: a decision rule (`arrival.ts`)

Per (bus, stop): `eta` = quantile τ of the lead cluster, `low`/`high` = its
10th and 90th percentiles. Situations whose medians lie within 12 minutes of
the lead's are one cluster (a bus standing vs just departed); a lap apart they
are not, and the number follows the lead leg's hysteresis instead of racing
across the gap as a branch weight passes 0.5 — #88's failure. While another
cluster still holds a fifth of the mass, the RANGE comes from the full
mixture, so a 50/50 fold does not read as "17 s [13–23]". τ ships at 0.5.

The #119 clamp stays, as a display rule keyed on the stand's identity: while
the lead is still inside the rest radius — standing or shuffling — the shown
remainder may pause and never climb; it releases the poll the bus leaves the
radius. A lead driving on elsewhere is never clamped.

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

