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
coordinate (σ = 20 m, plus an off-route mixture weight — derived as the
off-route share × the Gaussian's peak over the band a stray fix can land in,
~1e-5 on Red — so a detour keeps its branch until the evidence accumulates,
while a fix on the road behind a stop out-scores "drove on" outright; a
guessed 0.02 there let a yard reverse read as driving on). The per-poll emissions are the
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
(N)/(S), 28 m apart) lands on the branch the bus is on; and it is chosen
only when that stop's zone holds the MAJORITY of the standing mass in the
mask — a hold 190 m past a stop has the stop's kerb inside its 125 m mask,
and a sliver of mass there must not re-attach the rest to the stop the bus
just left.

**The rest's clock is its earliest known origin.** The served clock is read
into it, but never replaces it: the collector's clock restarts when the bus
moves 125 m from where the COLLECTOR saw it come to rest — a different point
from this filter's — and switches source between `at_stop_since` and
`stationary_since` from poll to poll. Read directly, a shuffle inside a
layover restarted the residual stand from zero (Blue Night #40, 22:40Z 9/3:
237 → 749 s two minutes before it left, a strand for every rider down the
line), and the source switch flapped every Red number a bucket at each kerb
stop in the simulator — invisible to a script trace that never fed the
at-stop clock. The stand tables are arrival-to-departure at the stop, so the
time since the rest began is the clock they were measured with.

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

A rest that happens off every stop — a yard by the terminus, a relief run —
is in no stand table (those are pinned within 75 m of a stop), but the leg
it lies on carries it: a drive whose median exceeds road metres × pace by a
layover's length. On the 9/4 tables that is Blue West's last hop (960 s for
1,044 m against 167 s of driving), Blue Night (587 vs 204), Orange East
(500 vs 274) and Brown (476 vs 324). The excess, quantile by
quantile, is the hop's hidden stand (`tables.ts` `hiddenRest`), and a bus
HOLDING mid-leg on such a hop is priced as that rest continuing given the
time already stood, plus the free-flow drive left — not as a fraction of a
sixteen-minute "drive", which read a bus twelve minutes into a yard rest as
eight minutes of driving away (Blue West's optimistic ≥120 s tail, 6 → 27%
on the gps-replay before this term).

A route whose tables carry no measured drive (the grocery lines, until they
have `legs`) is priced by the legacy arithmetic, and so is a route whose
published line cannot be traced through its stop sequence (a leg bridged with
a chord): that is Green, whose buses call at West Haven station before
Building 900 on the return, so the served leg times carry a station stop
inside an 11 km highway hop and no model on that ring can be right (the
gps-replay put the model at 415 s median against the legacy's 289 on Green,
and every other line better). The dispatch is data-driven; the open item is
Green's sequence, upstream.

## 3. Display: a decision rule (`arrival.ts`, `filter.ts`)

