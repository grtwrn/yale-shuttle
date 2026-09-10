# Moving the ETA belief to the server — stages 1–3 (flag off)

**Status: shipped as machinery, served to nobody.** `SHUTTLE_SERVER_ETA=1`
constructs it; unset, `/api/buses` is byte-identical to what it is today and no
client reads anything new. Code: `src/server/serverEta.ts`; the deliverable is
`src/server/serverEta.parity.test.ts`.

## Why

The estimator (`web/src/eta/`) runs in the BROWSER, a legacy of v2's frontend
being a fork of v1's. It is **stateful** — an HMM belief per bus — so every
browser keeps its own copy. That is a class of defect, not a list of them:

- a rider who just opened the app has a COLD belief; one with a tab open an
  hour has a WARM one. They see different numbers for the same bus at the same
  instant.
- **PR #176 existed solely to make cold starts read direction correctly.** It
  shipped and was reverted the next morning (#183) after the canary measured
  leader jumps rising from 0.36 to 1.34 per watched hour.
- the countdown was observed flapping between two fixed values 72 s apart
  (1:57 / 3:09) poll to poll while a bus stood — a belief with too little
  history to commit.

A belief stepped by the collector is always warm, because it never stops
tracking, and there is then ONE answer per bus for every rider.

**The effect is measured, not assumed.** The parity suite's third case takes the
40-poll production capture and prices its last frame twice — once from a store
that has tracked all 40 polls, once from an empty one. They disagree. That is
the whole argument for the move, in a test that fails if it ever stops being
true.

## What stage 1 is

1. **The same module, imported — not ported.** `src/server/serverEta.ts` calls
   `computeUpcomingArrivals` from `web/src/arrivals.ts` verbatim. Nothing is
   reimplemented, and nothing may be: two implementations is the failure this
   whole move exists to remove.
2. **One belief per bus, stepped on the collector's poll.** Keyed on
   `anchorKeyFor(routeLabel, bus_name)` — the NAME, never `bus_id`, which
   TransLoc reissues per service block. `buildApp` registers a poll observer
   that primes the `/api/buses` cache, and priming is what steps the belief, so
   it advances whether or not a rider is asking. Evicted after
   `BELIEF_STALE_MS` (10 min) of not reporting.
3. **Served additively behind the flag**, as `server_eta`.
4. **A parity test**, below.

Explicitly NOT in it: the client consuming the field, removing client-side
computation, or any rider-visible change. The display rules, the #119 clamp and
#185/#186's range are untouched.

## The parity test and its tolerance

`src/server/serverEta.parity.test.ts` replays **40 consecutive production
`/api/buses` responses** (`src/server/__fixtures__/live-frames.json`, captured
2026-09-09, ~5.1 s apart, 14–15 live buses, one bus leaving the live list and
coming back) through two arms, interleaved frame by frame:

- CLIENT — a bare `AnchorStore` and a direct `computeUpcomingArrivals` per
  frame, which is literally what `TransitMap` does with `liveAnchorStore`.
- SERVER — `ServerEta.contribute(payload, version, now)`.

**Tolerance: 0.5 s on `eta`, `low` and `high`** — the wire rounds seconds to
integers and does nothing else. `stopsAhead`, `estimated`, the bus name, the
route label, the stop id and the ROW COUNT must match exactly; a (bus, stop)
pair legitimately appears twice (this lap and the next, which is what lets a
single-bus line answer "next in 54 min"), and dropping one of those would be a
real difference in what a rider can be told. 5,000+ rows compared over 33+
frames, and the test fails if the comparison ever runs empty.

## Cost, measured — and stage 2, which fixed the expensive half

Pi 5, `nice -n 10`, the 40-frame capture, 15 buses, 172 stops, medians over
three runs of 40 polls:

| | ms per poll |
|---|---|
| step + price EVERY route (what it does) | **35 ms** |
| price only Red + Blue Day (54 stops) | 27 ms |
| first poll (ring + table construction, amortised) | 49–290 ms |
| for scale: `JSON.stringify(/api/buses)`, which already happens per poll | 1.9 ms |

~35 ms every 5 s is ~0.7% of one core — but it was **synchronous on the event
loop that also serves `/api/buses` at ~40 req/s**, so it was 35 ms of
head-of-line blocking per poll. Most of it is per-BUS belief stepping, not
per-stop pricing: dropping 118 of 172 target stops saved only 8 ms. Warmth is
why every route is stepped even though only allowlisted routes are served — a
widened allowlist must not start cold.

**A worker thread was the expected answer and was not needed.** The pass is
chunked instead: `computeUpcomingArrivals` is now a thin synchronous drain of
`upcomingArrivalUnits`, a generator that yields after each BUS priced, and the
server drains the same generator across `setImmediate` turns,
`SLICE_BUDGET_MS` (4 ms) at a time. The unit is a bus because that is where
the cost is; the budget is a dial set against the bench, not a feeling.

There is exactly ONE implementation — a second, chunked copy of the estimator
is the failure this whole move exists to remove — so the parity suite drives
the chunked driver and still matches the browser row for row.

`scripts/server-eta-bench.ts` is the measurement. Both arms are INTERLEAVED
frame by frame in one process, because the Pi runs the canary's browsers all
day and an arm measured alone is measured under whatever load happened to be
there. 234 steady-state polls, all 15 routes:

| arm | longest synchronous slice, CPU ms | wall ms |
|---|---|---|
| one uninterrupted pass (what stage 1 did) | p50 36.1, p90 43.1, max 139.2 | p50 42.0, max 215.8 |
| chunked at 4 ms | **p50 6.5, p90 9.8, max 27.8** | p50 7.7, max 54.5 |

| | first poll of a process (every ring and stand table built) |
|---|---|
| unchunked | 462, 54, 51, 51, 58, 55 ms |
| chunked | 9, 9, 7, 34, 8, 8 ms |

Wall clock per poll is unchanged (42.5 → 44.6 ms total): the yields cost about
two milliseconds and buy a 5.5x smaller block, and 5.7x on the cold first poll
— which is the one a deploy hands every rider at once.

**One step per observation survives the chunking, and that is the constraint
worth the most care.** A pass now spans event-loop turns, so a second poll can
land mid-pass. It is QUEUED, never interleaved: two passes advancing the same
beliefs over different fixes would corrupt every belief in the store. Only the
newest queued version runs — a machine stalled long enough to build a backlog
wants the freshest fix, not the backlog. Three tests pin it (same version
twice steps once; three versions fired without awaiting step twice; no
synchronous slice exceeds 5x the budget).

The wiring follows. `contribute` is split into `step` (async, chunked, the
collector's poll) and `answer` (pure, what a request reads), so a REQUEST can
no longer step a belief at all. `createBusesPayloadCache` grows a `prime()`
that the poll observer calls: step first, then build the string the next five
seconds of requests share — building first and stepping after would leave the
cached payload a whole poll behind the belief that produced it. Its key gains
the answer version for the same reason.

## Payload, measured

Against a real production body (135,995 B raw, 33,980 B gzipped, 2026-09-09):

| allowlist | rows | field raw | payload raw | payload gz | delta gz |
|---|---|---|---|---|---|
| default (Red, Blue Day) | 270 | 7,256 B | 143,265 B (+5.3%) | 37,141 B | **+3,161 B, +9.3%** |
| every line | 591 | 15,960 B | 151,969 B (+11.7%) | 40,630 B | **+6,650 B, +19.6%** |

Rows are `[busIndex, stopId, eta, low, high, stopsAhead, estimated]` against a
`buses` index table, because an object per row spends more bytes on repeated
keys than on numbers.

**The completed migration is a net REDUCTION.** `segments` (8,295 B gz),
`dwells` (6,751 B gz), `pace` (542 B gz) and `model_params` (246 B gz) exist in
the payload *only* so the browser can price arrivals itself — 15,834 B gzipped,
against 6,650 B for serving every line's answer. Stage 1 is the expensive half
of the trade taken on its own.

## Stage 2 — the instrument, migrated BEFORE anything switches

`docs/rider-sim.md` treats `computeUpcomingArrivals`' signature as the
instrument's contract. That paired FIXED/INTRODUCED gate refused τ = 0.55
(4 fixed / 20 introduced), per-route `ROUTE_SCALE` (1/10) and `heading`
(2/13), and would have caught #176. **Switching the computation without
migrating the instrument means shipping on aggregates, which is how
2026-09-09 went wrong.**

The simulator opened **one `AnchorStore` per rider cohort**, cold at the
moment those riders reach the stop — which is right, because that is when a
browser opens the app. `WARM_STORE=1` is the server arm: ONE store stepped
over every poll of the day, every stop on every route targeted exactly as
`ServerEta` does, and every rider reads rows out of it. Nothing about the
contract changes; the same call, the same arguments, a different store and a
wider target list.

Two details that make it faithful rather than approximate:

- **Every stop, not just the ones riders are at.** `computeUpcomingArrivals`
  skips a whole route when no target sits on it, so a narrower list would
  leave that route's beliefs unstepped and cold for the next rider on it.
- **The warm arm does NOT re-call per cohort.** Stepping every belief a second
  time on one fix is a repeat observation the model reads as evidence the bus
  is standing — the server calls this "one step per observation" and the
  simulator has to obey it too.

A run sliced with `FROM`/`TO` still pays for the whole day unless
`DETECTOR_FROM` moves with it. Give it ≥15 min of lead: a belief unseen for
`BELIEF_STALE_MS` (10 min) is reset on read, so beyond that a warm-up is
indistinguishable from having run since dawn.

## Stage 3 — the dual run

`serverEtaShadow.ts`. The server records its own answer into `predictions_log`
under `surface = "server"`, exactly the way `collector/upstreamEta.ts` records
the operator's under `upstream`: same table, same 15 s dedup bucket, same
`truthAt` rule, the same `arrivals` rows to pair against. Comparing the arms
is then a query rather than an argument, over the very (bus, stop, instant)
triples riders were looking at.

**A rider's post drives it, not a timer.** A shadow row is only worth writing
where a rider row exists to compare it against, and pinning the volume to the
rider surface's own (~3k rows a day) is what keeps it out of the disk
arithmetic that gave `upstream` its separate 7-day sweep. A census of the
allowlisted lines would be ~100 rows a bucket, ~500k a day, on a volume with
~430 MB free.

The two surface lists stay separate, and that separation is the security
boundary:

- `server` is in `PREDICTION_SURFACES` — what the COLUMN may hold.
- `server` is NOT in `SHOWN_SURFACES` — what a browser may claim it displayed.
  If a client could post it, anyone could write into the arm a rider-facing
  switch is judged on. `PredictionRecorder.shadow` refuses a shown surface at
  run time as well as in the type system.
- `RIDER_SURFACES_SQL` is now `surface NOT IN ('upstream', 'server')`. It
  shipped wrong once for an hour, so the test no longer pins the one excluded
  arm by name: it walks `PREDICTION_SURFACES` and fails on ANY member that is
  not a rider's screen and is not named in the clause.

A belief more than three collector polls from the reading is refused rather
than filed: a poll or two apart is like-for-like, minutes apart is two
different moments dressed as one.

## What has to follow

- **Stage 4, the client switch** — read `server_eta` instead of computing.
  Route by route on the allowlist, as the ring estimator itself went out.
  Client-side a bug is bounded by the allowlist; server-side it reaches every
  rider at once.
- **CLAUDE.md** gets the section when the client actually switches. Nothing a
  rider sees has changed yet.

## Things that did not port cleanly

- **`web/src/` is not in the runtime image.** The Dockerfile's backend stage
  copies `src/` only; `web/dist` (the bundle) is all that reaches production
  from the frontend. So the estimator's sources are copied explicitly, and
  `serverEta.closure.test.ts` recomputes the import closure and fails if the
  `COPY` has fallen behind — otherwise a new import would pass every gate and
  crash the process on boot.
- **The root tsconfig is stricter than `web/`'s** (`noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`), and importing across the boundary pulls the
  web files into the stricter program. 36 sites in `geo.ts`, `map-data.ts` and
  `arrivals.ts` needed non-null assertions — type-level only, erased at
  runtime, no behaviour change. That was the smallest change that works;
  project references would have meant `tsc --build`, `composite: true` and
  emitted declarations across the whole repo.
- **The estimator carries process-global state**: the registered polylines
  (`anchor.ts`), the ring and table caches (`eta/ring.ts`, `eta/index.ts`) and
  the published parameter set (`eta/params.ts` `MP`). One server process with
  one network is fine, and the server applies `model_params` exactly where the
  client does. But the estimator cannot price two different networks
  concurrently in one process, and a future multi-tenant anything would have to
  thread that state rather than register it.
- **The `/api/buses` cache rebuilds on a one-second wall clock** during an
  upstream outage, not only when the collector's data version moves. Stepping
  the filter twice on the same fix would hand it a repeat observation upstream
  never sent — which this model reads as evidence the bus is standing — so the
  step is gated on `dataVersion()` and a same-version call re-serves the rows
  it already has, minus buses that have since aged off the live list.
