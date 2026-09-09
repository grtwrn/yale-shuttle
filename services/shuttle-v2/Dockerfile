# Build context: services/shuttle-v2/ (i.e. `flyctl deploy` invoked from here).

# ---- Frontend build ---------------------------------------------------------
FROM node:20-slim AS web
WORKDIR /app
# Vite aliases `@shuttle/schema` to ../src/schema/api.ts, which imports zod.
# Node module resolution walks UP from the importing file's location, so it
# needs to find a node_modules at /app — not just inside /app/web. Install
# zod at /app so the shared schema resolves at bundle time. (web/node_modules
# also has zod, but the resolver doesn't reach across to it.)
RUN npm init -y > /dev/null && npm install zod@^3.23.0 > /dev/null
COPY src/schema /app/src/schema
# One more shared module: `web/src/eta/ring.ts` imports the stop-order repair
# (the ring and the server's own network must agree on the order, and only
# `src/` reaches the runtime image — see src/network/alignStops.ts). It is pure
# geometry with no imports of its own, so the file alone is enough.
COPY src/network/alignStops.ts /app/src/network/alignStops.ts
COPY web/ /app/web/
WORKDIR /app/web
RUN npm ci
RUN npx vite build

# ---- Backend build (better-sqlite3 native module) --------------------------
FROM node:20-slim AS backend
RUN apt-get update && apt-get install -y --no-install-recommends \
        python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY src/ ./src/
COPY drizzle/ ./drizzle/
COPY drizzle.config.ts tsconfig.json ./
# The ring estimator, imported by the server rather than reimplemented
# (src/server/serverEta.ts). These files live under web/ only because the
# frontend was a fork of v1's and the estimator was extracted out of it; they
# import nothing browser-only, and running the SAME module on both sides is
# the whole point of the server-side belief. Only web/dist reaches the runtime
# image otherwise, so the sources have to be copied explicitly.
#
# The list is the import closure of `src/server/serverEta.ts`, and
# `serverEta.closure.test.ts` recomputes it and fails if this COPY has fallen
# behind — an import added here and forgotten here would pass every gate and
# then crash the production process on boot.
COPY web/src/anchor.ts web/src/arrivals.ts web/src/geo.ts web/src/liveAnchor.ts \
     web/src/map-data.ts web/src/routes.ts ./web/src/
COPY web/src/eta/arrival.ts web/src/eta/dist.ts web/src/eta/filter.ts \
     web/src/eta/index.ts web/src/eta/params.ts web/src/eta/ring.ts \
     web/src/eta/tables.ts ./web/src/eta/

# ---- Runtime ---------------------------------------------------------------
FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends tzdata curl \
    && ln -fs /usr/share/zoneinfo/America/New_York /etc/localtime \
    && dpkg-reconfigure -f noninteractive tzdata \
    && rm -rf /var/lib/apt/lists/*

ENV TZ=America/New_York
ENV NODE_ENV=production
ENV PORT=8080
ENV SHUTTLE_V2_DB=/data/shuttle-v2.db
ENV SHUTTLE_V2_DB_DIR=/data
ENV SHUTTLE_V2_STATIC_DIR=/app/web/dist
# The commit this image was built from. scripts/deploy.mjs passes it as a
# build arg (git rev-parse HEAD); /healthz reports it and the scorecard
# versions its rows by it (docs/closed-loop.md). "dev" when built by hand.
ARG SHUTTLE_BUILD_SHA=dev
ENV SHUTTLE_BUILD_SHA=$SHUTTLE_BUILD_SHA

WORKDIR /app
COPY --from=backend /app /app
COPY --from=web /app/web/dist /app/web/dist

EXPOSE 8080

# Migrations run inside main() on startup, so this is a single command.
CMD ["./node_modules/.bin/tsx", "src/index.ts"]
