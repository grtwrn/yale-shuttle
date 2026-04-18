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

## Deploy

Any host that can run Python + a Node daemon with persistent storage
works. Fly.io, Hetzner, and a Raspberry Pi all do. The collector must
stay running — it's the only thing writing to the database.

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
