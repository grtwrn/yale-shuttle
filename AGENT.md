# Yale Shuttle Tracker — agent context

Read this first when a subagent is dispatched to work on the shuttle tracker. Everything below is ground truth; don't re-derive it from git history.

## What this is

A live web app at **https://yale-shuttle.fly.dev** that shows Yale shuttle arrivals, plans trips, and tracks prediction accuracy. Deployed to Fly.io as a single machine with a 1 GB persistent volume at `/data`.

Three processes run in the same container:
- **`services/shuttle-map/server.py`** — FastAPI + uvicorn. Serves `/api/buses`, `/api/accuracy`, `/api/geocode`, `/api/report`, `/api/reports`, `/healthz`. Reads SQLite at `/data/shuttle.db`.
- **`services/shuttle-collector/index.ts`** — Node.js polling daemon. Fetches TransLoc every 5 s and writes `bus_positions`, `segment_times`, `gps_arrivals`, `predictions`, etc. Keeps the DB warm for the server.
- **Vite-built frontend** — `services/shuttle-map/app/src/TransitMap.tsx` is the single main component (~5000 lines). Built to `services/shuttle-map/app/dist/` and served as static files by the FastAPI app.

## Where you are in the filesystem

Inside the main NanoClaw container you're mounted at `/workspace/extra/yale-shuttle` (read-write). `flyctl` lives at `/workspace/extra/.fly/bin/flyctl` — that's the host's Fly CLI, mounted so you can deploy.

## The workflow

For any change:

1. **Read relevant files first.** `services/shuttle-map/app/src/TransitMap.tsx` is the giant one; `services/shuttle-map/server.py` handles the backend.
2. **Make the change** via the usual Edit / Write tools.
3. **Build the frontend** if you touched anything under `services/shuttle-map/app/`:
   ```
   cd /workspace/extra/yale-shuttle/services/shuttle-map/app && npx vite build
   ```
4. **Validate** Python syntax if you touched the server:
   ```
   python3 -c "import ast; ast.parse(open('/workspace/extra/yale-shuttle/services/shuttle-map/server.py').read())"
   ```
5. **Deploy**:
   ```
   cd /workspace/extra/yale-shuttle && /workspace/extra/.fly/bin/flyctl deploy --remote-only
   ```
   Remote build means Fly's builder handles Docker; the container doesn't need Docker itself.
6. **Verify health** after deploy:
   ```
   curl -s -o /dev/null -w "HTTP %{http_code}\n" https://yale-shuttle.fly.dev/healthz
   ```

## Key conventions (don't re-learn these)

- **Minutes** are spelled `min` in UI strings, never `m` (avoids mile confusion).
- **Destination emoji** is 🏁 (checkered flag), not 🎯. Origin uses 📍.
- **Input font-size ≥ 16 px** to avoid iOS zoom-on-focus.
- **Touch targets ≥ 44×44** for iOS / Material guidelines.
- **Accuracy subtitle**: `usual miss ±Xs · worst case ±Y min (95%)`. Suppressed when p95 > 20 min.
- **Distance buckets** for `(pickup, stops_ahead)` accuracy: `1…10, 10+`. Mirrored in `server.py` `_dist_bucket()` and `TransitMap.tsx` `distanceBucket()` — keep in sync.
- **Mapbox** is the primary geocoder (`MAPBOX_TOKEN` env). Nominatim + Photon are fallbacks. Shuttle stops + curated Yale landmarks run alongside and get merged/ranked by the unified scorer in `geocode()`.
- **TZ=America/New_York** is set in `Dockerfile` — collector writes `dow`/`hour` columns in ET.

## Bug reports

Users submit reports via the "🚩 Report issue" button (per-route) or "💬 Send feedback" (general). They land in `debug_reports` table. Workflow:

- `GET /api/reports?status=open` — triage queue (never look at anything else first)
- `POST /api/reports/{id}/update` — annotate with `{"status": "addressed", "note": "..."}`
- Rate-limited: 10/min, 200/day per IP

**Always annotate a report after fixing it** so the next agent doesn't re-investigate the same bug cold. The resolution field is the triage log — append, don't replace.

## Things to avoid

- Don't run `tsc` standalone — vite build is the source of truth for type checking.
- Don't touch `services/shuttle-collector/` unless the bug is in data collection. Restarting the collector means downtime for ongoing trips.
- Don't edit the Brown/Red/etc. route stop lists manually — they come from TransLoc and are refreshed every 6h by the collector.
- Don't commit — the host git is fine for source control; the subagent doesn't need to.

## If you're stuck

- `curl https://yale-shuttle.fly.dev/api/buses | jq '.buses[0]'` — see what live data looks like.
- `flyctl logs -a yale-shuttle --no-tail | tail -50` — recent container logs.
- `flyctl ssh console -a yale-shuttle -C "python3 -c '...'"` — run a Python probe against the live DB.