Per (bus, stop): `eta` = quantile τ of the LEAD LEG's mixture — its standing
and moving variants weighted by their mass, so the departure lands on the
poll it is seen (the operator's "5 → 1 when it leaves") — `low`/`high` = its
10th and 90th percentiles. The lead LEG is a decision made in the filter,
not a functional of the posterior: it follows the mass forward once it has
left the previous leg (0.8), jumps far only at 0.8, and holds against a leg
behind it for five minutes (`leadLeg`). A situation on another leg is an
alternative — the other branch of a fold, a lap away, a cold belief's guess
two stops back — and never enters the number: mixed in by nearness, a 0.65
guess that the bus stood two stops back turned "in 1" into "in 5" on a
rider's second poll; raced across the gap by mass, it was #88's median.
While the lead leg holds less than 0.8 of the mass, `low`/`high` widen to
the full mixture, so a 50/50 fold does not read as "17 s [13–23]". τ ships
at 0.5.

**A shown MODE decided with hysteresis was tried and withdrawn.** Deciding
standing vs moving on the leg (switch at 0.6, then "only once the mass is
beyond the rest radius") held the standing number until the bus had cleared
125 m, and the simulator priced that on the operator's own test: Division /
Prospect strands 0 → 7.8%, 59 chain riders shown a stale number on the
departure poll, the collapse arriving as a ≥180 s jump. The flapping it was
meant to cure — one bucket out and back on every creep — turned out to be
the served clock switching source between polls (§1, the rest's clock), not
the mixture.

The #119 clamp stays, as a display rule keyed on the stand's identity: while
the lead stands, the shown remainder may pause and never climb; while it
moves the floor is neither applied nor updated but kept, so a depot bus that
pulls out and reverses into the yard returns to the number it showed before,
not to the drive-only figure of the moving spell; the floor ends with the
rest (the clock changes). A bus moving inside its own layover's radius, on
the leg into the stop, is priced as the rest continuing, not as an arrival
with a whole new stand on top.

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

### gps-replay, every line, 2026-09-04 15:51–22:04 ET (6.2 h, 205k pairs, next 1–5 stops)

The production arm and the model in one process, same `PAYLOAD_PATCH`
(model-patch-all-0904), same per-vehicle store. Proximity truth (45 m).
Green is declined by the model (bridged ring) and is byte-identical.

| | median \|err\| | p90 | median bias | pessimistic ≥120 s | optimistic ≥120 s | within 120 s | 10–90 covers |
|---|---|---|---|---|---|---|---|
| production | 92.1 s | 537 | +7.1 | 24.1% | 18.4% | 57.5% | 54.6% (±1σ) |
| ring estimator | **60.2 s** | **431** | −7.9 | **14.8%** | 16.7% | **68.5%** | **76.6%** |

| route | median \|err\| | pessimistic ≥120 s | optimistic ≥120 s | interval covers |
|---|---|---|---|---|
| Blue Day | 43.8 → 35.3 | 12.0 → 7.8 | 7.2 → 6.3 | 81% |
| Orange Day | 36.6 → 28.1 | 10.7 → 5.0 | 2.1 → 3.6 | 84% |
| Red | 52.8 → 47.6 | 10.1 → 4.8 | 13.4 → 19.0 | 76% |
| Pink | 178.7 → 106.0 | 13.0 → 9.4 | 49.0 → 36.4 | 68% |
| Green (declined) | 288.8 → 288.8 | 56.1 → 56.1 | 8.2 → 8.2 | 51% |
| Purple | 207.1 → 102.9 | 41.3 → 25.3 | 25.0 → 22.0 | 76% |
| Blue Night | 113.5 → 71.0 | 28.5 → 13.3 | 19.4 → 18.8 | 79% |
| Orange Night | 54.5 → 39.4 | 5.3 → 3.0 | 16.0 → 9.1 | 83% |
| Gold | 68.7 → 55.4 | 13.2 → 7.4 | 17.4 → 20.9 | 80% |
| Blue West | 96.0 → 47.5 | 38.0 → 4.5 | 6.3 → 16.6 | 92% |
| Orange East | 85.1 → 48.1 | 15.2 → 3.5 | 21.6 → 16.5 | 90% |
| Brown | 212.2 → 79.9 | 32.8 → 12.7 | 30.7 → 27.4 | 79% |

The dangerous tail — a rider told five minutes for a bus two minutes away —
is cut by two fifths and the interval is at its nominal 80% on the downtown
lines, honest about the West Campus and VA folds (68–76%). Detector truth
tells the same story (103.7 → 75.9 s median, coverage 51 → 65%).

### gps-replay, Red only (the first pass), 2026-09-04 15:51–22:04 ET (6.2 h, 21k pairs, next 1–5 stops)

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
(`model-patch-all-0903.json` for the candidate, `split-patch-0903.json` for
master — the same `q`/`drive`), 8,246 paired waits. Green is declined by the
model (byte-identical); Purple runs on it.

**The 344 Winchester chain, stop by stop (675 waits):**

| stop | strand | jump ≥180 s | jump ≥300 s | reversal ≥60 s | first miss | p90 drift |
|---|---|---|---|---|---|---|
| Winchester / Division (146) | 9.6 → 10.4% | 12.2 → 5.2% | 5.2 → 0 | 6.1 → 2.6% | 80 → 80 s | 235 → 168 |
| Division / Sheffield (49) | 38.6 → 9.6% | 12.3 → 5.3% | 5.3 → 0 | 6.1 → 6.1% | 91 → 75 s | 230 → 170 |
| **Division / Prospect (48)** | **21.7 → 0%** | **16.5 → 5.2%** | 5.2 → 0 | 6.1 → 7.0% | 85 → 80 s | 235 → 115 |
| Prospect / Hillside (104) | 7.1 → 0% | 12.5 → 5.4% | 5.4 → 0 | 10.7 → 8.0% | 62 → 74 s | 230 → 115 |
| SCL (113) | 4.5 → 0% | 18.0 → 5.4% | 5.4 → 0 | 10.8 → 7.2% | 64 → 80 s | 235 → 115 |
| 130 Prospect St (S) (4) | 0.9 → 0.9% | 16.7 → 5.6% | 5.6 → 0 | 6.5 → 2.8% | 70 → 101 s | 253 → 132 |

Departure poll (657 watching riders): displayed drift ≥180 s on **38 → 15**
riders, ≥300 s on 36 → 0; the raw number 30 s after the bus leaves sits
15 → 35 s beyond the clock (the reposition prior holds a little mass at the
stop for two or three fixes — the price of not flinching at a creep). The
one ≥180 s step the chain still shows is the SECOND bus's number resolving
its stand in one −230 s step where master took five smaller ones (#304,
18:02Z, all six stops).

**Red as a whole (6,081 scored waits):** first-promise |miss| median 54 → 40 s
(early >60 s 26.2 → 24.4%, late 20.3 → 17.4%); jump ≥180 s 11.3 → 9.1%; jump
≥300 s 6.1 → 2.6%; strand 6.1 → 1.6%; pin changed 9.2 → 3.9%; dropped while
approaching 4.5 → 1.8%; overshoot 10.3 → 5.6%; reversal ≥60 s 5.6 → 9.0%;
worst drift p90 230 → 170 s, max 1570 → 595 s; the 10–90 interval at first
sight covers 77.4% (12.3% earlier, 10.2% later).

**Paired, FIXED / INTRODUCED (Red, 7,172 waits):** strand 416 / 73, jump ≥180 s
465 / 215, dropped 283 / 97, **reversal 343 / 553**. Purple (474): strand
36 / 50, jump 109 / 49, reversal 139 / 23, dropped 83 / 39.

The reversal is the one column that is net worse, and its mechanism is
known: a bus leaving a depot stop that pulls out, reverses into the yard and
sits (Red #304 at 14:06Z on 9/3 went 85 m past 344 Winchester, back 130 m,
sat a minute, then left), and more generally a bus that creeps a fix and
re-freezes — the posterior follows the evidence out and back, and the number
with it, one bucket. Holding the number until the bus cleared the rest
radius was tried and cost stop 48 its strands (§3); the honest residue stays.

### rider-sim, every line, 9/4 capture (9/3 09:51 – 9/5 03:00 ET), paired against master

`model-patch-all-0904.json`, `HOLDOUT=` (every line on the model), run in
three route groups on the Pi. Paired FIXED / INTRODUCED per route; the
grocery lines and Green are priced by the legacy arithmetic (declined on
evidence) and are noise-level.

| route | waits | strand | jump ≥180 s | reversal ≥60 s | dropped |
|---|---|---|---|---|---|
| Red | 15,622 | 898 / 127 | 1,794 / 309 | 622 / 1,033 | 445 / 99 |
| Blue Day | 14,685 | 329 / 164 | 697 / 197 | 437 / 519 | 304 / 12 |
| Blue Night | 3,061 | 91 / 20 | 1,372 / 93 | 908 / 295 | 972 / 90 |
| Blue West | 1,248 | 162 / 0 | 587 / 24 | 116 / 434 | 142 / 28 |
| Brown | 2,181 | 143 / 29 | 1,412 / 33 | 1,607 / 2 | 1,177 / 0 |
| Gold | 2,592 | 103 / 3 | 1,014 / 247 | 1,146 / 152 | 590 / 6 |
| Purple | 5,521 | **492 / 689** | 1,180 / 616 | 1,497 / 298 | 1,112 / 480 |
| Grocery Ham (legacy) | 340 | 1 / 10 | 1 / 4 | 19 / 10 | 1 / 1 |
| Orange Day | 10,172 | 401 / 63 | 3,228 / 51 | 3,849 / 190 | 1,791 / 0 |
| Orange Night | 4,972 | **33 / 145** | **251 / 444** | 1,141 / 476 | 347 / 6 |
| Orange East | 1,526 | 3 / 0 | 114 / 14 | 451 / 15 | 86 / 1 |
| Pink | 7,021 | **128 / 203** | 3,443 / 286 | 3,521 / 195 | 2,854 / 56 |
| Blue Weekend | 827 | 3 / 1 | 270 / 8 | 375 / 1 | 170 / 0 |
| Green (legacy) | 4,452 | 0 / 0 | 0 / 1 | 0 / 5 | 0 / 0 |

The 344 Winchester chain on this day (1,542 waits), Division / Prospect:
strand 19.5 → 2.7%, jump ≥180 s 13.8 → 0.8%, p90 drift 230 → 115 s;
departure-poll drift ≥180 s on **38 → 0** riders.

**Three columns regress: Purple's strands, Pink's strands, Orange Night's
strands and jumps.** Purple's mechanism is traced (#329, 14:12Z 9/3, `traceany.mts`): on leg 1 (300
George → 100 Church St S) the bus took the parallel one-way street for a
minute — which is leg 13's published line, the return from West Campus —
and sat at a light there. Three fixes on that line, 155 m off leg 1's, and
the position emission moved the whole belief across the fold: the current
leg pays the stray-fix weight on every fix while the other branch fits at
1, so a held branch out-lives about two consistent fixes, whatever the
weight (spread over the loop, 4.6e-6; derived from a local 600 m square,
2.1e-4 — both tried). 328 riders at 100 Church St S read "in 10" for a bus
two minutes away. Re-applying `last_stop_id` (300 George, twelve stops from
anywhere on leg 13) on every poll as a persistent state observation pulled
a tenth of the mass back and left the number oscillating between the legs;
withdrawn. The model that fits is a **shadow-leg detour mode**: a detour is
a persistent lateral offset that follows the leg's geometry, so it pays the
stray weight once, at entry, and predicts the next fix as well as the line
does — a third mode of the HMM, the next piece of work. Until then Purple
trades strands (492 fixed / 689 introduced) for the other three columns
(jumps 1,180 / 616, reversals 1,497 / 298, drops 1,112 / 480) and a median
error halved on the gps-replay.

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


## Velocity on the kernel: measured (2026-09-06)

**Status: built behind a switch, measured, DROPPED — not in the tree.** The
operator (a roboticist) asked: "u can test if velocity helps?"; after the
gps-replay verdict below: "fine drop that." The code (a `MODEL_VELOCITY`
switch on `filter.ts`, with tests) lives only in the session that measured
it; what follows is the measurement, so nobody rebuilds it. The kernel in
`filter.ts` moves MOVING mass forward by a gamma-shaped number of cells whose
mean is the leg's table speed × dt — it has no memory of the bus's own
recent motion. The hypothesis: conditioning it on the observed recent
displacement tracks the bus better, and better tracking cuts the anchor
error — the largest lever the gps-replay names (where the anchor disagrees
with the detector the median error is 359 s against 54 s).

### What was built and measured (V1, a velocity state on the belief)

A per-bus velocity state on the belief: `vObs` = chord metres between the
last two FRESH fixes over their own interval, updated only when the pair is
within 20 s (a repeated fix is the deadband, not zero speed — 54% of samples
repeat; and the first fresh fix after a stand spans the stand, 35 m / 300 s,
so it is not a speed either). Freshness `w = 0.5^(age / 120 s)` — the
half-life is `docs/bus-speed.md`'s measured crossover, where the current
speed stops beating the route average. The kernel's mean for moving mass
becomes `w·v_obs + (1 − w)·v_table` per leg, and its variance the MIXTURE's,
`w·σ_obs² + (1 − w)·σ_table² + w(1 − w)(v_obs − v_table)²`, so it widens where
the two sources disagree rather than keeping the table's shape (σ_table is
the base kernel's own CV, 1/√3; σ_obs the deadband's quantisation of a chord,
√2·30/√12 = 12.2 m, over the pair's interval). The gamma takes that mean and
shape (mean²/var, clamped [1, 12]); the far tail and the stop capture were
unchanged. The transition used the state as it stood BEFORE the fix — the
prediction, then the emission — and the pair updated it afterwards. With
the switch off every step was byte-identical (a test ran a fixture both
ways; the full suite passed with the switch in). The V2 form — a speed
dimension on the grid — was to be built only if V1 moved the numbers. It
did not.

For the measurement `gps-replay.ts` was instrumented (one-off, not kept)
with `leadAgrees` / `leadDisagrees` and a per-route lead-disagreement share:
the CLIENT's own anchor after the poll (the belief's lead leg on a route the
model serves) against the detector. The replay's existing `anchorDisagrees`
rows are the stateless `findRouteAnchor`'s, which the model does not touch,
so that share (11.8%) is identical in both arms by construction; a change
to the filter can only show in the lead rows. Anyone re-measuring the
anchor should re-add that row: it is the store entry's `belief.lead`
(`anchorKeyFor(label, bus_name)`) against `detIdx`, the same ±1 rule as
`agree`.

### gps-replay, every line, 2026-09-04 15:51–22:04 ET (205k pairs, proximity truth, client row)

Two runs, identical inputs (`snap-0904-2205.db`, `model-patch-all-0904`),
`MODEL_VELOCITY` unset vs `1`.

| | off | on |
|---|---|---|
| overall median \|err\| / p90 | 60.2 s / 431 | 60.4 s / 431 |
| moving | 57.8 / 506 | 58.3 / 507 |
| at stop | 63.6 / 325 | 63.4 / 323 |
| moving, next stop | 22.8 | 22.9 |
| by hops 1..5 | 27.2 / 48.9 / 69.6 / 77.7 / 89.3 | 27.2 / 49.1 / 69.7 / 77.6 / 89.7 |
| lead agrees with the detector | 55.0 s (n 181,897) | 55.0 (n 181,569) |
| lead disagrees | 181.6 s (n 23,163) | 176.0 (n 23,491) |
| **lead-disagreement share (k = 1)** | **12.6%** | **12.7%** |
| `findRouteAnchor` disagreement share | 11.8% | 11.8% (by construction) |
| 10–90 covers | 76.6% (width 298 s) | 76.6% (298) |

By route the median moves by at most 1.4 s: Pink 106.0 → 107.3, Blue Night
71.0 → 72.3, Purple 102.9 → 101.9, Brown 79.9 → 79.5, the rest within 0.2 s.
Lead-disagreement share by route: Purple 19.1 → 18.9, Blue Night 23.6 → 25.1,
every other line unchanged to a tenth. Detector truth tells the same story
(75.9 → 76.0 overall; moving 82.4 → 82.6).

### Why a wash, from the feed itself (9/4 capture, 319k rows, 117,793 close fresh-fix pairs)

The pair speed the state is built from is noise at the horizon the kernel
works at. Predicting the NEXT close pair's chord speed for the same bus:

| predictor | MAE (m/s) | median |
|---|---|---|
| the route's median pair speed (≈ the table) | 4.02 | 3.56 |
| the last pair's speed (V1's `v_obs`) | **4.18** | 3.73 |
| 50/50 blend | 3.61 | 3.02 |
| mean of the last two pairs | 3.47 | — |

