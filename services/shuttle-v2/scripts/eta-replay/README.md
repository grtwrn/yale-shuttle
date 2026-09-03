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
