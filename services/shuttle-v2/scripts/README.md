# map-bot — end-to-end test infra for the live shuttle map

Two complementary checks that exercise the production site at
`https://yale-shuttle.fly.dev` like a real rider. Both are black-box: they hit
the public URL, so they need no local server and no git checkout.

| Command | What it does | Needs a browser? | Use for |
|---|---|---|---|
| `npm run mapbot` | Picks a random trip, calls `/api/plan`, sanity-checks the result, names the bus to watch | No | Fast smoke / CI gate |
| `npm run mapbot:visual` | Drives the real UI in chromium: geolocated origin → types destination → screenshots the plan + Leaflet map → watches the bus approach | Yes | Visual verification |

## `npm run mapbot` (data-level)

Deterministic, headless, runs anywhere. Picks two stops 700–6000 m apart,
jitters ~90 m, plans the trip, and validates the planner output the way a map
bug would manifest (leg chain, positive times, board/alight stops on the map).

- Prints a human summary on **stderr** and one machine line on **stdout**:
  `<BOT_RESULT>{…}</BOT_RESULT>`.
- **Exit codes:** `0` sane result (shuttle OR legit walk-only), `1` malformed
  planner output, `2` fatal error. → usable directly as a CI assertion.
- Env: `BOT_BASE_URL` (default prod), `BOT_SEED` (reproducible trip),
  `BOT_PREFER_SHUTTLE=1` (re-roll up to 20× for a trip with a live bus to watch).

## `npm run mapbot:visual` (browser)

Runs `map-bot.mjs` for the trip + ground truth, then drives chromium via
Playwright. Chromium is auto-selected: `BOT_CHROMIUM_PATH` override →
`/usr/bin/chromium` if present (this arm64 Pi) → Playwright's bundled browser
(x86 cloud). The legacy `chromium --screenshot` CLI hangs on the Pi; CDP
automation (what Playwright uses) works — that's why this path is Playwright.

