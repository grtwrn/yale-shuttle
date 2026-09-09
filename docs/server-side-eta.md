# Moving the ETA belief to the server — stage 1 (foundation, flag off)

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

## Cost, measured

Pi 5, `nice -n 10`, the 40-frame capture, 15 buses, 172 stops, medians over
three runs of 40 polls:

| | ms per poll |
|---|---|
| step + price EVERY route (what it does) | **35 ms** |
| price only Red + Blue Day (54 stops) | 27 ms |
| first poll (ring + table construction, amortised) | 49–290 ms |
| for scale: `JSON.stringify(/api/buses)`, which already happens per poll | 1.9 ms |

So ~35 ms every 5 s, ~0.7% of one core — but it is **synchronous on the event
loop that also serves `/api/buses` at ~40 req/s**, so it is 35 ms of
head-of-line blocking per poll. That is the honest number and the thing to
watch first if this is ever turned on under load. Most of it is per-BUS belief
stepping, not per-stop pricing: dropping 118 of 172 target stops saved only
8 ms. Warmth is why every route is stepped even though only allowlisted routes
are served — a widened allowlist must not start cold.

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

## What has to follow

- **The client switch** — read `server_eta` instead of computing. Route by
  route on the allowlist, as the ring estimator itself went out.
- **The rider simulator** (`docs/rider-sim.md`) follows without a signature
  change, because this PR does not touch `computeUpcomingArrivals`' contract —
  which is exactly the gate that refused τ = 0.55, per-route `ROUTE_SCALE` and
  `heading`, and would have caught #176. Today it opens **one `AnchorStore` per
  rider**, cold at the moment that rider reaches the stop. The switch makes
  every rider read one belief that has been tracking all day, so the simulator
  must model that: step ONE store over the whole day's polls and hand each
  rider rows out of it, instead of a store per rider. Same function, same
  arguments, one line of wiring in `rider-sim/run.ts`. The FIXED/INTRODUCED
  split is then measured between "cold store per rider" and "one warm store",
  which is the parity suite's third case at a day's scale. Chain block first,
  per route, `nice`d and sliced by `FROM`/`TO` — a full-day run pins all four
  Pi cores for hours.
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
