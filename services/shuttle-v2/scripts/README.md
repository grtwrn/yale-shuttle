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
