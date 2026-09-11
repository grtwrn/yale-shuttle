# What the rider was told: sampled logging of the displayed ETA

**Status: built, not yet merged.** The privacy design is the operator's call —
that is the part to read first. Code: `web/src/shownLog.ts`,
`src/server/predictions.ts`, `POST /api/shown`, `GET /api/predictions`,
`predictions_log` (schema since day one, zero rows until now).

## The gap

Every accuracy and stability figure this project has produced is a
**reconstruction**: replay the arithmetic over stored positions, and assert
that is what the screen said. `predictions_log` has existed in the schema the
whole time, with two readers (`server/accuracy.ts` and `buildAccuracyV1`), and
no writer.

The reconstruction has been wrong, more than once, and expensively:

- Several harnesses built `at_stop_since` from `enteredAt`. Every stability
  number produced before that was caught had been measured against a client
  **that had not shipped since March**. "46.4% of jumps are eventless" was not
  a property of the world.
- A hotfix's before/after was credited to the wrong PR, because the harness
  could not see the change it was measuring.
- A live browser canary caught the operator's exact defect an hour before he
  reported it, and the finding sat unread in a file.

`docs/rider-sim.md` is careful about its own approximations (calibration phase,
detector age) and says plainly that it replays the arithmetic, not the
rendering. It has no way to check itself. This does.

## Why the browser has to be the source

The ETA is computed **in the client**, from the `/api/buses` payload, by the
bundle that browser happens to have. The obvious privacy-perfect alternative —
have the server compute the same numbers on its own poll and log those, with no
rider involved at all — is *exactly the inference that keeps failing*. It logs
what the server would say, using the code deployed now, not what the rider's
(possibly cached, possibly a deploy behind) bundle put on screen. It would
reproduce the March-client failure by construction.

So the client reports, and **every row names the bundle that produced it**.
That column is the single most valuable field here: it turns "which code was
this measured against" from an assumption in a harness into a fact in the data.

The bundle identity costs no build plumbing: it is the content hash already in
the module's own filename (`/assets/index-<hash>.js`, read from
`import.meta.url`), which changes exactly when the bundle's content does.

## The privacy shape

The binding constraint is the posture `daily_actives` and `search_terms`
already set: one row per (ET day, id) and *nothing else* — no IP, no user
agent, no coordinates, no time of day; and for searches, no id at all. A
prediction log is a different shape by nature, so the argument has to be made
explicitly rather than assumed.

**A row is a statement about a vehicle, not about a viewer.**

```
bus_name   route_id  to_stop_id  stops_ahead  predicted_sec  predicted_at  client_build
#310       3         48          3            300            08:12:30      a1b2c3
```

Four things hold that line, and each is load-bearing:

1. **No identity is accepted, at all.** Not the `x-anon-id` the poll carries,
   not a session key, not credentials. There is nothing in a row that two rows
   could be joined on to make one browser's trail. This is a *stricter*
   promise than `daily_actives` keeps — that table's whole design is a stable
   id per browser per day — and the same promise `search_terms` keeps, for the
   same reason.

2. **The quantity does not depend on the rider.**
   `computeUpcomingArrivals` prices (bus → stop). The rider's position enters
   the app one layer up, in the walk legs and `pickLiveArrival`'s catchability
   rule. Logging at the arrivals layer means a row **cannot** encode where
   anyone was standing, even indirectly — only that some screen had that stop
   on it.

3. **The server deduplicates before it writes.** `(bus_id, to_stop_id,
   predicted_at)` is UNIQUE and `predicted_at` is floored to a 15 s bucket, so
   thirty riders watching one stop in one bucket produce **one row**. A row
   therefore means *"at least one client somewhere had this on screen"* — never
   *"a rider was here"*. This is the move that makes the whole thing work: it is
   simultaneously the privacy argument and the write-cost bound.

4. **Sampling and truncation.** A share of page loads report (default 25%,
   server-controlled, see below), and the only time resolution stored is the
   15 s bucket.

### What is being traded, honestly

It is not as private as `daily_actives`, and pretending otherwise would be
wrong. Two residual facts exist that did not before:

