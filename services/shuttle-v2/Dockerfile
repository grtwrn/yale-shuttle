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

WORKDIR /app
COPY --from=backend /app /app
COPY --from=web /app/web/dist /app/web/dist

EXPOSE 8080

# Migrations run inside main() on startup, so this is a single command.
CMD ["./node_modules/.bin/tsx", "src/index.ts"]
