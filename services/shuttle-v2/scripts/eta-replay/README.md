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
machinery it is being measured against, which is how it retires itself when
the two are merged.

## split-patch.ts — the stand/drive split a replay cannot serve itself

`makeCalibCache` / `makeDwellCache` rebuild the v1 fields only (`{avg, sd, n}`
per segment, `{med, sd, n, low}` per dwell). Production also serves the
stand/drive split — `segments[route]["A-B"].drive`/`.driveN` and
`dwells[route][stop].q`/`.qn` — and `web/src/hopPricing.ts` prices the first hop
from it. A rider-sim run without those fields therefore scores the pre-split
fallback path and says nothing about the client that is live, while looking
exactly like a healthy run. That has already misled one measurement.

`split-patch.ts` writes the `PAYLOAD_PATCH` file `rider-sim/run.ts` has always
accepted. It re-derives nothing: `calibrate()`, `loadStandGroups` /
`loadDriveGroups` and `attachStandTables` / `attachDrives` are the calibrator's
own, and the emission is `v1compat.ts`'s two loops with its whole-second
rounding. The quantile levels, the median drive and the true sample counts (the
client gates on `MIN_STAND_SAMPLES` / `MIN_DRIVE_SAMPLES` itself; a floor here
would drift from its) therefore stay defined in one place.

**It reproduces what production serves, not everything the calibrator can
compute.** The split goes out on `SPLIT_SERVED_ROUTE_IDS` only and never on a
`foldRoutes` line, both read out of the calibrator so the patch follows the
server. `SPLIT_ROUTES=all` withholds nothing — deliberately not production's
behaviour, and there for one job: the paired before/after run CLAUDE.md requires
before a route joins the allowlist. On the 2026-09-03 snapshot it lifts the
patch from 60 hops to 224.

```bash
cd services/shuttle-v2
TZ=America/New_York REPLAY_DB=./store/snap3-split.db npx tsx scripts/eta-replay/split-patch.ts
TZ=America/New_York REPLAY_DB=./store/snap3.db \
  PAYLOAD_PATCH=./scripts/.eta-replay/split-patch.json \
  npx tsx scripts/eta-replay/rider-sim/run.ts --rider Red@48@2026-09-03T21:21:25Z@41.325351,-72.922891
```

Env: `REPLAY_DB`, `SPLIT_OUT` (default `scripts/.eta-replay/split-patch.json`),
`SPLIT_NOW` (the instant the calibration is taken at; default the snapshot's
last segment sample), `SPLIT_ROUTES=served|all` (default `served`).

**The snapshot needs `stop_visits` and `legs`.** Migration 0010 created them on
2026-09-04, so every snapshot taken before that has neither and the script
refuses. Backfill a writable copy from the position archive the way production
did, bounding it at the snapshot's own data end — the archive keeps running
after the snapshot was taken, and those rows are days the replay never reaches:

```bash
cp store/snap3.db store/snap3-split.db     # writable copy
sqlite3 store/snap3-split.db < drizzle/0010_minor_jackal.sql
TZ=America/New_York npx tsx scripts/backfill-departures.ts \
  --db store/snap3-split.db --before 2026-09-04T01:34:00Z
```

On the 2026-09-03 snapshot that yields 60 hops with a `drive` and 60 stops with
a `q` — Red 29/29, Blue Day 31/31, nothing elsewhere — which is hop for hop what
production served that night. The values check out against
`docs/data/departure-tables-2026-09-03.json` on Red's 344 Winchester: drive
11 -> 146 is 15 s over n = 25 against the reference's `drivePinned` median 15.1
over n = 25, and the stand table reads 598 s at level 0.95 against the
reference's 598.1. Its low end reads 111 s where the reference says 118.1
because `qn` is 25 against the reference's 24 — the calibrator counts the one
pinned pass-through as a 0 s stand, by measurement, and the reference table
excludes it.

**The patch is ONE static table, and that is a leak.** `run.ts` merges it into
every hour bucket, so unlike the calibration around it the split is not
time-travelled. It is defensible in kind: the split is pooled over
`SPLIT_WINDOW_DAYS` (30) and deliberately not sliced by (dow, hour). It is not
free in degree: these snapshots hold about one day of `stop_visits`, so the pool
*is* the replayed day, and a rider replayed at 09:00 is priced with that
evening's stands. Read such a run as "the split, as calibrated at the end of the
captured day" — enough to answer whether the split helps a line, not a claim
about what a rider was told at 09:00. Per-hour plumbing would have to go into
`run.ts`, which is shared; this script does not touch it.
