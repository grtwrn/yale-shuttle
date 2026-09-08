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
A rest short of a layover that then closes the last metres onto that
layover's marker is the SAME rest, re-centred: see "the second stand" below.

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

### The pooled priors: a line the collector has not timed yet (2026-09-06)

The model declined two classes of route and handed them to the legacy
arithmetic. **One of those declines is gone; the other is deferred, on
evidence, and the numbers are below.**

A route with no measured drive at all used to be one of them — the grocery
lines, which run one weekend and whose legs the retention window often does
not hold. It is now priced from one more level of the same hierarchy, with no
per-route rule anywhere:

- **drive** — hop `dq`/`drive` → the ROUTE's pace → the NETWORK's pooled pace.
  The calibrator pools every route's pace samples into one ten-knot quantile
  vector (`computePooledPace`) and serves it, flagged, to any route with no
  legs of its own (`withPooledPace`; `pace[r].pooled` and
  `segments[r]["__pace"].spmPooled` on the carrier row). On the 9/4 tables that
  pool is **0.1363–0.1535 s/m at the median over n = 9,077 legs** (p10 0.0769,
  p90 0.3357) and it fills two routes, 6 and 18.
- **stand** — the stop's table → the ROUTE's class pool → the NETWORK's class
  pool (`globalClassPools` over the payload's whole `dwells`), layovers with
  layovers and kerbs with kerbs. A route with no table at all prices every stop
  from the network's ordinary pool rather than from a hand-typed constant.

Anything answered from a pool is `measured: false`, so the chain reads
`estimated`, the rider gets the `~`, and the 10–90 range widens with the
pooled quantiles instead of showing a prior as a measurement. `priced` is now
false only for a cold database — no pace anywhere, nothing to put a number on.

**Measured** (gps-replay, both arms, same `PAYLOAD_PATCH`, proximity truth;
`pessimistic ≥120 s` is the dangerous tail — the app named a time the bus beat,
and the rider strolls up and watches it leave). On the 9/4 window every route
is **byte-identical**, overall included. The grocery lines cannot be measured
there at all — they are weekend-only and none runs in it — so the row below
drives 9/6's Sunday buses through the 9/4 tables, which is exactly the state
the change addresses.

| route | n | median \|err\| | p90 | pessimistic ≥120 s | optimistic ≥120 s | within 120 s |
|---|---|---|---|---|---|---|
| **Grocery Ham** | 10,972 | 222.5 → 229.2 | 588 → 684 | **59.1 → 19.7%** | 12.3 → 48.2% | 28.6 → **32.1%** |
| **Blue Weekend** | 15,642 | 165.4 → **154.2** | 595 → 607 | 37.9 → **34.5%** | 24.1 → 24.7% | 38.0 → **40.8%** |
| Green (declined then; see the section below) | 35,876 | 300.2 → 300.2 | — | — | — | identical |
| Purple | 34,736 | 134.9 → 134.9 | — | — | — | identical |
| overall | 97,226 | 188.0 → 185.9 | 877 → 898 | 40.3 → **35.4%** | 22.2 → 26.4% | 37.4 → 38.3% |

Grocery Ham is the case the pools were built for: the dangerous tail falls by
two thirds. It buys that by being late instead — the safe direction — and the
median barely moves. Blue Weekend, whose 31 stops carried two stand tables and
which already had a pace of its own, improves on every column that matters;
that is the network **stand** pools alone.

By 9/6 route 18 has four timed hops and a pace of its own, and both arms then
price it identically; route 6 (Trader Joe's) still had no legs at all and ran
in neither window, so it inherits this row by construction, not by observation.

An ordering inside `hopModel` was tried and **rejected on this measurement**:
serving v1's arrival-to-arrival `avg` (which CONTAINS the stand at A) ahead of
the pace prior looks more principled — a measurement of the hop beating a prior
that knows only its length — and it is better on Blue Weekend (median
154 → 122). It is much worse where it counts: Grocery Ham's dangerous tail goes
59.1 → **75.4%** instead of 19.7%, and Pink, which has one such hop, loses 6 s
of median. The pace prior stays ahead of `avg`.

### Green: the published order was wrong, and the ring is now built on the driven one (2026-09-07)

**Status: shipped.** `src/network/alignStops.ts`, `TransitNetwork.build`
(`Route.publishedStops`), `web/src/eta/ring.ts` (`ring.stops` / `ring.order` /
`ring.repaired`). Green was the app's worst line by every measure — a
gps-replay median of 288.8 s against ~60 s elsewhere, and the canary flapping
43 ↔ 55 min on it all Sunday — and the only line the model declined, because
`buildRing` could not trace its published stop sequence along its published
polyline and bridged three legs with chords.

**The diagnosis, and the correction to what this document said.** It was not
the geometry, and the sequence was wrong in a different way than recorded here.
The published polyline passes, in this order:

    ... Building 800, Building 900, West Haven station, Bradley (N) ...

and the published stop LIST says

    ... Building 800, West Haven station, Building 900, Bradley (N) ...

The line is right. Over the snapshot's three months of `arrivals`, Green's
buses drive the line's order, not the list's: **2,943 consecutive
Building 800 → Building 900 arrivals against 1 for Building 800 → station**,
then 676 Building 900 → station and 666 station → Bradley (N). (This document
previously said the buses "call at West Haven station before Building 900 on
the return"; they call there *after* it. The claim was never measured.) The
list is also short of a stop: the line passes the station TWICE, out and back,
and the buses call there both times — 676 station → Building 900 arrivals on
the way out to match the 676 the other way — while the list names it once.

Reconstructed lap by lap (arrivals cut at a per-route anchor, 847 laps in the
28 days to 9/4), the modal lap is
`… Bradley → STN → B900 → B800 → B750 → B600 → B400 → B600 → B750 → B800 →
B900 → STN → Bradley …` on 52% of laps, and the West Campus block runs in that
order on 2,221 of 2,949 contiguous blocks — never in the published one.

**So the mechanism reads the order off the LINE**, which is the same move that
fixed the drawn route lines ("the published geometry is right, drawing it was
wrong"), and it needs no service history at all: a route new this morning gets
it. `alignStopsToPath` gives every stop its CANDIDATE PASSES (the local minima
of its distance to the line, within `MAX_STOP_OFFSET_M` = 200 m), then a
dynamic program walks the published order and assigns each occurrence a pass
that does not go backwards along the line, minimising first the number of
occurrences it must SKIP and then the total offset; each skipped occurrence is
placed afterwards at the pass that disturbs the published order least. A stop
the line drives past for more than `SPUR_LEG_M` (2 km) inside one leg, that no
occurrence claimed and that is `SPUR_SEPARATION_M` (200 m) from every pass
already used, is ADDED — that is the station's outbound call.

On Green that is **one move and one addition out of 23**, and the answer is the
driven order exactly, with a median offset of 4 m and a worst of 99 m
(Building 800's outbound pass, where the marker is at the building and the road
runs behind it). The legs are slices of the published line and sum to it:
29,086 m drawn of a 29,086 m loop, against 36,270 m before, 7 km of which was
chord straight through West Haven.

**It is the trigger and the guards that make this a no-op elsewhere.** The
repair runs only where the published order's own trace BRIDGES a leg, which on
the fifteen published lines is Green alone; the other fourteen rings are
byte-identical, cell for cell, and a test measures it. Two guards then refuse a
repair that is not a correction:

- **Two occurrences may not stack on one pass.** A small out-and-back bridges
  its return leg by construction — it covers most of a short loop — while its
  published order is perfectly right; asked to repair that, the assignment can
  only put a repeated stop's two occurrences on the one pass the line makes,
  i.e. a hop from a stop to itself.
- **At most one occurrence in ten may move** (`MAX_MOVED_FRACTION`). A line
  published COUNTER to its stop list — the "whole route painted solid" defect a
  rider once reported — bridges every leg and would be "repaired" by reversing
  the list. There the list is right and the LINE is the defect; reversing it
  would run the estimator round the route backwards. Past the bound the route
  keeps its published order, its bridged ring and the legacy arithmetic, and
  `derivePath.ts` is the remedy for the geometry.

**The server holds the repaired order too, and that is where most of the win
is.** `TransitNetwork.build` applies it before anything is built on it, keeping
upstream's list as `Route.publishedStops`; `/api/buses` still publishes THAT
(the map and the planner draw and list exactly what upstream sent) and carries
segment rows for both adjacencies, so the legacy arm keeps its keys. The reason
this matters: with the station missing from the outbound, a bus that stopped
there anchored nine hops ahead and the detector discarded the leg for exceeding
`MAX_SEGMENT_HOPS`, so **Green's longest hop had no measured drive at all** and
was priced at the route's downtown pace — 11.7 km × 0.134 s/m = 1,573 s against
a real 675 s. On the repaired order every one of the 24 hops is billed, n ≈ 57
each over 36 h of capture: Bradley (S) → station 694 s over 9,353 m,
station → Building 900 261 s, Building 900 → station 226 s,
station → Bradley (N) 538 s.

**Measured** (gps-replay, 9/4 15:51–22:04 ET, 226k pairs, proximity truth; both
arms on tables re-derived from the same capture by the collector's own reducer,
so the only difference between them is the stop order):

| Green, 22,610 pairs | published order (legacy) | repaired ring (model) |
|---|---|---|
| median \|err\| | 288.8 s | **70.1 s** |
| p90 \|err\| | 2,817 s | **500 s** |
| median bias | +247.6 s | **−2.7 s** |
| pessimistic ≥120 s (the bus beat the promise) | 56.1% | **12.1%** |
| optimistic ≥120 s | 8.2% | 23.9% |
| within 120 s | 35.7% | **64.1%** |
| 10–90 interval covers | 50.5% (width 825 s) | **71.8%** (width 369 s) |

The bar this had to clear was the legacy arm's own 288.8 s median and 56.1%
dangerous tail — what riders got — and it clears both by a factor of four. The
optimistic tail grows, which is the safe direction and the West Campus fold's
signature (Pink and Purple read the same way).

**Every other route is unchanged to within 0.2 s of median, 0.2 pp of any tail
and 1.3 s of p90**, and their rings are byte-identical. The residue is not the
ring: route 9's stand tables and its 24 legs enter the ALL-ROUTES class pools
and the pooled pace, which every route leans on by design.

**On deploy the new hops warm up from zero, and nothing is miskeyed.** The
route's `stop_index` / `from_index` change meaning, so rows written before the
change are keyed to slots the repaired ring does not ask for and are simply
ignored — the one (stop, index) pair that coincides, `26#19` (Building 900 on
the return), means the same thing in both orders. Three hops have no history at
all because the old order could never bill them (`81-127`, `26-127`, `127-80`),
so for their first day they price from the route's pace and read `estimated`;
the per-pass stand tables inside West Campus fall back to their pooled stop
table for up to `SPLIT_WINDOW_DAYS`. The measurement above is the steady state:
both arms ran on tables re-derived from the same 36 h capture.

Two smaller things the order still does not describe, both left as measured
open items: Green's buses call at Building 750 on the OUTBOUND pass too (the
line passes it, and 2,221 of 2,949 West Campus blocks stop there), which the
list omits and the spur rule does not reach because that leg is 236 m; and the
station is served on only about a quarter of laps, so its stand table mixes a
seven-minute layover with a drive-through.

The canary's Sunday case replayed through the real client entry point
(`computeUpcomingArrivals`, route 9, #326, 2026-09-06 18:55–19:35 UTC, a rider
at Building 600 bound for Orange / Humphrey (N)):

| | published order | repaired ring |
|---|---|---|
| Building 600, 18:55 → 19:05 | 16.3 → 6.0 min, then a jump to 49.7 | 14.5 → 2.9 min, monotone |
| the wait after that, 19:22 → 19:31 | wanders 55.3 → 48.7 → 49.4 → 42.6 | counts down 49.7 → 44.4 |
| destination, 18:55 → 19:05 | 56.4 → 46.1, then −28 min to 18.1, then back up to 23.7 | 39.1 → 26.7, monotone |

### The legacy arithmetic is deleted (2026-09-07)

**Status: shipped.** With the two declines closed — the grocery lines by the
pooled priors above, Green by the repaired ring above — the anchor + gate +
stall-credit + approach-zone + chord-proration stack had no caller left, and
keeping a second estimator that nothing selected was the whole cost of the
first arm. Deleted from the client: `web/src/anchorGate.ts`,
`web/src/hopPricing.ts`, `findRouteAnchor` and its dials in
`web/src/anchor.ts`, the fallback half of `computeUpcomingArrivals`
(`stallCreditSec`, the approach zone, `billedDwellSec`, chord proration), the
gate half of `web/src/liveAnchor.ts`, `LEGACY_SPLIT_ROUTE_IDS` /
`splitServedForRoute`, and the dispatch itself (`MODEL_ROUTE_IDS`,
`modelRouteIds`, `modelServesRoute`, `modelPricesRoute`). `isBusOnRoute` and
`registerRoutePaths` stay: the off-route filter and the polyline registry have
many callers and are not part of the estimator.

**The deferral this section used to record is withdrawn, and the withdrawal is
the point.** The measurement that deferred it — pricing Green on its BRIDGED
ring, 289 → 385 s median, dangerous tail 56 → 65% — was an argument for
keeping the legacy arm *for Green*. It stopped applying the moment the ring
stopped being bridged: on the repaired ring the same replay reads 288.8 →
**70.1 s**. The retirement was never gated on an opinion about which
arithmetic was nicer; it was gated on there being a route the model could not
price, and there is not one.

**Proved from the payload, not by argument.** `web/src/eta/no-bridged-ring.test.ts`
builds the ring for every route in the checked-in `/api/buses` fixture and
asserts `bridged === false` and `buildTables(...).priced === true` for each of
the 15. That test is the guard the deletion removed: an upstream sequence
change that re-bridges a ring used to fall back silently, and now fails CI.

**What survives, and why.**

- **The replays' copies.** `scripts/eta-replay/legacy/{anchor,anchorGate,hopPricing}.ts`
  are the retired code, moved rather than deleted, because the
  `MODEL_ROUTES=""` arm is the counterfactual baseline every retirement
  decision in this document was measured against — including the two tables
  above. They are no longer a replica of the client and the scripts say so.
- **A ring on the stop chords when no polyline is registered.**
  `ringForBus` falls back to `chordPath`. This was measured before it was
  written: `/api/buses` carries `route_paths` for all 15 routes as part of its
  static topology, and `registerRoutePaths` runs in the same handler as
  `setBuses` — synchronously, before React re-renders — so there is no poll on
  which buses exist and a path does not. The honest choice for the one poll
  people assumed existed was between showing nothing and showing a chord
  estimate; the measurement says the poll does not exist, and the chord ring is
  kept so the deletion is sound rather than nearly sound. A route with fewer
  than two stops, or a stop with no coordinate, still shows no times — there is
  nothing to price on.
- **`tables.priced`.** It no longer selects an estimator. It is the diagnostic
  the test above asserts, and it is false only for a cold database with no pace
  anywhere.

**Measured: nothing moved.** gps-replay, 9/4 15:51–22:04 ET, 205,061 pairs,
proximity truth, next 1–5 stops; this branch against `origin/master` (1a0159c)
from separate worktrees into separate `REPLAY_OUT`s, same `REPLAY_DB`
(snap-0904-2205) and same `PAYLOAD_PATCH` (model-patch-all-0904). Of the
**12,677 leaf metrics** the two runs emit, 12,677 are equal; the only textual
differences are `generatedAt` and the diagnostic block renamed `replicaCheck`
→ `legacyBaseline`, whose values (239,680 differing pairs, max 4,956.1 s) are
themselves identical.

| route | n | median \|err\| | p90 | pessimistic ≥120 s | optimistic ≥120 s | within 120 s |
|---|---|---|---|---|---|---|
| Blue Day | 12,274 | 35.3 | 158.3 | 7.8% | 6.3% | 85.9% |
| Orange Day | 13,982 | 28.1 | 110.0 | 5.0% | 3.6% | 91.4% |
| Red | 20,972 | 47.5 | 255.3 | 4.8% | 19.0% | 76.3% |
| Pink | 19,061 | 106.1 | 454.9 | 9.4% | 36.4% | 54.2% |
| Green | 22,611 | 191.3 | 642.6 | 49.0% | 11.3% | 39.6% |
| Purple | 27,102 | 102.9 | 664.3 | 25.3% | 22.0% | 52.7% |
| Blue Night | 22,973 | 70.8 | 225.4 | 13.1% | 18.8% | 68.1% |
| Orange Night | 28,068 | 39.4 | 129.3 | 3.0% | 9.1% | 87.9% |
| Gold | 6,018 | 55.4 | 220.4 | 7.4% | 20.9% | 71.7% |
| Blue West | 12,037 | 47.5 | 196.3 | 4.5% | 16.6% | 78.9% |
| Orange East | 11,656 | 48.1 | 192.6 | 3.5% | 16.5% | 80.0% |
| Brown | 8,307 | 79.4 | 517.3 | 12.7% | 27.4% | 60.0% |
| **overall** | **205,061** | **59.5** | **392.7** | **14.0%** | **17.1%** | **68.9%** |

Both columns of that table are the same number, which is the only acceptable
result: the deletion removed code nothing called, so a metric that moved would
have been a defect in the rebase, not a finding.

**Green reads 191.3 s here, not the 70.1 s recorded above, and the difference
is the PATCH, not the branch.** `model-patch-all-0904` was built before the
repair, so its per-pass stand tables are keyed to the published order and the
repaired ring asks for slots it does not carry; the 70.1 s row was measured on
tables re-derived for the repaired order. Both arms of THIS run share the one
patch, so the comparison is exact — and 191.3 s is still below the legacy arm's
288.8 s on the same window. Quote 70.1 s for what the line does in production
and 191.3 s only against the row beside it.

## 2.1 The clock: a diurnal factor on the stand (2026-09-08)

**Measured first, then built, and the measurement is the headline: on the
record the model prices stands from, the hour of day moves a stand by about
±5% in the service day — an effect that is real, reproducible, correctly
signed, and an order of magnitude smaller than the spread it sits inside.**

### The question, and the observation that raised it

A rider watching Red #304 stand at 344 Winchester at 08:56 ET on 2026-09-08
saw the pause chip read `2:21 / ~4:48`. The served table for that stop is
`q = [39,118,140,164,265,311,371,438,492,654]`, `qn = 63`, `pstop = 0.952` —
an unconditional median of 285 s, which is the 4:48. The operator: *"4:48
seems short for 344 win delay."* The same payload carries `med` 420.3 over
`n` 17 for that stop, a minute and a half longer.

Three candidate explanations, all measured:

**1. The two numbers on the payload are not the same quantity, and the gap is
definitional.** `med` is the legacy (dow, hour ± 1) ARRIVAL-TO-ARRIVAL median:
`detector.ts` emits one elapsed time per anchor transition as both the dwell
at A and the segment A→B (`WHAT A DWELL STATISTIC ACTUALLY MEASURES`,
eta/tables.ts). Joined per visit on 6,691 paired stopped visits from the
2026-09-03..06 snapshot, `arrivals.dwell_sec` runs **+45.1 s** past the served
stand at the median, and that gap decomposes into the roll-in (`pinned_at −
anchored_at`, median 10.0 s) and the drive to the next anchor (median 25.2 s).
At 344 Winchester specifically: stand 323 s, roll-in 15 s, drive to next 15 s,
`dwell_sec` 380 s. **There is no bias between the records.** The physical rest
(`departed_at − arrived_at`) is if anything 5.0 s SHORTER than the served
clock (`departed_at − pinned_at`), and the served clock is the right one
because it is the clock the CLIENT conditions on — `pinned_at` is production's
`at_stop_since`.

**2. A regime change at term start, and the table has already followed it.**
On the long `arrivals` record the 344 Winchester dwell median by ISO week runs
560–570 s from wk24 to wk33 and then **533 (wk34) → 460 (wk35) → 360 (wk36)**.
The stand there really did fall by about a third when term began. The operator's
"about ten minutes" is a correct memory of the summer. `stop_visits` — the
record the stand tables are built from — begins 2026-09-03, entirely inside
the new regime, so **4:48 is current, not stale.** This is a live hazard
rather than a live bug: `SPLIT_WINDOW_DAYS` is 30, and once `stop_visits` is
thirty days old a change of that size will be smeared across a month. Nothing
is built for it here; it is written down so the next reader does not have to
rediscover it.

**3. Time of day.** Measured below.

### The diurnal measurement

Source: every `stop_visits` row on production, 2026-09-03 → 2026-09-08 09:00
ET, 15,517 pinned visits over 261 (route, stop) cells (18 layover-class).
Estimator: the **within-cell** log ratio of each positive stand to its own
cell's all-hours geometric mean — within cell because the route and stop mix
changes with the hour (night lines run at night), so a raw hourly pooled
median measures the mix and not the clock.

Weekday, all stops, positive stands (203 cells with ≥ 8):

| ET hour | n | factor | 95% | | ET hour | n | factor | 95% |
|---|---|---|---|---|---|---|---|---|
| 06 | 115 | 1.086 | ×1.16 | | 15 | 453 | 0.992 | ×1.05 |
| 07 | 499 | 0.999 | ×1.05 | | 16 | 548 | 1.024 | ×1.05 |
| 08 | 613 | **1.055** | ×1.05 | | 17 | 474 | 1.042 | ×1.05 |
| 09 | 360 | 0.932 | ×1.06 | | 18 | 288 | 0.903 | ×1.07 |
| 10 | 615 | 0.954 | ×1.05 | | 19 | 210 | 1.018 | ×1.09 |
| 11 | 487 | 1.016 | ×1.05 | | 20 | 178 | 1.056 | ×1.10 |
| 12 | 454 | 0.961 | ×1.06 | | 21 | 162 | 1.063 | ×1.10 |
| 13 | 468 | 0.950 | ×1.05 | | 22 | 161 | 0.969 | ×1.10 |
| 14 | 455 | 1.030 | ×1.05 | | 23 | 124 | 1.159 | ×1.16 |

Every hour of the service day is within ±6% of 1, and the intervals are ±4–10%.
The **within-stop spread of the stands themselves is p75/p25 = 1.89**. So the
clock explains a twentieth of what a stand does. The layover class alone
(15 cells, 13–60 visits an hour) has intervals of ×1.2–2.0 and shows no
consistent shape at all. Weekend is flatter still.

**The effect is not an artefact of the regime change.** On the long `arrivals`
proxy (409k weekday rows, June–September) the hour profile computed with stop
fixed effects and with stop × ISO-week fixed effects is **identical to three
decimals at every hour** (max/min swing 5.36× vs 5.53×, both dominated by two
sub-100-sample hours). And the SHAPE reproduces across the regime change:
correlation between the summer (wk ≤ 33) and term (wk ≥ 34) hour profiles is
**0.925** at layover cells and **0.944** at kerb cells. It is a real diurnal
pattern; it is simply small in the stand, and larger in that proxy because
`arrivals.dwell_sec` is more than half DRIVE at a kerb stop and its peaks sit
at 08:00 and 16:00–17:00 — rush hour on the road, not on the kerb.

**What IS strongly diurnal is P(stop), not the stand.** Within stop, weekday,
the share of visits that stop at all runs 0.63–0.70 of its own baseline at
05:00–06:00 and 0.75–0.81 at 23:00–00:00 against 1.02–1.12 through the
afternoon. About half of that survives removing runs of four or more
consecutive pass-throughs on one route inside fifteen minutes (the deadhead
signature — 73% of 05:00 passes sit in such a run, against 16–20% midday), and
the residue is not separable from deadheading with the data at hand. **It is
therefore NOT priced**, and the multiplicative shape below is chosen partly so
that it cannot be priced by accident: scaling a quantile vector leaves 0 at 0,
so P(stop) is exactly where the calibrator measured it.

**Error by hour of day** (43,941 `predictions_log` rows scored against
`arrivals`, ≤ 2 stops ahead, ≤ 900 s promised) shows a morning bulge —
median |err| 226/200/168 s at 06/07/08 against 68–118 s at 13:00–19:00, with a
median bias of +85 to +115 s in the morning against +20 s mid-afternoon. The
sign is the wrong way round for "we under-price morning stands": positive bias
is the app promising LONGER than the bus took. The morning routes and the
morning hours are confounded in that reading and the truth join is naive (the
first arrival of that bus at that stop), so it is quoted as a caveat, not as
support.

### The model: partial pooling, at the level that has data

A **multiplicative factor on the stand's quantile vector**, per ET hour and
per stop class, estimated where the data is and borrowed downward:

```
log f(stop, h) = ( n(stop, h) · log f_raw(stop, h)
                 + STAND_HOUR_SHRINK_K · log F(class(stop), h) ) / (n + K)

log F(class, h) = ( n(class, h) / (n(class, h) + STAND_HOUR_CLASS_K) )
                  · mean over that class-hour's visits of log(stand / cell mean)
```

`src/calibrator/diurnal.ts` estimates it, `v1compat.ts` serves it as
`stand_hours` (the class profiles with their counts) plus `dwells[r][s].hq` /
`.hqn` (a stop's own hourly factors ×100, RAW, and their counts),
`web/src/eta/tables.ts` `hourFactor` blends and `stopModel` applies it with
`scaled`.

Why this shape, point by point:

- **The stop is not the level with data.** A (stop, hour) cell holds a MEDIAN
  OF THREE positive stands (2,436 cells; 504 reach six, 32 reach ten). That is
  the same reason `calibrator.ts` pools the split tables over the whole window
  instead of slicing by (dow, hour), and slicing thinner is not an answer. The
  class — layover or kerb, over every stand in the fleet — has 150–560 positive
  stands an hour on the kerb side.
- **Both shrinkages are variance ratios, not taste.** k = σ²/τ². The per-visit
  spread of log(stand) inside a cell is σ ≈ 0.55. For a stop against its class,
  τ ≲ 0.15 (bounded by the class swing), so `STAND_HOUR_SHRINK_K = 12`. For a
  class-hour against 1, τ ≈ 0.06 (what the well-sampled kerb class shows), so
  `STAND_HOUR_CLASS_K = 84`. The second one is load-bearing: the layover class
  has ~45 positive stands an hour and its raw 15:00 factor read 1.375; served
  raw it moved the 15:00 gps-replay bucket from 10.8% to 23.9% pessimistic
  while every well-sampled hour improved. Damped to 1.118 it costs half that.
- **Multiplicative on `q`, not additive, and applied AFTER the class-pool
  shrinkage.** S_scaled(x) = S(x / f), so the residual given r elapsed is
  exactly f · residual(r / f): the conditional arithmetic in `dist.ts` stays
  coherent and monotone, the whole distribution scales rather than its median,
  and the mass at zero — P(stop) — does not move. The stop's CLASS is decided
  before scaling, on its own all-day median, so an hour cannot tip a kerb stop
  into the layover pool for sixty minutes.
- **Raw on the wire, shrunk on the client**, exactly as `q` is, so the server's
  and the client's gates cannot drift apart. `STAND_HOUR_MIN_CELL = 6` is a
  PAYLOAD budget and says so: `/api/buses` is 134 KB raw / 33.6 KB gzipped and
  polled every 5 s, and the whole block costs +10.0 KB raw / **+1.7 KB
  gzipped** at 81 stops and 209 published cells.
- **ET on both sides.** The calibrator groups on `stop_visits.hour`, written in
  ET by a container with `TZ=America/New_York`; the client resolves the display
  hour with `etHourOf` in `web/src/schedule.ts`, never `Date#getHours()`. A
  phone left on another timezone would otherwise index someone else's day —
  the same class of bug as the "No shuttles running" one. Intl resolves DST, so
  01:30 EDT and 01:30 EST both answer hour 1.
- **Degrades to nothing, provably.** No profile, no `hq`, an hour the class has
  too few samples for, an out-of-range hour: the factor is 1, `scaled` is never
  called, and the distribution is the one built today. Pinned by tests on the
  knots themselves, and by the replay below.

On the 2026-09-04 tables the published profile is:

```
kerb    06 1.023  07 0.987  08 1.052  09 0.948  10 0.976  11 1.017  12 0.994
        13 0.956  14 1.034  15 0.971  16 1.023  17 1.043  18 0.941  19 1.020
        20 1.052  21 1.027  22 0.953  23 1.055
layover 10 0.921  11 1.010  12 0.910  13 1.009  14 0.998  15 1.118  16 1.015
        17 1.003
```

### gps-replay, every line, 9/4 15:51–22:04 ET, branch vs origin/master

Same snapshot (`snap-0904-2205.db`), same `PAYLOAD_PATCH`
(`diurnal-patch-0904.json`, built by `model-patch.ts` at MODEL_NOW
2026-09-05T03:00Z), master run from a second worktree at `1c85638`. Proximity
truth (45 m), 205,061 pairs, next 1–5 stops.

| | median \|err\| | p90 | median bias | pessimistic ≥120 s | optimistic ≥120 s | within 120 s | 10–90 covers |
|---|---|---|---|---|---|---|---|
| origin/master | 59.1 s | 391 | −7.7 | 13.84% | 17.09% | 69.07% | 76.65% |
| diurnal | **59.0** | **389** | **−5.7** | 14.28% | **16.54%** | **69.18%** | **76.95%** |
| diurnal, warm (first 30 min dropped) | 58.4 | 385 | −5.6 | 13.99% | 16.37% | 69.65% | 76.95% |
| master, warm | 58.6 | 388 | −7.1 | 13.76% | 16.86% | 69.38% | 76.69% |

**A third arm proves the degradation claim on data rather than on argument**:
the branch run with `NO_STAND_HOURS=1` reproduces origin/master to every digit
on all 205,061 pairs (59.1 / 391 / −7.7 / 17.09% / 13.84% / 69.07%, and
75.4 / 526.4 / +29.0 on detector truth). With no profile the branch IS master.

The number itself barely moves: **|Δeta| median 2.1 s, p90 10.7 s, ≥ 60 s on
1.0% of pairs.** Which is the point — a ±5% term on the stand half of a chain
is a few seconds, and anything larger would have been a bug.

By route (master → diurnal, median |err| and the two ≥120 s tails):

| route | n | median \|err\| | pessimistic ≥120 s | optimistic ≥120 s | within 120 s |
|---|---|---|---|---|---|
| Blue Day | 12,274 | 35.3 → 37.6 | 7.8 → 10.9% | 6.3 → 5.9% | 85.9 → 83.2% |
| Blue Night | 22,973 | 70.8 → 70.2 | 13.1 → 13.2% | 18.8 → 18.5% | 68.1 → 68.3% |
| Blue West | 12,037 | 47.5 → 48.1 | 4.5 → 4.5% | 16.6 → 16.2% | 78.9 → 79.3% |
| Brown | 8,307 | 79.3 → 80.3 | 12.7 → 13.2% | 27.4 → 27.0% | 60.0 → 59.8% |
| Gold | 6,018 | 55.3 → 54.1 | 7.4 → 7.6% | 20.8 → 19.4% | 71.7 → 72.9% |
| Green | 22,611 | 182.1 → 182.2 | 47.7 → 48.0% | 11.4 → 11.4% | 40.9 → 40.7% |
| Orange Day | 13,982 | 28.1 → 28.4 | 5.0 → 4.8% | 3.6 → 3.8% | 91.4 → 91.4% |
| Orange East | 11,656 | 48.1 → 47.8 | 3.5 → 3.6% | 16.5 → 16.6% | 80.0 → 79.8% |
| Orange Night | 28,068 | 39.4 → 38.8 | 3.0 → 3.0% | 9.1 → 8.7% | 87.9 → 88.3% |
| Pink | 19,061 | 106.1 → 102.2 | 9.4 → 10.5% | 36.5 → 34.0% | 54.2 → 55.4% |
| Purple | 27,102 | 102.9 → 102.8 | 25.3 → 25.3% | 22.0 → 22.0% | 52.7 → 52.7% |
| Red | 20,972 | 47.5 → 46.4 | 4.8 → 5.6% | 19.0 → 17.4% | 76.2 → 77.0% |

By ET hour — the split this term has to be judged on:

| ET hour | n | median \|err\| | pessimistic ≥120 s | optimistic ≥120 s | within 120 s |
|---|---|---|---|---|---|
| 15 (partial, 15:51–15:59, cold) | 7,015 | 92.5 → 105.0 | 10.8 → 17.6% | 31.6 → 28.8% | 57.6 → 53.6% |
| 16 | 53,359 | 58.6 → 58.1 | 16.6 → 16.7% | 15.8 → 15.1% | 67.6 → 68.2% |
| 17 | 44,299 | 64.2 → 64.1 | 17.2 → 18.0% | 17.7 → 16.8% | 65.1 → 65.2% |
| 18 | 32,553 | 63.3 → 63.9 | 16.8 → 16.5% | 15.1 → 15.8% | 68.1 → 67.7% |
| 19 | 24,899 | 54.5 → 54.1 | 11.3 → 11.4% | 15.8 → 15.4% | 72.9 → 73.2% |
| 20 | 22,376 | 57.1 → 55.4 | 4.9 → 5.1% | 22.4 → 21.3% | 72.7 → 73.6% |
| 21 | 20,189 | 49.2 → 49.1 | 8.5 → 8.7% | 13.3 → 13.1% | 78.1 → 78.2% |

**Every warm hour is flat or better; the whole regression is the capture's
first, partial, cold-start bucket**, nine minutes in which every bus's belief
is still the stateless prior (Blue Day 15h: 7.3 → 41.2% pessimistic on 970
pairs; Red 15h: 7.3 → 15.9%; every one of those buses' later hours improves).
That bucket also carries the largest published factor (layover 15:00, 1.118).
Worth naming rather than hiding: the factor does not only price, it also feeds
the filter's departure hazard through `setRingProfile`, so a scaled stand
table changes the STAND/MOVE competition too — coherently (a longer expected
stand lowers the departure hazard), but it means a cold belief and a scaled
table compound.

**What this replay cannot say.** The 9/4 capture runs 15:51–22:04 ET, so the
gate covers hours 15–22 only — precisely the hours whose measured factors are
nearest 1 (0.94–1.05). The hours where the profile is largest (06:00 1.086,
08:00 1.055, 23:00 1.159) are not in the window at all. The right verdict on
the numbers above is "correctly signed, and too small to resolve on the six
evening hours we have", not "it works".

**Not run: the rider-sim.** 2026-09-08 is a service day with the live canary
riding and the Pi at load 2.1–3.8 throughout; one browser-driven simulation on
top of that is what crashed it on the Sunday before. The gps-replay is the
measurement here; the simulator's chain and departure-poll columns are not
reported.

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

**The pause chip shows the REMAINDER, not the stop's typical hold**
(2026-09-08, `web/src/standChip.ts`). It used to print `⏸ 2:21 / ~4:48`: the
elapsed clock, then `residualMedian(stand, 0)` — the unconditional median.
The countdown beside it was billing `residualMedian(stand, 2:21)` = 3:31,
because a stand that has already lasted 2:21 is drawn from the longer-hold
population. A rider subtracts the pair on screen and gets 2:27, which is
neither number. This document and CLAUDE.md both claimed the chip read the
residual so that "the chip and the countdown cannot disagree"; the tooltip
did, the glyph did not. It now reads `⏸ 2:21 · ~3:31 left`.

The honest tension, since it does not go away: the conditional TOTAL rises the
longer a bus sits (287 s at arrival, 356 s at 2:21, 702 s at ten minutes at
344 Winchester) and the #119 clamp forbids the countdown from climbing while a
bus stands — the operator's decision, and it stays. So the chip may not show
that rise either, or two numbers on one line move in opposite directions with
nothing on screen to explain it. The remainder mostly falls on its own, but
not always: on the live tables **167 of 277 stand tables have a residual
median that rises somewhere** (worst single step +128 s), where a table's own
tail hazard flattens past its last recorded stand. So the shown remainder
carries the same floor the countdown does — within ONE rest it may pause and
fall, never climb; when the rest ends the clock changes and the floor goes
with it. A stop the bus has NOT reached keeps the stop's typical hold, which
is the honest answer where there is no remainder to state.

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
Green was declined by the model in this run (bridged ring — repaired on
2026-09-07, see §2) and is byte-identical here.

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
| Green (declined in this run) | 288.8 → 288.8 | 56.1 → 56.1 | 8.2 → 8.2 | 51% |
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
master — the same `q`/`drive`), 8,246 paired waits. Green was declined by the
model in this run (byte-identical); Purple runs on it.

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
grocery lines and Green were priced by the legacy arithmetic in this run
(declined on evidence at the time) and are noise-level.

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
| Green (legacy in this run) | 4,452 | 0 / 0 | 0 / 1 | 0 / 5 | 0 / 0 |

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


## The second stand, when a rest is served short of the marker (fixed 2026-09-07)

**Status: shipped. Found and fixed 2026-09-07** (`eta/filter.ts`, PR
`eta/rest-double-stand`). It was rider-facing on every line the ring prices,
for as long as the estimator had shipped.

A Red bus that takes its 344 Winchester layover 83–147 m short of the marker —
on the road, or in the Science Park Garage lot (report #102) — rests, then
rolls the last stretch to the marker and stands again. The retired approach
zone treated that as ONE wait: the rest was charged against 344 Winchester and
#119's ceiling held the number flat across the roll-in. **The belief did not.**
The rest ended when the bus moved, a new rest began at the marker, and the
shown number stepped UP as the second stand was charged.

| recording | metres short | largest step up, stop 146 / stop 48 |
|---|---|---|
| Red #310, 13:28 ET (`__fixtures__/red-approach-rest.json`) | 147 | 185 s / 190 s |
| Red #304, 14:06 ET, the garage lot (`__fixtures__/red-garage-rest.json`) | 83 | 154 s / 144 s |

It was not a regression of anything recent. It was invisible because
`web/src/accuracy-approach-rest.test.ts` registered **no route polyline**,
which sent both recordings down the legacy arithmetic instead of the ring —
so CI scored a path no browser takes. Red's line is registered in that file
now, and four of its assertions failed on master the moment it was.

### The mechanism, and the two things that had to survive

`moved` — the flag that ends a rest — is `fresh && haversine(restPoint, fix) >
REST_RADIUS_M`. Rolling in from the approach clears 125 m, so the rest ended,
`restStop` went to −1, `restSince` restarted at the server's `at_stop_since`
(which begins at the marker, minutes after the bus actually stopped), and the
bus arrived at the marker as a NEW arrival owing 344 Winchester's whole stand
on top of the one it had already served. `traceany.mts` on the 9/4 capture,
stop 146 / stop 48:

| bus | poll | before | after |
|---|---|---|---|
| #310 | 17:34:53 → 17:34:58 (reaches the marker) | 103 → **305**, 164 → **359**; `r` 425 s → **0** | 103 → 102, 164 → 161; `r` 425 → 430 |
| #304 | 18:10:58 → 18:11:03 (reaches the marker) | 150 → **305**, 217 → **359**; `r` 284 s → **0** | 188 → 186, 240 → 236; `r` 284 → 288 |

Two things the same recordings show that are NOT wrong, and the fix keeps
both: the board falls by 102–209 s over the rest (the retired arm froze it),
and withholding `stationary_since` changes the answer by under 10 s — the
belief reads the rest off the repeated fixes, not off the server's
declaration.

### The fix: two rules, both about the rest's identity

**1. Closing the last metres onto the marker is the same rest.** A fresh fix
beyond the rest radius ends the rest, EXCEPT when the rest was already
attributed to a stop's approach (`restApproach`, decided by the majority rule
in `restStopFromBelief`), that stop is a layover by its own stand table, and
the fix is inside the stop's own zone (`NEAR_STOP_M`). Then the rest
continues, RE-CENTRED on the marker so the mask and the next radius test are
taken from where the bus now stands, with `restApproach` cleared and the clock
left at its earliest known origin — §1's rule applied across a short roll-in
instead of only across a shuffle. It is as narrow as the approach zone it
replaces: a bus that rests short of a stop and drives PAST it is outside
`NEAR_STOP_M` and departs normally, and a rest short of a KERB stop is a hold
on the road that is never attributed to it, so pulling in there is a genuine
new stand. No constant was invented — `APPROACH_M`, `REST_RADIUS_M` and
`NEAR_STOP_M` are the ring's own.

**2. While a NAMED rest holds, a cell outside it gets no stray-fix floor.** The
garage recording exposed a second half of the same failure. A fix 93–154 m off
the published line scores 2e-5 under the position emission — barely above the
off-route floor (1.3e-5 on Red) — so the emission says almost nothing and the
TRANSITION decides: the departure hazard walked half the mass past 344
Winchester on the poll the bus drove back toward the road, and a rider at
Winchester / Division was shown **"in 9 s" for a bus three and a half minutes
away** (the whole board then climbed 109 s / 106 s recovering). But the fix
says something the line cannot: it is 37 m from where the bus came to rest.
So while the rest still holds — the fix inside `REST_RADIUS_M` of the rest
point, the collector's own definition of standing — cells outside the rest
mask get no stray floor. Cells inside keep it, `TELEPORT` still re-finds a bus
that really has relocated, and the moment the fix leaves the radius the rest
ends and the floor is back everywhere. #304's whole wait is now a monotone
226 → 145 s.

It applies only to a rest with an IDENTITY (`restStop >= 0`), and that is the
measurement talking. Applied to EVERY rest — including the ones the belief
cannot name — the 9/4 gps-replay moved Purple's median 102.9 → 105.0 s
(pessimistic ≥120 s 25.3 → 25.7%, coverage 76.1 → 75.3%) and Orange East's
48.1 → 48.5 (pessimistic 3.5 → 4.1%), while gaining about as much on Orange
Day, Red and Blue Night. Purple's loss is its known fold detour (§ the open
fold): the bus sits at a light on a parallel street that IS another leg's
published line, and the stray floor is precisely what lets consistent fixes
pull the belief onto the branch the bus is really on. A rest the belief cannot
name is the case where the branch is least certain, so it keeps its escape
hatch. Restricted to named rests, no route is worse and Blue Night improves.

### Measurement: gps-replay, every line, 9/4 15:51–22:04 ET (205k pairs, proximity truth)

Branch vs `origin/master` (8d093a3), same `PAYLOAD_PATCH`
(model-patch-all-0904), same snapshot, separate `REPLAY_OUT`.

| | median \|err\| | p90 | pessimistic ≥120 s | optimistic ≥120 s | within 120 s | 10–90 covers |
|---|---|---|---|---|---|---|
| overall (n 205,060) | 60.2 → 60.2 | 430.9 → **430.4** | 14.8 → 14.8 | 16.7 → 16.7 | 68.5 → 68.5 | 76.6 → 76.6 |
| Blue Night (22,973) | 71.0 → **70.8** | 226.6 → **225.3** | 13.3 → **13.1** | 18.8 → 18.8 | 67.9 → **68.1** | 78.8 → 78.8 |
| Red (20,972) | 47.6 → 47.6 | 255.3 → 255.3 | 4.8 → 4.8 | 19.0 → 19.0 | 76.3 → 76.2 | 76.3 → 76.3 |
| Blue West (12,037) | 47.5 → 47.5 | 196.3 → 196.3 | 4.5 → 4.5 | 16.6 → 16.6 | 78.9 → 78.9 | 91.5 → 91.5 |
| Orange East (11,656) | 48.1 → 48.1 | 192.7 → 192.7 | 3.5 → 3.5 | 16.5 → 16.5 | 80.0 → 80.0 | 89.8 → 89.8 |
| every other line | unchanged to a tenth | | | | | |

Detector truth is unchanged to a tenth as well (75.9 → 75.9 overall, p90
591.9 → 591.1). Rule 1 on its own is **byte-identical** to master over this
window: a rest served short of a layover marker is rare — the retired
approach zone fired on one episode in nine hours — so it moves two recorded
riders' boards by three minutes and 205k scored pairs not at all. That is
what the fixtures are for, and why this file's polyline registration was the
part that mattered.

### What is left, deliberately

Past the roll-in the bus shuffles at the kerb and the belief carries a
departure hypothesis for a poll or two — §3's measured residue, kept because
holding the number until the bus cleared the rest radius was tried and cost
more than it saved. The test bounds it the honest way: nothing after the
marker may exceed the number the board already showed on reaching it.

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