- Sets the browser **geolocation** to the trip origin (the app uses "current
  location" as the start — there is no origin box) and types only the
  destination. `domcontentloaded`, never `networkidle` (the SPA streams forever).
- Artifacts in `scripts/.bot-artifacts/run-<timestamp>/`: `00-loaded.png`,
  `01-plan.png`, `01b-map.png`, `02-watch-N.png`, and `meta.json` (trip,
  ground-truth plan, per-cycle bus distances, console errors). Emits
  `<BOT_VISUAL>{…}</BOT_VISUAL>` on stdout. Exit `1` on page crash / no shots.
- Env: `BOT_WATCH_CYCLES` (default 3), `BOT_WATCH_INTERVAL_MS` (default 60000),
  `BOT_OUT` (artifact dir). Set `BOT_WATCH_CYCLES=0` for a fast no-watch run.

The judgment step (is the map actually good?) is done by reading the PNGs —
either a human, or the scheduled cloud agent whose Read tool renders images.

## Scheduled cloud agent

A twice-daily routine (9am/5pm ET) runs this same flow in the cloud on Opus,
reads its own screenshots, and files an in-app report prefixed `[map-bot]` only
on a genuine defect. It uses a self-contained prompt (not these files). See the
project memory note `project-map-bot-routine` for the routine id and details.

## Quick examples

```bash
cd services/shuttle-v2
npm run mapbot                                   # fast CI smoke (exit code = verdict)
BOT_SEED=42 npm run mapbot                        # reproducible trip
BOT_PREFER_SHUTTLE=1 BOT_WATCH_CYCLES=3 npm run mapbot:visual   # full visual + bus watch
BOT_WATCH_CYCLES=0 npm run mapbot:visual          # fast visual smoke (no watch loop)
```

---

# `id-churn-replay.ts` — detector replay for the vehicle-identity fix

Offline, no browser, no server. Replays recorded `raw_positions` through the
real detector under three keying strategies and prints what each does to the
calibration tables (segments, legs covered, >60 km/h impossible samples, total
travel seconds, segments that span a hole in the feed).

Upstream's `bus_id` is reissued per service block — 1,059 distinct ids for 50
distinct `bus_name`s over 30 days of production, median id lifetime 5.9 h — so
this is how you check that a change to identity handling helps rather than
quietly inflating travel times.

```bash
# 1. Dump the last ~6 h of raw positions from prod, READ-ONLY.
cat > /tmp/dump.js <<'JS'
const D = require("/app/node_modules/better-sqlite3"), zlib = require("zlib");
const db = new D("/data/shuttle-v2.db", { readonly: true });
process.stdout.write(zlib.gzipSync(Buffer.from(JSON.stringify({
  stops: db.prepare("SELECT id,name,lat,lon FROM stops").all(),
  routes: db.prepare("SELECT id,name,short_name shortName,color,stops_json stopsJson FROM routes").all(),
  pos: db.prepare("SELECT bus_id,bus_name,route_id,lat,lon,heading,last_stop_id,collected_at FROM raw_positions ORDER BY collected_at, id").raw().all(),
})), { level: 9 }).toString("base64"));
JS
cat /tmp/dump.js | ~/.fly/bin/flyctl ssh console -a yale-shuttle -C "node -" \
  | tr -d '\r\n ' > /tmp/dump.b64
node -e 'const z=require("zlib"),f=require("fs");f.writeFileSync("/tmp/replay.json",z.gunzipSync(Buffer.from(f.readFileSync("/tmp/dump.b64","utf8"),"base64")))'

# 2. Replay.
npx tsx scripts/id-churn-replay.ts /tmp/replay.json
```

`raw_positions` is retained for 6 h, so that is the widest window available;
`jq` is not installed on the machine, parse with `node -e`.

## `node scripts/derived-path-check.mjs` (route geometry)

Grades the GPS-derived route geometry in `src/network/derivePath.ts` against
upstream's published `path`, for all 15 routes, on real production data. It
answers one question — *is the derived line actually better, and is it safe to
serve?* — and is deliberately adversarial, because a **wrong** route line is
worse for a rider than a coarse one.

Pulls `raw_positions` / `routes` / `stops` from the production SQLite
**read-only** over `flyctl ssh console` and caches them to
`scripts/.cache/derived-path-inputs.json` (45-minute TTL), so repeat runs cost
nothing and never touch production.

- **Table 1** — stop-to-line distance for upstream vs derived, measured both to
  the nearest **vertex** (what `stopDistances`/`isBetterThanUpstream` judge, and
  what the consumer actually snaps to) and to the nearest point **on the
  polyline**; plus the end-to-end number: how many legs of the stop sequence
  `buildStopSequencePolyline` draws as a straight cross-block diagonal instead
  of following the road.
- **Table 2** — samples, buses, lap length vs the route's own length, poll
  cadence, the longest unobserved hop, and each shape statistic beside the same
  statistic measured on upstream's own line.
- **Adversarial checks** — two laps or a lap plus a deadhead; a lap that took a
  different road; a straight chord across blocks; a path resting on too few
  samples or a single odd bus (with cross-bus agreement when a second bus has a
  full lap); backtracking, self-retracing and out-of-sequence stops; and, for
  routes 9/10, that the West Campus out-and-back spur is covered, not cut. The
  shape checks are calibrated against upstream rather than an absolute
  threshold, because Pink (VA Hospital) and Green/Purple (West Campus)
  legitimately double back.
- **Not derived** — says which routes produced nothing and why, and whether
  their schedule says they should be running. Overnight, "no data" for Blue
  Weekend / Grocery is the correct answer, not a failure.

**Exit codes:** `0` no accepted path failed a check (routes that are simply not
running are fine), `1` an accepted path failed an adversarial check — do not
serve it, `2` the harness itself broke.

Flags: `--refresh` (re-pull), `--route=14`, `--json`, `-v`, `--geojson=13`
(writes `scripts/.cache/route-13.geojson` with the derived line, upstream's line
and the stops, for eyeballing on a map).

---

# `npm run canary` — the rider that never stops riding

A synthetic rider that uses the app the way a person does and **watches until
the shuttle actually arrives**. One rider at a time, one browser, launched and
closed per run; `--loop` keeps one going whenever a line is running and sleeps
when none is.

It exists for a measurement nothing else here makes. `eta-accuracy.mjs` and
`eta-replay/` score predictions against truth **in aggregate** — median error,
share within two minutes. Neither looks at the **sequence one rider sees**, and
that is the whole of the operator's complaint:

> "i'm not worried about a few seconds. i'm worried about saying a bus is 10min
> away and then a few seconds later dropping to 1 second."

Riders have filed the same thing twice (#64 "4:06 … then 3:55", #32 "6 min then
it said 16"). A run of predictions can be individually excellent and still read
as broken in that order.

## What one run does

1. Picks a line that is **actually running** — all fifteen, round-robin —
   where "running" means the server is reporting live buses on it. That is the
   service-hours gate, and it needs no schedule table: `/api/buses` already
   drops out-of-service ghosts (report #30), so a line with no buses is a line
   with nothing to watch whatever the timetable says.
2. Plans the trip for that line in the real UI at 390×844 with
   `/usr/bin/chromium`, geolocation as the origin. **Prospect / Canner →
   School of Public Health (YSPH)** — the operator's own trip — for every line
   that comes within 700 m of both ends: Red, Blue Day, Orange Day, Brown and
   the evening blues. For a line that does not (Pink's nearest stop to the
   origin is 2.5 km away), a trip **derived from that line's own published
   stops**: board at its first, ride a quarter of the loop. Fifteen hand-typed
   stop pairs would be fifteen things rotting against upstream, and stop lists
   are not hand-edited here.

   The 700 m is not `MAX_WALK_M`. At the planner's 1500 m limit fourteen of
   fifteen lines "serve" this trip, including ones the app is right to bury,
   and the canary would report every one of them as a missing line. 700 m is
   ~8.5 min on the app's own walk model — the walk the planner itself chose for
   Blue Day's board stop on this very trip.
3. Reads the app's **own** answer to "which stop am I walking to" out of the
   details view's Directions link, rather than assuming the nearest one — the
   planner walks a Blue Day rider 8 min down Whitney to skip eight stops.
4. Watches: `/api/buses` every 5 s for ground truth (nothing in that channel
   reads the app's numbers), the rendered countdown every 15 s, until the bus
   reaches that stop.

## What it measures

Every number the rider is shown, in order. The display is **bucketed** —
`fmtMin` renders "now", "<1 min", "N min" — so `canary-metrics.mjs` works on
intervals and reports the **smallest** movement consistent with two readings.
A reported jump is one the app provably made; bucket edges can never invent one.

| term | meaning |
|---|---|
| drift | seconds the countdown moved beyond what elapsed time explains. 0 = healthy |
| reversal | drift > 0 — the countdown went **up** |
| catastrophic | \|drift\| ≥ 180 s — the bound `accuracy-layover.test.ts` already puts on a lurch, applied without its exemption for the departure moment |
| first-sight miss | how far outside its first promise the bus actually arrived |

Every finding is attributed where it can be: the app's own "You can't catch
#40 — showing the next bus" line, the pinned vehicle re-read from the details
view immediately after a jump, and the per-tick distance of every bus on the
line to the board stop.

## Output

Silent and exit 0 when healthy. On a finding it prints the run to **stderr**
and exits 1. **A run that parsed no countdown fails** (`no-countdown`) rather
than passing: a scraper that has silently stopped reading looks exactly like a
healthy line, and the neighbouring watch at `~/eta-live` filed "Purple kept its
promises" off a ride with zero recorded promises on 2026-09-03. Every run — healthy or not — appends one JSON object to
`scripts/.canary/runs.jsonl` (last 400 kept, ~a fortnight of continuous
riding), holding the full tick-by-tick sequence, the bus snapshots beside it,
the pins and the failures.

```bash
npm run canary                    # one rider, then exit
CANARY_LINE=Purple CANARY_WATCH_MAX_MIN=3 npm run canary -- --verbose
                                  # probe one line: does it plan at all?
                                  # (a short ceiling reports `no-arrival` by
                                  # construction — that is the probe, not a bug)
npm run canary -- --loop          # keep a rider going
npm run canary -- --summary       # health digest across the log
npm run canary -- --verbose       # narrate the watch
CANARY_LINE="Blue Day" npm run canary -- --verbose   # force one line
```

Env: `BOT_BASE_URL`, `BOT_CHROMIUM_PATH`, `CANARY_DIR`, `CANARY_LINE`,
`CANARY_TICK_MS`, `CANARY_WATCH_MAX_MIN`, `CANARY_CATASTROPHIC_SEC`,
`CANARY_FIRST_SIGHT_MISS_SEC`, `CANARY_IDLE_SLEEP_MIN`, `CANARY_REST_MIN`.

**It never files a report.** Findings go to the log and to whoever is reading
stderr; a bot that filed its own reports was turned off once already.
