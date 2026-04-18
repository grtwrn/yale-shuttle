#!/usr/bin/env bash
set -euo pipefail

mkdir -p "${SHUTTLE_DB_DIR:-/data}"

cd /app

# Start the collector in the background. node_modules are baked into the
# image by the builder stage, so no network install at runtime.
./services/shuttle-collector/node_modules/.bin/tsx \
    services/shuttle-collector/index.ts &
COLLECTOR_PID=$!

trap 'kill "$COLLECTOR_PID" 2>/dev/null; wait "$COLLECTOR_PID" 2>/dev/null; exit 0' TERM INT

# The web server is the foreground process — health-checks hit it.
python3 services/shuttle-map/server.py --once
