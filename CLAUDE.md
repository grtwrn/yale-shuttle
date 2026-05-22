# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Live web app at **https://yale-shuttle.fly.dev** showing Yale Downtowner shuttle positions, stop-level ETAs, trip planning, and prediction-accuracy stats. Deployed as a single Fly.io machine in `ewr` with a 1 GB persistent volume mounted at `/data`.

## Architecture

Three things run together in the production container, all reading/writing the same SQLite file at `/data/shuttle.db` (locally: `store/shuttle.db`):

1. **`services/shuttle-collector/index.ts`** — Node/tsx daemon. Polls `https://yale.downtownerapp.com` every 5 s and writes `bus_positions`, `gps_arrivals`, `predictions`, `segment_times`, `dwell_*`, etc. Every 5 min it rebuilds `calibrated_segments*`, `calibrated_dwells*`, and `vehicle_profiles`; every 6 h it refreshes `routes`/`stops` from upstream; hourly retention sweep trims raw tables. **Server reads what the collector writes** — they communicate only through SQLite.
2. **`services/shuttle-map/server.py`** — FastAPI + uvicorn (port 8080 prod, 8091 dev). Endpoints: `/api/buses`, `/api/accuracy`, `/api/geocode`, `/api/report`, `/api/reports`, `/api/debug/predictions`, `/healthz`. Opens SQLite read-only (`mode=ro`). Holds in-memory TTL caches (`_RESPONSE_CACHE`, `_ROUTE_STATIC_CACHE`) — the route/stop cache exists because re-parsing the polyline JSON on every tick was OOM-killing the 1 GB container.
3. **Vite/React SPA** — built to `services/shuttle-map/app/dist/` and served as static files by the same FastAPI app. `main.tsx` mounts either `TransitMap.tsx` (default, ~6400 lines, the entire user-facing app) or `MinimapReview.tsx` (when `?review=minimap`).

In dev, Vite runs separately on 8090 with `/api` proxied to the Python server on 8091.

## Common commands

```bash
# one-time
cd services/shuttle-map/app && npm install

# collector (keeps SQLite fresh; uses ./store/shuttle.db)
npx tsx services/shuttle-collector/index.ts

# FastAPI server (port 8091)
python3 services/shuttle-map/server.py --once   # --once skips xdg-open

# Vite dev server (port 8090, proxies /api → :8091)
cd services/shuttle-map/app && npx vite
```

Then open http://localhost:8090.

### Build & deploy

```bash
# Build the SPA (this is also the type check — see "Don'ts" below)
cd services/shuttle-map/app && npx vite build

# Validate server.py syntax
python3 -c "import ast; ast.parse(open('services/shuttle-map/server.py').read())"

# Deploy (remote build; container doesn't need Docker locally)
flyctl deploy --remote-only

# Health
curl -s -o /dev/null -w "HTTP %{http_code}\n" https://yale-shuttle.fly.dev/healthz
flyctl logs -a yale-shuttle --no-tail | tail -50
```

The `Dockerfile` is a three-stage build (frontend → collector deps with native `better-sqlite3` toolchain → Python+Node runtime). `start.sh` launches the collector in the background and the FastAPI server in the foreground.

## Conventions to preserve

These came from past bugs/feedback — don't re-litigate them:

- **Minutes** are spelled `min` in UI strings, never `m` (avoids mile confusion).
- **Origin / destination emoji**: 📍 / 🏁 (checkered flag), never 🎯.
- **Inputs must be ≥ 16 px font-size** to avoid iOS zoom-on-focus. Touch targets ≥ 44×44.
- **Accuracy subtitle format**: `usual miss ±Xs · worst case ±Y min (95%)`. Suppressed when p95 > 20 min.
- **Distance buckets** for `(pickup, stops_ahead)` accuracy: `1…10, 10+`. These live in **both** `server.py` `_dist_bucket()` and `TransitMap.tsx` `distanceBucket()` — keep in sync.
- **Geocoder**: Mapbox is primary (`MAPBOX_TOKEN` env var; no-ops when unset), Nominatim + Photon are fallbacks. Shuttle stops and a curated Yale landmark list are merged and ranked alongside external results in `geocode()`.
- **TZ=America/New_York** is set in the Dockerfile — collector writes `dow`/`hour` columns in ET. Don't change without auditing the calibration queries.

## Bug reports

Users submit reports via the in-app "🚩 Report issue" (per-route) or "💬 Send feedback" (general). They land in the `debug_reports` table (rate-limited 10/min, 200/day per IP). Workflow:

- `GET /api/reports?status=open` — triage queue
- `POST /api/reports/{id}/update` with `{"status": "addressed", "note": "..."}` — annotate when fixed

**Always annotate after a fix.** The resolution field is the triage log; append, don't replace. Next agent should not re-investigate cold.

## Don'ts

- **Don't run `tsc` standalone** — `npx vite build` is the source of truth for type checking. The TypeScript and Vite versions in `app/package.json` are bleeding-edge (TS 6, Vite 8, React 19); standalone `tsc` may disagree.
- **Don't touch `services/shuttle-collector/` unless the bug is in data collection.** Restarting the collector means downtime for ongoing trips.
- **Don't hand-edit route stop lists or path polylines.** They come from TransLoc and are refreshed every 6 h into the `routes`/`stops` tables.
- **Don't commit unless the user asks.** The host handles source control.
- Files in `services/shuttle-map/` like `index.html`, `transit-map.py`, `map.mjs`, `transit.mjs` are pre-SPA scratch/legacy; the production frontend is entirely under `services/shuttle-map/app/`.

## Useful probes

```bash
curl -s https://yale-shuttle.fly.dev/api/buses | jq '.buses[0]'
flyctl ssh console -a yale-shuttle -C "sqlite3 /data/shuttle.db '.tables'"
```