- **Aggregate presence at a stop.** A row's existence says a client somewhere
  had stop 48 on screen in that quarter-minute. With no id, no location and
  dedup collapsing everyone into one row, this is a fact about *demand*, not
  about a person — closer to "the app was in use" than to "someone was here".
  It is strictly weaker than what `daily_actives` already knows (which browser,
  which day, for how long) and weaker than what `search_terms` already knows
  (which destinations riders type).
- **A version split.** `client_build` partitions reporters by bundle. The
  server already knows which bundle it served; it is the same string for
  everyone on a deploy, so it names code, not readers.

Against that: it is the first thing in the project that can say what a rider
was actually told, and it removes an entire class of expensive, silent
measurement error. The trade is worth making, and it is the operator's to make
— which is why this is a PR and not a merge.

### Why 15 s

Not arbitrary. It is the cadence `scripts/rider-canary.mjs` samples at and the
cadence `rider-sim` scores its sequences at, so a logged sequence and a
replayed one line up without resampling either. One knob buys the time
truncation, the dedup granularity and the comparability.

### Why 30 days, not 90

Shorter than every neighbour (`daily_actives`, `arrivals`, `legs`, `stop_visits`
are all 90 d) on purpose:

- this is the only table whose volume scales with **usage** rather than with the
  fleet, on a 1 GB volume;
- `arrivals` outlives it, so a prediction is pairable for as long as it exists;
- 30 d is already four times the 7 d window both accuracy readers scan;
- and shorter is the safe direction for a record of what was on a screen.

Swept by the collector's existing hourly batched-delete, beside the others
(`SHUTTLE_PREDICTION_RETAIN_DAYS` overrides).

## Cost

`actives.ts` is the precedent and this follows it exactly.

- **Client:** a Map write per displayed arrival in the render path, nothing
  else. Readings dedup client-side into the same 15 s buckets, and a
  module-level timer posts one batch a minute — a sampled browser makes **one
  extra request a minute** beside the poll it already makes every five seconds.
  No React hook, no state, no effect, no dependency array: `noteShown` is a
  plain call into a module, so it cannot introduce the TDZ blank-screen class of
  bug.
- **Server:** nothing is written on a request. Readings accumulate in a Map keyed
  by the dedup key; a 60 s timer flushes the batch in one transaction with
  `INSERT OR IGNORE`. **Row volume is bounded by (live buses × watched stops ×
  buckets), not by traffic** — a hundred riders at one stop cost what one costs.
- Every path on both sides is non-throwing. A browser with no `fetch`, a blocked
  request, a 429, a nonsense reply, a pre-migration database: the rider does not
  notice, and the measurement is simply thinner.

**Kill switch that reaches the fleet.** `SHUTTLE_PREDICTION_SAMPLE=0` makes the
server answer `{"sample":0}` without reading the body; clients honour the value
from the reply they already get, so the whole fleet stops within a minute — no
deploy, no extra request.

The control channel is one-way by construction: it can only reach a browser
that is already reporting. Turning the rate **down** (including to zero) takes
effect fleet-wide within a minute; turning it **up** only affects loads that
were already sampled, so raising the default is a deploy. That asymmetry is the
right way round — the urgent direction is off.

## Trust: it is a public write

`POST /api/shown` is unauthenticated like every rider endpoint, so it is
treated as hostile input:

- the bus must be **live right now** (the server resolves `bus_id`/`route_id`
  from its own fleet; the client cannot assert either);
- the stop must be one **that bus's route serves**;
- the numbers must be in range, and `stops_ahead` a plausible integer;
- **the client sends an AGE, never a timestamp** — the server subtracts it from
  its own clock and floors. A wrong or lying client clock cannot write a row at
  an instant that never happened, and the whole value of the table is that its
  instants can be paired with an arrival;
- readings older than 2 minutes are dropped;
- rate-limited per IP; the batch is capped; the body is capped at 32 KB.

Residual risk, stated plainly: a determined attacker can write *plausible but
untrue* numbers into buckets a real rider would have filled anyway. Dedup plus
first-writer-wins means they cannot overwrite a value someone else established,
and they cannot invent a bus, a stop or an instant. The data is internal
measurement, not a rider-visible number, and the kill switch is one env var.

