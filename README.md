# Yale Shuttle Tracker

Live map + stop-level ETAs for the Yale Downtowner shuttles. Ingests the
public Yale Downtowner API every few seconds and renders an HK-MTR-style
schematic with accurate routes, live bus positions, dwell timers, and
trip-planning between any two locations.

## Structure

```
services/
  shuttle-collector/   Node daemon that polls the Downtowner API and
                       writes bus_positions, gps_arrivals, predictions
                       to SQLite at store/shuttle.db.
  shuttle-map/         Python web server (server.py) exposing
                       /api/buses, /api/accuracy, /api/geocode plus a
                       Vite/React schematic map under app/.
```

## Local development

```bash
# one-time
cd services/shuttle-map/app && npm install

# start the collector (keeps shuttle.db fresh)
npx tsx services/shuttle-collector/index.ts

# in another terminal: Python API server (port 8091)
python3 services/shuttle-map/server.py

# in another terminal: Vite dev server with /api proxy (port 8090)
cd services/shuttle-map/app && npx vite
```

Then open http://localhost:8090.

## Deploy (Fly.io)

One-shot deploy — spins up a single machine running both the collector
and the server, with a persistent SQLite volume.

```bash
# one-time: install flyctl and log in
curl -L https://fly.io/install.sh | sh
flyctl auth login

# one-time: create the app + volume (from repo root)
flyctl launch --no-deploy --copy-config --name yale-shuttle --region bos
flyctl volumes create shuttle_data --region bos --size 1

# deploy
flyctl deploy
```

The `Dockerfile` builds the Vite frontend, installs Python + Node
runtimes, pre-builds the collector's native `better-sqlite3` module,
and `start.sh` launches the collector in the background with the
FastAPI server in the foreground. Health checks hit `/healthz`.

## Deploy (anywhere else)

Any Linux host with Python 3.12 + Node 20 works. Run the collector
under systemd so SQLite stays fresh, then run the server behind your
reverse proxy of choice. The Pi-systemd unit at
`services/shuttle-collector/shuttle-collector.service` is a starting
point.

## Data

SQLite (`store/shuttle.db`). Schema is created on first run:
- `bus_positions` — raw vehicle polls
- `gps_arrivals` — derived stop arrivals from GPS
- `predictions` — historical TransLoc ETAs (for accuracy scoring)
- `segments` / `dwells` — rolling aggregates used by the client

## Geocoding

`/api/geocode?q=...` proxies Nominatim + Photon with an in-memory cache
and a curated list of Yale landmarks (Rosenkranz, SOM, YSPH, etc.) that
handles typos and abbreviations.