A single 5 s pair is deadband-quantised at ±15 m each end — ±3 m/s — so on
its own it predicts the next poll's speed WORSE than the table. The blend
recovers a little, and a two-pair window a little more (the window result of
`docs/bus-speed.md` again), but the best of them gains 0.55 m/s over 5 s:
under 3 m of displacement, a tenth of a cell, against an emission that
re-anchors every fresh fix at σ = 20 m. Where the kernel actually carries
the belief — across a repeat spell, when no fix arrives — there is no fresh
pair to update the velocity from either, and it has decayed toward the
table by construction. The transition prior has nothing the observation
does not already say, at the cadence this feed delivers it.

The anchor error the hypothesis aimed at is not a tracking error in the
sense a velocity can fix: the lead disagrees with the detector on the
fold-back lines (Green 35%, Purple 19%, Orange East 16%, Blue Night 24% —
the relief run) where the question is WHICH branch, decided by consistent
fixes over polls, not how far along it the bus has driven in five seconds.
(Blue Night's lead disagrees with the detector four times as often as the
stateless anchor does — 23.6% against 5.2% — which is a finding about the
deadhead, not about velocity, and is left open here.)

### rider-sim, Red 9/3 — not run

Both arms (`MODEL_VELOCITY` off and on, same tree, paired) were started on
the 9/3 capture and killed at poll 0: dropped by the operator after the
gps-replay verdict. There is no chain row and no FIXED / INTRODUCED column
for this variant.

### Verdict

Dropped. Velocity on the kernel is a wash on every gate the gps-replay
has — median error, the moving row, the lead-disagreement share, coverage —
slightly worse on Blue Night, and the feed says why: at one poll a chord
speed is noise the emission already outweighs. Do not rebuild it for THIS
feed. It would be worth re-testing only if upstream ever sends a velocity
field, the deadband narrows below 30 m, or the poll cadence rises — the
switch was one property read and a per-fix haversine, cheap to restore from
this section. V2 was not built.
