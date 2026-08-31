# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Live web app at **https://yale-shuttle.fly.dev** showing Yale Downtowner shuttle positions, stop-level ETAs, and trip planning. Deployed as a single Fly.io machine in `ewr` with a 1 GB persistent volume mounted at `/data`.

**As of 2026-06-04 the production app is `services/shuttle-v2/`** (Node/Hono backend + React SPA). The original v1 stack (`services/shuttle-collector/` + `services/shuttle-map/`) is **archived, not deployed** — its code stays in the repo for reference, its root `fly.toml` was renamed to `fly.v1-archived.toml` so a stray root `flyctl deploy` can't resurrect it, and its historical data remains untouched on the volume as `/data/shuttle.db`.

**There is only one site/URL.** `https://yale-shuttle.fly.dev` is a single Fly app named `yale-shuttle` — the very app v1 used to occupy. v2 took over that same app/URL; the separate `yale-shuttle-v2` app was destroyed. So "the v1 site" and "the v2 site" are the same address: it serves **v2 code today**, and it *looks* like v1 only because v2's frontend is a drifted fork of v1's (see below). Both `services/shuttle-v2/fly.toml` and `fly.v1-archived.toml` declare `app = 'yale-shuttle'`, but only the v2 one is live.

⚠️ **To change the live site, edit `services/shuttle-v2/web/src/TransitMap.tsx` — NOT `services/shuttle-map/app/src/TransitMap.tsx`.** The latter is archived v1; edits there compile and lint fine but change nothing in production. (This has bitten before — a feature was prototyped in the v1 file while the real one already shipped in v2.)

## Architecture (v2 — `services/shuttle-v2/`)

One Node process (`src/index.ts`, run via tsx) does everything:

