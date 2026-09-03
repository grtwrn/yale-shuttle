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
scores the kalman worktree's filter via `_arrivals-anchored-kalman.ts`. Every
arm is paired against shipped on the same transitions, with a departure trace
(arm − shipped for the six polls after every production `at_stop_id` → null)
and the freeze share split by whether the raw fix moved. It also replays the
trip card's "next in" rule old vs new (PR #74). Findings, 2026-09-03: at ≥300 s,
65% of incidents are lap wraps (correct), 31% anchor flips (the defect, 1,586 in
6.5 h, 1,149 of them −1 flips mostly triggered by `at_stop_id` clearing);
"twitch" transitions are buses driving at 7.5 m/s. `_detector-pre57.ts` is the
detector before PR #57, for `DETECTOR=pre57`.