## The pairing — the thing nobody could do before

`GET /api/predictions?hours=6&route=3&stop=48` (admin **header**; deliberately
outside `/api/stats`, so the stats-session cookie's `Path=/api/stats` scope is
untouched) returns each logged reading with the arrival that followed it and the
signed error, plus a summary **broken down by client build**.

It pairs on `bus_name`, not `bus_id` — the identity invariant; `bus_id` is
reissued per service block. (The two older accuracy readers still join on the
id; they predate the finding and were left alone rather than quietly changed.)

```bash
npm run predictions                                   # last 24 h
npm run predictions -- --hours=6 --route=3
npm run predictions -- --route=3 --limit=5000 --out=/tmp/observed.jsonl
```

### Checking rider-sim against reality

This is the point of the whole exercise. `scripts/eta-replay/rider-sim/run.ts`
scores what a rider reads by replaying the real client; nothing has ever been
able to tell whether it is right, and a lying harness looks exactly like a
healthy one.

1. `npm run predictions -- --hours=24` — the `builds` block names the bundle(s)
   that were live.
2. `npm run predictions -- --hours=24 --route=3 --limit=5000 --out=/tmp/observed.jsonl`
3. Run the simulator over the same day, from a tree checked out at that build,
   against a DB snapshot taken after it:
   `CLIENT_ROOT=/path/to/that/tree npx tsx scripts/eta-replay/rider-sim/run.ts --routes=Red`
4. Join on `(busName, stopId, predictedAt)` — both sides are on the same 15 s
   grid by construction (rider-sim already scores a 15 s cadence beside its
   every-poll one). A logged row and a replayed reading for the same bucket
   should agree to within a display bucket. `docs/rider-sim.md` puts the
   simulator's own approximations (calibration phase, detector age) at about a
   minute of level, so **systematic disagreement beyond that is the harness, not
   the world.**

When they disagree, the logged row wins. It is what the screen said.

## What this still cannot see

The same boundary `rider-sim` names: this logs the **arithmetic**, not the
rendering. It does not capture a card reorder, a missing explanation line, a
countdown hidden behind "Show N more routes", the sub-poll `remainingSec` tick,
or `pickLiveArrival`'s catchability flip — which is deliberate, because
capturing those would mean logging where the rider is standing, and that is the
line this design will not cross. The canary remains necessary.

## Where it is wired in

Three call sites in `web/src/TransitMap.tsx`, one line each:

| call site | what the rider is reading |
|---|---|
| the trip-options memo in `TripPlanner` | **THE countdown** on the trip card — the number every accuracy and stability finding, the canary and rider-sim are about |
| `RideStopList` | on the bus: time to the alight stop |
| `OnBusBanner` | the same figure in the "get off next" banner |

All three go through `computeUpcomingArrivals`, so one table holds one
estimator and needs no discriminator column.

### Two findings from wiring it up

**1. Three arrival boards in `TransitMap.tsx` are dead code.** `NextShuttles`,
`FavoriteStopsPage` and `StopGroupsSummary` each declared a component, each
called `computeUpcomingArrivals`, and each was referenced **exactly once in the
file — its own declaration**. They rendered nowhere. The first draft of this
change instrumented all three; a live browser run against the built bundle
posted nothing, which is how they were found. Instrumenting them would have made
this table quietly under-report while looking thoroughly wired up.
**Deleted 2026-09-04** (358 lines), so the trap is gone rather than documented.

**2. The route cards on the Map tab do NOT use `computeUpcomingArrivals`.**
`StopList` (~5359) walks the route sequence itself with a simpler arithmetic:
no anchor gate, no stall credit, no mid-segment proration, no stand/drive split.
So the ETA a rider reads on a route card is produced by a *different estimator*
from the one on the trip card — and every finding in `docs/eta-accuracy.md`,
`docs/eta-error-budget.md` and `docs/rider-sim.md` is about the latter. That is
a real divergence and worth the operator's attention on its own; it is not
logged here, because pooling two estimators in one table without a discriminator
would produce exactly the kind of number this instrument exists to stop.