- **`src/collector/`** — polls `https://yale.downtownerapp.com` every 5 s, writes to SQLite at `$SHUTTLE_V2_DB` (`/data/shuttle-v2.db` in prod, `store/shuttle-v2.db` locally) through Drizzle ORM (`src/db/`, migrations in `drizzle/`).
- **`src/calibrator/`** — periodically rebuilds segment/dwell stats from collected samples (logs `collector.calibrated` every 5 min; hourly retention sweep on `raw_positions`).
- **`src/server/app.ts`** — Hono HTTP server (port 8080 prod, 8092 dev). Native v2 endpoints (`/api/live`, `/api/stream`, `/api/plan`) plus a **v1-compatibility layer** (`src/server/v1compat.ts`): `/api/buses` (the fat payload the frontend polls), `/api/geocode`, `/api/report`, `/api/reports`, `/api/accuracy`, `/healthz`.
- **`web/`** — Vite/React SPA served as static files from `web/dist`. `web/src/TransitMap.tsx` (~6.8k lines) is the user-facing shell; **the pure logic was extracted on 2026-08-31** into sibling modules that are unit-tested and where most changes now belong:

  | module | owns |
  |---|---|
  | `planner.ts` | `planTrip`, trip options, walk/ride/dominance rules |
  | `arrivals.ts` | `computeUpcomingArrivals` — per-stop ETA math |
  | `anchor.ts` | `findRouteAnchor` — which stop a bus is at / has passed |
  | `schedule.ts` | `ROUTE_HOURS`, `isBusInService`, ET day/hour resolution |
  | `routes.ts` | `ROUTE_LISTS` — **the single source of truth for route colour** |
  | `walk.ts` | the walk model (mirrors the server's `WALK_M_PER_S`) |
  | `geo.ts`, `format.ts` | distance/projection, and `min`-suffixed formatting |
  | `anonId.ts` | the anonymous per-browser id (see Usage metrics) |

  It began as a copy of v1's frontend but has **drifted substantially — don't assume it matches `services/shuttle-map/app/`**.

The frontend computes ETAs client-side from the `/api/buses` payload (positions + calibrated segments/dwells); it does not use the native v2 endpoints. `/api/plan` is used only by `scripts/map-bot.mjs` as ground truth — so a bug there is invisible to riders but corrupts the automated checks.

## Common commands

```bash
cd services/shuttle-v2

npm run dev          # backend on :8092 (collector + server, tsx watch)
npm run typecheck    # backend types (tsc --noEmit) — frontend types are NOT covered by this
npm test             # vitest — 427 tests, covers src/ AND web/src/
npm run riders       # how many unique browsers are using the app

# frontend
cd web && npx vite build   # build = the frontend type/syntax gate
```

### Deploy

```bash
cd services/shuttle-v2
~/.fly/bin/flyctl deploy --remote-only   # deploys to the yale-shuttle app

# Health
curl -s https://yale-shuttle.fly.dev/healthz
# → {"ok":true,"pollStalenessMs":...,"collectorLagMs":...,"knownBuses":N}
~/.fly/bin/flyctl logs -a yale-shuttle --no-tail | tail -50
```

**Build `web/` (`npx vite build`) before deploying if you touched the frontend** — the Docker build compiles it, but building locally first catches errors without burning a deploy cycle.

## Conventions to preserve

These came from past bugs/feedback — don't re-litigate them:

- **Minutes** are spelled `min` in UI strings, never `m` (avoids mile confusion).
- **Origin / destination emoji**: 📍 / 🏁 (checkered flag), never 🎯.
- **Inputs must be ≥ 16 px font-size** to avoid iOS zoom-on-focus. Touch targets ≥ 44×44.
- **Hooks ordering in `TransitMap.tsx`**: a `useEffect`/`useMemo` dependency array is evaluated at render time — referencing a `const` declared later in the component is a TDZ `ReferenceError` that blank-screens the app (this happened; `main.tsx` now has an ErrorBoundary that surfaces such crashes instead of a white page).
- **TZ=America/New_York** in the Dockerfile — collector writes day/hour columns in ET. Don't change without auditing the calibration queries. The *client* must not read schedule times with `getDay()`/`getHours()` either: `schedule.ts` resolves ET explicitly, because a phone left on another timezone used to see "No shuttles running" while buses ran.
- **Route colour has one source**: `ROUTE_LISTS` in `web/src/routes.ts`. Three other tables used to hold their own copies and two had silently drifted. Everything else derives from it; a test fails if they disagree.
- **The walk model lives on the server** (`WALK_M_PER_S` in `src/network/TransitNetwork.ts`) and the client mirrors it. `walk.test.ts` parses the server's constant out of its source, so the two cannot drift. Change the server first, never one side alone.

## Bug reports

Users submit reports via the in-app "🚩 Report issue" / "💬 Send feedback". Workflow:

The two triage endpoints are **operator-only** — they require a shared secret,
because `GET /api/reports` returns each reporter's IP address alongside their
free-text complaint, and the update route was otherwise a public write into the
triage log. The token lives in the `SHUTTLE_ADMIN_TOKEN` Fly secret; a local
copy is at `~/.yale-shuttle-admin-token` (mode 600, deliberately outside the
repo). Without a configured token both endpoints fail closed with 503.

```bash
TOKEN=$(cat ~/.yale-shuttle-admin-token)

# triage queue
curl -s -H "x-admin-token: $TOKEN" \
  'https://yale-shuttle.fly.dev/api/reports?status=open'

# annotate when fixed
curl -s -X POST -H "x-admin-token: $TOKEN" -H 'content-type: application/json' \
  -d '{"status":"addressed","note":"..."}' \
  https://yale-shuttle.fly.dev/api/reports/{id}/update
```

`POST /api/report` (rider submissions) stays public and rate-limited.
`scripts/map-bot-cron.sh` reads the same token file for its dedupe check.

**Always annotate after a fix.** The resolution field is the triage log; append, don't replace. Next agent should not re-investigate cold.

## Usage metrics

`npm run riders` (or `GET /api/stats` with the same admin token) reports usage
and return visits: today (split new vs returning), 7 d / 30 d / all time, the
share that ever came back, week-1 retention, median days active, median minutes
per day, and destination searches.

The browser mints a random id (`web/src/anonId.ts`), keeps it in localStorage
beside the favourites it already stores, and sends it as `x-anon-id` on the
`/api/buses` poll it already makes — no extra request. The server writes **one
row per (ET day, id)** into `daily_actives` and nothing else: no IP, no user
agent, no coordinates, no time of day. 90-day retention, swept at the day
rollover.

**Retention needed no extra data.** A row per (day, id) already says whether a
browser came back, when it first appeared, and how many days it has been active.
The extra columns (`first_seen_ms`, `last_seen_ms`, `polls`, `searches`) buy
*depth* — time in app and query volume — not identity. A "search" is a
`/api/geocode` call, i.e. a deliberate destination lookup, as opposed to the
automatic 5-second poll.

**Week-1 retention only counts browsers that have HAD a week to return**, so it
is not diluted by yesterday's arrivals; it reports `null`, not 0, when nobody is
old enough to judge.

Three things to preserve if you touch it:

- **It must never cost a write per request.** `/api/buses` is ~40 req/s at
  launch load; the first sighting of an id writes one row and the id then lives
  in an in-memory Set for the day (~200 writes/day, not 3.5M). See
  `src/server/actives.ts`.
- **Counting must never break the endpoint.** Every path there is non-throwing;
  a rider with storage disabled is simply uncounted.
- **Counters accumulate in memory and flush on a timer** (60 s), so tests that
  inspect rows must `flush()` first — `stats()` flushes for you.

It counts browsers, not people — phone + laptop is two.

## Data-quality invariants

These are load-bearing; several rider-visible bugs traced to them:

- **`bus_id` is NOT a stable vehicle id.** TransLoc reissues it per service
  block (~1,000 ids for 50 buses in 30 days, median lifetime 5.9 h). `bus_name`
  (`#40`) is the identity. The detector keys on the name, qualified by id only
  while two ids report the same name in one poll — which genuinely happens.
  Naive name-keying is *worse* than the bug: every multi-minute feed gap
  coincides with a reissue, so it bills a layover as travel time.
- **Stops that are metres apart can be many stops apart in sequence.**
  College/Wall (S)/(N) are 28 m apart at sequence positions 18 and 28;
  Orange/Pearl (N)/(S) are 35 m but 9 apart. `at_stop_id` therefore *refines*
  the GPS anchor and must never override it.
- **Segment samples are filtered for physical plausibility before any
  statistic** (including the median — on long hops the bad samples were the
  majority). Without it the planner priced an 8.4 km ride at 97 seconds.
- **Routes 9 and 10 repeat stops** for the West Campus out-and-back. Keep the
  sequence verbatim and index by position; de-duplicating loses real legs.

## Verification harnesses

Beyond `npm test`, in `services/shuttle-v2/scripts/` (all
`BOT_CHROMIUM_PATH=/usr/bin/chromium node scripts/<name>.mjs`):

| script | asserts |
|---|---|
| `gps-tier-check.mjs` | one live high-accuracy geolocation watch, no downgrade |
| `timezone-check.mjs` | identical service state across 5 device timezones |
| `walk-fallback-check.mjs` | a long trip shows a walk, never "No trip options found" |
| `eta-accuracy.mjs` | scores the ETA riders see against real observed arrivals |
| `map-bot.mjs` / `map-bot-visual.mjs` | random trip vs `/api/plan`; browser capture |

`eta-accuracy.mjs` is the honest one: it reads what the app tells a rider while
independently watching raw positions for the actual arrival. Last measured
median error **1.26 min**, 71% within 2 min, with a known optimistic bias on the
*wait* leg of 20–25% of the remaining time (unfixed — the ride-time estimator
itself is unbiased).

## Don'ts

- **Don't deploy from the repo root.** The only live config is `services/shuttle-v2/fly.toml` (app `yale-shuttle`). `fly.v1-archived.toml` at the root is the retired v1 config — leave it dead.
- **Don't touch `/data/shuttle.db`** on the volume — that's v1's archived history.
- **Don't run standalone `tsc` against `web/`** — `npx vite build` is the frontend's source of truth (bleeding-edge TS/Vite/React versions). Backend `npm run typecheck` is fine.
- **Don't hand-edit route stop lists or path polylines.** They come from TransLoc upstream.
- **Don't commit unless the user asks.** The host handles source control. (`services/shuttle-v2/` has been git-tracked since June 2026 — history exists now.)
- `services/shuttle-collector/` and `services/shuttle-map/` are the archived v1 stack — don't modify or deploy them.

## Useful probes

```bash
# NOTE: jq is NOT installed on this Pi — parse with node instead.
curl -s https://yale-shuttle.fly.dev/api/buses | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).buses[0]))"
~/.fly/bin/flyctl ssh console -a yale-shuttle -C "ls -la /data"

# Read the production DB read-only (flyctl mangles quotes; pipe a file to stdin):
printf '<js>' | ~/.fly/bin/flyctl ssh console -a yale-shuttle -C "node -"
#   require("/app/node_modules/better-sqlite3") on "/data/shuttle-v2.db", {readonly:true}
```

Visual checks of the live site DO work on this Pi via Playwright driving system chromium over CDP (only the legacy `chromium --screenshot` one-shot CLI hangs). Recipe: `npm i playwright-core`, launch with `executablePath: "/usr/bin/chromium"` + `--no-sandbox --disable-gpu --disable-dev-shm-usage`, `goto(url, {waitUntil: "domcontentloaded"})`. Working end-to-end example: `services/shuttle-v2/scripts/map-bot-visual.mjs` (run with `BOT_CHROMIUM_PATH=/usr/bin/chromium`) — picks a random trip, sets geolocation as the origin, screenshots the plan + the Leaflet map with bus markers, and watches a bus approach. The companion `scripts/map-bot.mjs` is a headless data-level check (random trip → `/api/plan` ground truth). For a pure JS-crash repro without any browser, the jsdom harness still works — see the memory note on environment quirks.
