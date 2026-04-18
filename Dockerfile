# ---- Frontend build ----
FROM node:20-slim AS frontend
WORKDIR /app
COPY services/shuttle-map/app/package*.json ./
RUN npm ci
COPY services/shuttle-map/app/ ./
RUN npx vite build

# ---- Collector build (better-sqlite3 needs a C toolchain) ----
FROM node:20-slim AS collector
RUN apt-get update && apt-get install -y --no-install-recommends \
        python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app/services/shuttle-collector
COPY services/shuttle-collector/package*.json ./
RUN npm install --omit=dev
COPY services/shuttle-collector/ ./

# ---- Runtime (Python + Node) ----
FROM python:3.12-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
        curl ca-certificates gnupg \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Python deps
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# App sources
COPY services/ ./services/
COPY --from=frontend /app/dist ./services/shuttle-map/app/dist
COPY --from=collector /app/services/shuttle-collector/node_modules ./services/shuttle-collector/node_modules

# SQLite lives on a mounted volume in production (Fly.io mount at /data)
ENV SHUTTLE_DB=/data/shuttle.db
ENV SHUTTLE_STATIC_DIR=/app/services/shuttle-map/app/dist
ENV PORT=8080
ENV SHUTTLE_DB_DIR=/data
EXPOSE 8080

COPY start.sh ./start.sh
RUN chmod +x ./start.sh

CMD ["./start.sh"]
