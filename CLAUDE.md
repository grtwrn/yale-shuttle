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
- **`web/`** — Vite/React SPA served as static files from `web/dist`. `web/src/TransitMap.tsx` (~6300 lines) is the entire user-facing app. It began as a copy of v1's frontend but has **drifted substantially — don't assume it matches `services/shuttle-map/app/`**.

The frontend computes ETAs client-side from the `/api/buses` payload (positions + calibrated segments/dwells); it does not use the native v2 endpoints.

## Common commands

```bash
cd services/shuttle-v2

npm run dev          # backend on :8092 (collector + server, tsx watch)
npm run typecheck    # backend types (tsc --noEmit) — frontend types are NOT covered by this
npm test             # vitest

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
- **TZ=America/New_York** in the Dockerfile — collector writes day/hour columns in ET. Don't change without auditing the calibration queries.

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

## Don'ts

- **Don't deploy from the repo root.** The only live config is `services/shuttle-v2/fly.toml` (app `yale-shuttle`). `fly.v1-archived.toml` at the root is the retired v1 config — leave it dead.
- **Don't touch `/data/shuttle.db`** on the volume — that's v1's archived history.
- **Don't run standalone `tsc` against `web/`** — `npx vite build` is the frontend's source of truth (bleeding-edge TS/Vite/React versions). Backend `npm run typecheck` is fine.
- **Don't hand-edit route stop lists or path polylines.** They come from TransLoc upstream.
- **Don't commit unless the user asks.** The host handles source control. (`services/shuttle-v2/` has been git-tracked since June 2026 — history exists now.)
- `services/shuttle-collector/` and `services/shuttle-map/` are the archived v1 stack — don't modify or deploy them.

## Useful probes

```bash
curl -s https://yale-shuttle.fly.dev/api/buses | jq '.buses[0]'
~/.fly/bin/flyctl ssh console -a yale-shuttle -C "ls -la /data"
```

Visual checks of the live site DO work on this Pi via Playwright driving system chromium over CDP (only the legacy `chromium --screenshot` one-shot CLI hangs). Recipe: `npm i playwright-core`, launch with `executablePath: "/usr/bin/chromium"` + `--no-sandbox --disable-gpu --disable-dev-shm-usage`, `goto(url, {waitUntil: "domcontentloaded"})`. Working end-to-end example: `services/shuttle-v2/scripts/map-bot-visual.mjs` (run with `BOT_CHROMIUM_PATH=/usr/bin/chromium`) — picks a random trip, sets geolocation as the origin, screenshots the plan + the Leaflet map with bus markers, and watches a bus approach. The companion `scripts/map-bot.mjs` is a headless data-level check (random trip → `/api/plan` ground truth). For a pure JS-crash repro without any browser, the jsdom harness still works — see the memory note on environment quirks.
