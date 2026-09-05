# eta-replay — score the ETA riders see against what actually happened

Offline, no browser, no production access. Both scripts read a **copy** of the
production SQLite and replay the app's own arithmetic (`web/src/arrivals.ts`,
`web/src/anchor.ts`) with a **time-travelled** calibration: for each ET hour
they rebuild what `buildBusesPayload` would have served at the start of that
hour from the segment rows that had completed by then (the real
`computeSegmentStats` + `TransitNetwork`, so the plausibility filter applies),
then compare every prediction with the bus's real arrival.

| script | what it scores | pairs |
|---|---|---|
| `eta-replay.ts` | a bus standing at a stop: sum of served segment times to the next 1–10 stops (the ride leg, and the wait leg before the bus moves) | ~100k per 2 days |
| `gps-replay.ts` | every raw GPS position through the REAL `findRouteAnchor` + `computeUpcomingArrivals` to the next 1–5 stops: anchoring, mid-segment proration, stall credit | ~300k per 7 h of `raw_positions` |
| `layover-replay.ts` | the stationary/layover clock: how often a PARKED bus restarts it, what that costs the ETA, and which (radius, hysteresis) fixes it | 879 stop visits per 7 h |
| `compare-upstream.ts` | **ours vs the official app**: `predictions_log` rows from the rider surfaces against `surface = "upstream"` (the operator's own `routes_eta.php`), both paired to the same arrivals. No replay — it scores what each app actually said | shared (bus, stop, minute) triples |
| `report.mjs` | renders the JSON both write into `report.md` | |

```bash
# 1. take a snapshot (production is untouched; the backup API copies pages)
printf 'const D=require("/app/node_modules/better-sqlite3");new D("/data/shuttle-v2.db",{readonly:true}).backup("/tmp/snap.db").then(()=>process.exit(0))' \
  | ~/.fly/bin/flyctl ssh console -a yale-shuttle -C "node -"
~/.fly/bin/flyctl ssh sftp get /tmp/snap.db ./store/snap.db -a yale-shuttle

# 2. replay (a few minutes each on the Pi; TZ is mandatory — the calibrator
#    uses local getDay/getHours)
cd services/shuttle-v2
TZ=America/New_York REPLAY_DB=./store/snap.db npx tsx scripts/eta-replay/eta-replay.ts
TZ=America/New_York REPLAY_DB=./store/snap.db npx tsx scripts/eta-replay/gps-replay.ts
node scripts/eta-replay/report.mjs      # -> scripts/.eta-replay/report.md

# ours vs the official Downtowner app, same arrivals (no replay, just a query)
TZ=America/New_York REPLAY_DB=./store/snap.db \
  npx tsx scripts/eta-replay/compare-upstream.ts
#   env: HOURS (24), FROM/TO (ISO), ROUTES (ids), MIN_CELL (50)
#   caveat: routes_eta.php serves WHOLE MINUTES, so ~±30 s of the official
#   arm's error is rounding. Quote the HEAD-TO-HEAD block, not the per-arm
#   one — the arms do not cover the same stops.

# the layover clock (findings in docs/layover-clock.md). BUSES_JSON is a saved
# `curl -s https://yale-shuttle.fly.dev/api/buses` and supplies the dwell/segment
# tables the client bills, which is what turns a clock reset into seconds of ETA.
curl -s https://yale-shuttle.fly.dev/api/buses -o ./store/buses.json
REPLAY_DB=./store/snap.db BUSES_JSON=./store/buses.json \
  npx tsx scripts/eta-replay/layover-replay.ts   # -> scripts/.eta-replay/layover.json
```

Env: `REPLAY_DB` (default `./store/snap.db`), `REPLAY_OUT` (default
`scripts/.eta-replay`), `EVAL_DAYS` (21), `EVAL_START` (`YYYY-MM-DD HH:MM` ET,
overrides EVAL_DAYS), `SAMPLE_EVERY` (1 = every origin), `OUT_NAME`.

Error convention: **predicted − actual, seconds; negative = the app was
optimistic** (bus came later than promised).

Read `docs/eta-accuracy.md` before changing the estimator: it records the
2026-09-02 baseline and 28 variants that were measured with these scripts, and
which of them made things worse. Run both replays after touching
`calibrator.ts`, `arrivals.ts` or `anchor.ts`, and put the before/after in the
PR.

`raw_positions` is retention-swept, so the GPS replay only ever covers the last
few hours; take the snapshot at the end of a service day to get a full one.

## jitter-audit.ts — the jump classification, re-derived and paired

`jitter-audit.ts` replays the REAL `computeUpcomingArrivals` over a snapshot and
explains every ETA jump ≥120/180/300/600 s two ways: with `jitter-classify.ts`'s
labels (real / moved / twitch / eventless) and MECHANICALLY from the anchor the
ETA actually used (wrap / flip / advance / atstop / clock / proration / calib),
per stop AND per incident (one bus, one poll pair). It builds `at_stop_since`
from `stationarySince` — what `collector.ts` serves — unless `SINCE=entered`,
which reproduces the earlier harnesses (and claim A's 16,128 to the unit).

```bash
TZ=America/New_York REPLAY_DB=./store/snap.db npx tsx scripts/eta-replay/jitter-audit.ts
#   SINCE=stationary|entered   DETECTOR=new|pre57   ARM=none|gate|belief|guard   OUT_NAME=...
```

`ARM=gate` needs a tree where `computeUpcomingArrivals` takes an `AnchorStore`
(PR #72); `ARM=guard` one where it takes an `EtaGuard` (PR #75); `ARM=belief`
scores the kalman worktree's filter via `_arrivals-anchored-kalman.ts`.
`ARM=anchor` pairs two CLIENT TREES — a change to `findRouteAnchor` or
`gateAnchor` cannot be switched on by an argument — importing master's
`web/src` from a git archive (`SHIPPED_SRC`, required) as the shipped series
and this tree (or `ARM_SRC`) as the arm, each with its own `AnchorStore`
(`STORE=1`, production's shape since PR #72; `STORE=0` scores the stateless
anchor). Point both at the same commit and `armMismatches` must be 0, which is
the replica proof (0 over 2,119,003 ETAs on 2026-09-03):

```bash
mkdir -p /tmp/shipped && git archive origin/master services/shuttle-v2/web/src | tar -x -C /tmp/shipped
ARM=anchor SHIPPED_SRC=/tmp/shipped/services/shuttle-v2/web/src TZ=America/New_York REPLAY_DB=./store/snap.db \
  npx tsx scripts/eta-replay/jitter-audit.ts
```

The departure trace is split by whether the watched stop is the one the bus
was standing at (`armMinusShippedAtAStopAhead`): shipped's soonest stop at t0
is the stood-at stop itself whenever the second-visit refinement was refused on
Purple/Green, and an arm that correctly answers "a lap" there reads as
+5,000 s "later". Every
arm is paired against shipped on the same transitions, with a departure trace
(arm − shipped for the six polls after every production `at_stop_id` → null)
and the freeze share split by whether the raw fix moved. It also replays the
trip card's "next in" rule old vs new (PR #74). Findings, 2026-09-03: at ≥300 s,
65% of incidents are lap wraps (correct), 31% anchor flips (the defect, 1,586 in
6.5 h, 1,149 of them −1 flips mostly triggered by `at_stop_id` clearing);
"twitch" transitions are buses driving at 7.5 m/s. `_detector-pre57.ts` is the
detector before PR #57, for `DETECTOR=pre57`.

## belief-scoreboard.ts / priors.ts — the estimator lane's instruments

`belief-scoreboard.ts` scores anti-jitter arms at the transition level against
the REAL gated `computeUpcomingArrivals` (its own `AnchorStore` per run; a
`replica` arm must match it on every poll or the run is invalid). It reads the
durable JSONL capture (`~/shuttle-captures/positions-*.jsonl`, deduplicated
across the UTC day roll), builds `at_stop_since` from the stop-pinned
`stationarySince` production serves, separates legitimate lap wraps from
jitter, attributes every jump by what the feed did AND what the arm did,
resolves truth to the right pass of a stop, scores layover departures with
the plateau walk-back, and prints fixed-target traces for the browser-observed
incidents. `priors.ts` measures the estimator's likelihood tables from the
same corpus with the detector only. Findings and the design they feed:
`docs/eta-estimator-design.md`.

```bash
TZ=America/New_York REPLAY_DB=./store/snap2.db npx tsx scripts/eta-replay/belief-scoreboard.ts
#   ARMS=beliefA,ungated  START="2026-09-03 16:30" END="2026-09-03 17:55"  POSITIONS_JSONL=a.jsonl,b.jsonl|db
TZ=America/New_York REPLAY_DB=./store/snap2.db npx tsx scripts/eta-replay/priors.ts
```

## rider-sim/ — a day of riders, each one's countdown from first sight to boarding

`rider-sim/run.ts` is the third instrument, and the one that answers the
operator's question ("said 10 min, then a few seconds later 1 min") directly:
it instantiates synthetic riders — (line, board stop, arrival instant, optional
origin) — over a day of captured positions and replays, poll by poll, the exact
text the trip card would have shown each of them until their bus reached the
curb. The unit of output is a WAIT, not a transition. Findings and the
acceptance record are in `docs/rider-sim.md`.

```bash
cd services/shuttle-v2
# default: Red focus (uniform every 10 min + targeted at departures/last bus),
# Green + Purple hold-out, and the 344 Winchester chain cohort
TZ=America/New_York REPLAY_DB=./store/snap3.db npx tsx scripts/eta-replay/rider-sim/run.ts
# a named rider: line@stopId@ISO[@lat,lon]; the canary's Red rider stands at Prospect / Canner
TZ=America/New_York REPLAY_DB=./store/snap3.db npx tsx scripts/eta-replay/rider-sim/run.ts \
  --rider Red@48@2026-09-03T21:21:25Z@41.325351,-72.922891
# score another tree, then pair the two runs wait for wait
CLIENT_ROOT=/path/to/worktree/services/shuttle-v2 OUT_NAME=candidate ... npx tsx scripts/eta-replay/rider-sim/run.ts
npx tsx scripts/eta-replay/rider-sim/run.ts --compare scripts/.eta-replay/rider-sim.waits.jsonl scripts/.eta-replay/candidate.waits.jsonl
```

Env: `CAPTURE` (default every `~/shuttle-captures/positions-*.jsonl`, de-duplicated
on (bus_id, collected_at) because each day's file re-dumps the retention
window), `REPLAY_DB`, `CLIENT_ROOT`, `ROUTES=Red|all|…`, `HOLDOUT=Green,Purple`,
`CHAIN=Red:11:6`, `POP=both|uniform|targeted|none`, `EVERY_MIN=10`,
`MAX_WAIT_MIN=45`, `SAMPLE_MS=5000`, `CANARY_MS=15000`, `FROM`/`TO` (riders),
`DETECTOR_FROM` (cold-start the detector later than the capture — production
restarts on every deploy), `CALIB_LAG_MIN`, `TRACE=1` (every poll of every
named rider: bus, anchor, live list, text), `OUT_NAME`.

**The time-travelled replicas serve v1's fields only** (`{avg, sd, n}` per
hop, `{med, sd, n, low}` per stop). Everything production serves beyond that —
the stand/drive split (`drive`/`driveN`, `q`/`qn`) and the probabilistic
estimator's inputs (`dq`/`dqn`, `pstop`, the route `pace`) — reaches the
replayed client only through `PAYLOAD_PATCH`, a single table merged once into
every hour bucket (so it is calibrated at ONE instant, not time-travelled;
`model-patch.ts` says what that costs). Without it every hop takes the
pre-split fallback path, silently. `model-patch.ts` writes the file from the
snapshot through the calibrator's own loaders and `v1compat.ts`'s own
emitters, so the bytes match the live payload:

```bash
TZ=America/New_York REPLAY_DB=./store/snap.db npx tsx scripts/eta-replay/model-patch.ts
#   MODEL_OUT=path  MODEL_NOW=ISO  MODEL_ROUTES=served|all  (default: production's allowlist)
TZ=America/New_York REPLAY_DB=./store/snap.db PAYLOAD_PATCH=./scripts/.eta-replay/model-patch.json \
  npx tsx scripts/eta-replay/rider-sim/run.ts ...
```

`pace[route]` is folded by `run.ts` into the reserved `segments[route]["__pace"]`
carrier row (`PACE_KEY` / `paceCarrier` in `src/server/v1compat.ts`), exactly
as the live payload carries it, so `computeUpcomingArrivals`'s signature — the
contract every replay here depends on — is unchanged.

It calls the real client — `planTrip`, `computeUpcomingArrivals` with a
per-rider `AnchorStore`, `pickLiveArrival` against the plan-time pin,
`nextArrivalAfterPinned`, `fmtBusPair` — and the real detector, all imported
from `CLIENT_ROOT`, whose HEAD and dirty flag go into the output. Scoring is
`canary-metrics.mjs`'s own (display buckets, smallest movement two readings
permit), so a simulated wait and a browser-watched wait are judged by one rule.

## card-vs-trip.ts / card-cost.ts — the app's OTHER ETA estimator

The route cards on the Map tab do not call `computeUpcomingArrivals`.
`StopList` in `TransitMap.tsx` has its own inline arithmetic — no gated
anchor, no stall credit, no proration, no stand/drive split, a de-duplicated
stop list, and it prints the LOW end of its interval. `card-vs-trip.ts`
transcribes that arithmetic verbatim, runs both estimators over every poll of
a capture, and reports how far apart they are, which one the buses agreed
with, and what each does to the SEQUENCE a rider watches. `card-cost.ts` times
the merge against a frame budget, because "the card is simpler because it
renders many stops" is a hypothesis and not a finding. Both are written up in
`docs/card-vs-trip.md`.

```bash
TZ=America/New_York REPLAY_DB=./store/snap3-split.db \
  PAYLOAD_PATCH=./scripts/.eta-replay/split-patch-0903.json \
  CAPTURE=$HOME/shuttle-captures/positions-20260903.jsonl \
  npx tsx scripts/eta-replay/card-vs-trip.ts
#   ROUTES=Red TRACE_STOP=48 FROM=... TO=...   one stop, poll by poll, both arms
#   EVERY=N  pair on every Nth poll (the detector and the store still step on all)
TZ=America/New_York REPLAY_DB=./store/snap3-split.db npx tsx scripts/eta-replay/card-cost.ts
```

Without `PAYLOAD_PATCH` the trip arm is the pre-#85 client and the script says
so. The transcription is **self-checked against `TransitMap.tsx` on every
run** — the script refuses to produce numbers once `StopList` gains the
machinery it is being measured against, which is how it retired itself when the
two were merged on 2026-09-04.

**Since the merge, use `BEFORE_SRC`.** It points the self-check at a checkout
of the pre-merge file, so the transcription is verified against the code it
CLAIMS to represent rather than against whatever is checked out; the `card` arm
is then master's route cards and the `trip` arm is this tree's shared
estimator — the paired before and after.

```bash
mkdir -p /tmp/before
git archive <pre-merge-ref> services/shuttle-v2/web/src/TransitMap.tsx | tar -x -C /tmp/before
BEFORE_SRC=/tmp/before/services/shuttle-v2/web/src/TransitMap.tsx \
  TZ=America/New_York REPLAY_DB=./store/snap3-split.db ... npx tsx scripts/eta-replay/card-vs-trip.ts
```

The sequence table splits **frozen** by whether the feed sent a NEW coordinate
for that vehicle. A number that does not move while the bus does not move is
honest; the defect is a frozen countdown for a bus that is provably driving,
and 53.6% of consecutive samples repeat a position rather than interpolating
(`docs/bus-speed.md`), so the unsplit share cannot tell the two apart.

## anchor-sweep / cand-size / jitter-probe / leg-coverage / anchor-bench — the anchor's own dials

The five instruments behind `docs/eta-accuracy.md`'s "What the lever was". All
read a DB snapshot only (no capture, no browser) and take seconds to minutes.

```bash
cd services/shuttle-v2
TZ=America/New_York REPLAY_DB=./store/snap.db npx tsx scripts/eta-replay/cand-size.ts
#   how many candidate legs each window admits, and how often the leg the
#   detector puts the bus on is not among them (chord 19.64%, road 3.63%)
TZ=America/New_York REPLAY_DB=./store/snap.db npx tsx scripts/eta-replay/anchor-sweep.ts
#   window (chord|road) x selection rule x ANCHOR_FEED_LEAD_HOPS x tie band,
#   scored against the detector. FIXED_ORACLE=1 pins the oracle to the chord;
#   ONLY_RULES=a,b restricts the table. READ ITS HEADER FIRST — the oracle is
#   itself chord-based, so this instrument can judge the SELECTION rule and
#   cannot judge the WINDOW.
TZ=America/New_York REPLAY_DB=./store/snap.db npx tsx scripts/eta-replay/jitter-probe.ts
#   displace a bus perpendicular to the road at every stop; how often does the
#   anchor change? (the tie band's lower bound)
TZ=America/New_York REPLAY_DB=./store/snap.db npx tsx scripts/eta-replay/leg-coverage.ts
#   how many legs the published line can supply, and how far each road bows off
#   its own chord
TZ=America/New_York REPLAY_DB=./store/snap.db npx tsx scripts/eta-replay/anchor-bench.ts
#   microseconds per whole-route findRouteAnchor, chord vs road
```

`make-incident-fixture.ts` regenerates `web/src/__fixtures__/anchor-incidents.json`
— the production feed rows the anchor tests replay — from the durable capture:

```bash
TZ=America/New_York REPLAY_DB=./store/snap.db \
  CAPTURE=$HOME/shuttle-captures/positions-20260904.jsonl,$HOME/shuttle-captures/positions-20260903.jsonl \
  OUT=web/src/__fixtures__/anchor-incidents.json \
  npx tsx scripts/eta-replay/make-incident-fixture.ts
```

The fold question is `branch-lock.ts`'s, not these — it counts the anchor
landing a LAP out of position, which is the only thing that decides
`ANCHOR_NEARER_M`.
