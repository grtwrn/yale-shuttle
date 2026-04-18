/**
 * Yale Shuttle Collector Daemon
 *
 * Polls the Downtowner API every 30s, logs bus positions to SQLite,
 * and builds vehicle speed/dwell profiles over time.
 *
 * Runs as a systemd service — zero AI tokens.
 *
 * Usage:
 *   npx tsx services/shuttle-collector/index.ts
 */

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const BASE_URL = 'https://yale.downtownerapp.com';
const POLL_INTERVAL_MS = 5_000; // 5 seconds — matches upstream API update cadence
const DB_DIR = path.resolve(
  process.env.SHUTTLE_DB_DIR || path.join(process.cwd(), 'store'),
);
const DB_PATH = path.join(DB_DIR, 'shuttle.db');

// Garrett's stops near Canner & Prospect
const DEFAULT_STOPS = [3, 4, 106, 107, 164];

// Route IDs for Red and Blue lines (day + night variants)
const WATCHED_ROUTES = [1, 3, 4, 13, 16];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Bus {
  id: number;
  name: string;
  lat: number;
  lon: number;
  heading: number;
  route: number;
  lastStop: number;
  lastUpdate: number;
}

interface EtaEntry {
  avg: number;
  bus_id: number;
  bus_name: string;
  route: number;
}

interface RouteInfo {
  id: number;
  name: string;
  short_name: string;
  description: string;
  color: string;
  stops: number[];
}

interface StopInfo {
  id: number;
  name: string;
  lat: number;
  lon: number;
}

// ---------------------------------------------------------------------------
// Database setup
// ---------------------------------------------------------------------------

function initDb(): Database.Database {
  fs.mkdirSync(DB_DIR, { recursive: true });
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');

  db.exec(`
    -- Raw bus position snapshots
    CREATE TABLE IF NOT EXISTS bus_positions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bus_id INTEGER NOT NULL,
      bus_name TEXT NOT NULL,
      route_id INTEGER NOT NULL,
      lat REAL NOT NULL,
      lon REAL NOT NULL,
      heading INTEGER NOT NULL,
      last_stop_id INTEGER,
      api_timestamp INTEGER NOT NULL,
      collected_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_bp_bus ON bus_positions(bus_id, collected_at);
    CREATE INDEX IF NOT EXISTS idx_bp_route ON bus_positions(route_id, collected_at);

    -- Stop arrival events (derived from consecutive position polls)
    CREATE TABLE IF NOT EXISTS stop_arrivals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bus_id INTEGER NOT NULL,
      bus_name TEXT NOT NULL,
      route_id INTEGER NOT NULL,
      stop_id INTEGER NOT NULL,
      arrived_at TEXT NOT NULL,
      departed_at TEXT,
      dwell_seconds REAL
    );
    CREATE INDEX IF NOT EXISTS idx_sa_stop ON stop_arrivals(stop_id, arrived_at);
    CREATE INDEX IF NOT EXISTS idx_sa_bus ON stop_arrivals(bus_id, arrived_at);

    -- Segment travel times (stop A -> stop B) with day/hour for calibration
    CREATE TABLE IF NOT EXISTS segment_times (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bus_id INTEGER NOT NULL,
      bus_name TEXT NOT NULL,
      route_id INTEGER NOT NULL,
      from_stop_id INTEGER NOT NULL,
      to_stop_id INTEGER NOT NULL,
      travel_seconds REAL NOT NULL,
      hops INTEGER NOT NULL DEFAULT 1,
      day_of_week INTEGER NOT NULL DEFAULT 0,
      hour INTEGER NOT NULL DEFAULT 0,
      recorded_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_seg_route ON segment_times(route_id, from_stop_id, to_stop_id);
    -- idx_seg_cal created after migration below

    -- Calibrated segment averages (aggregated periodically)
    CREATE TABLE IF NOT EXISTS calibrated_segments (
      route_id INTEGER NOT NULL,
      from_stop_id INTEGER NOT NULL,
      to_stop_id INTEGER NOT NULL,
      day_of_week INTEGER NOT NULL,
      avg_seconds REAL NOT NULL,
      stddev_seconds REAL NOT NULL DEFAULT 0,
      sample_count INTEGER NOT NULL DEFAULT 0,
      last_updated TEXT NOT NULL,
      PRIMARY KEY (route_id, from_stop_id, to_stop_id, day_of_week)
    );

    -- Overall segment averages (all days combined, for fallback)
    CREATE TABLE IF NOT EXISTS segment_averages (
      route_id INTEGER NOT NULL,
      from_stop_id INTEGER NOT NULL,
      to_stop_id INTEGER NOT NULL,
      avg_seconds REAL NOT NULL,
      stddev_seconds REAL NOT NULL DEFAULT 0,
      sample_count INTEGER NOT NULL DEFAULT 0,
      last_updated TEXT NOT NULL,
      PRIMARY KEY (route_id, from_stop_id, to_stop_id)
    );

    -- Calibrated per-stop dwell times (timing-point pauses).
    -- Filter: only dwells >= 30s (shorter = drive-through, not a real stop).
    CREATE TABLE IF NOT EXISTS calibrated_dwells (
      route_id INTEGER NOT NULL,
      stop_id INTEGER NOT NULL,
      day_of_week INTEGER NOT NULL,
      median_dwell_seconds REAL NOT NULL,
      stddev_dwell_seconds REAL NOT NULL DEFAULT 0,
      sample_count INTEGER NOT NULL DEFAULT 0,
      last_updated TEXT NOT NULL,
      PRIMARY KEY (route_id, stop_id, day_of_week)
    );
    CREATE TABLE IF NOT EXISTS dwell_averages (
      route_id INTEGER NOT NULL,
      stop_id INTEGER NOT NULL,
      median_dwell_seconds REAL NOT NULL,
      stddev_dwell_seconds REAL NOT NULL DEFAULT 0,
      sample_count INTEGER NOT NULL DEFAULT 0,
      last_updated TEXT NOT NULL,
      PRIMARY KEY (route_id, stop_id)
    );

    -- Predicted arrivals: logged every time a bus transitions to a new GPS-nearest stop.
    -- One row per (bus, downstream stop) snapshot for accuracy tracking.
    CREATE TABLE IF NOT EXISTS predictions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bus_id INTEGER NOT NULL,
      bus_name TEXT NOT NULL,
      route_id INTEGER NOT NULL,
      from_stop_id INTEGER NOT NULL,
      to_stop_id INTEGER NOT NULL,
      predicted_eta_sec REAL NOT NULL,
      predicted_low_sec REAL NOT NULL,
      predicted_high_sec REAL NOT NULL,
      predicted_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_pred_stop ON predictions(to_stop_id, predicted_at);
    CREATE INDEX IF NOT EXISTS idx_pred_bus ON predictions(bus_id, to_stop_id, predicted_at);

    -- GPS-derived dwell times (bus stayed as nearest to this stop for N seconds).
    -- More accurate than stop_arrivals.dwell because it uses our GPS snap, not the API's lastStop.
    CREATE TABLE IF NOT EXISTS gps_dwells (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bus_id INTEGER NOT NULL,
      bus_name TEXT NOT NULL,
      route_id INTEGER NOT NULL,
      stop_id INTEGER NOT NULL,
      dwell_seconds REAL NOT NULL,
      entered_at TEXT NOT NULL,
      left_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_gps_dwell_stop ON gps_dwells(stop_id, entered_at);

    -- GPS-detected arrivals (bus became nearest to this stop). Used to evaluate predictions.
    CREATE TABLE IF NOT EXISTS gps_arrivals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bus_id INTEGER NOT NULL,
      bus_name TEXT NOT NULL,
      route_id INTEGER NOT NULL,
      stop_id INTEGER NOT NULL,
      arrived_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_gps_arr_stop ON gps_arrivals(stop_id, arrived_at);
    CREATE INDEX IF NOT EXISTS idx_gps_arr_bus ON gps_arrivals(bus_id, arrived_at);

    -- Vehicle profiles (aggregated stats, updated periodically)
    CREATE TABLE IF NOT EXISTS vehicle_profiles (
      bus_name TEXT NOT NULL,
      route_id INTEGER NOT NULL,
      avg_speed_kmh REAL,
      avg_dwell_seconds REAL,
      avg_loop_minutes REAL,
      sample_count INTEGER DEFAULT 0,
      last_updated TEXT NOT NULL,
      PRIMARY KEY (bus_name, route_id)
    );

    -- Static reference data (refreshed daily)
    CREATE TABLE IF NOT EXISTS routes (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      short_name TEXT,
      description TEXT,
      color TEXT,
      stops_json TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS stops (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      lat REAL NOT NULL,
      lon REAL NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Official ETA snapshots (for comparing with our predictions)
    CREATE TABLE IF NOT EXISTS eta_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      stop_id INTEGER NOT NULL,
      bus_id INTEGER NOT NULL,
      bus_name TEXT NOT NULL,
      route_id INTEGER NOT NULL,
      eta_seconds INTEGER NOT NULL,
      collected_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_eta_stop ON eta_snapshots(stop_id, collected_at);
  `);

  // Migrations: add columns to existing tables if missing
  const cols = db.prepare("PRAGMA table_info(segment_times)").all() as Array<{ name: string }>;
  const colNames = new Set(cols.map((c) => c.name));
  if (!colNames.has('hops')) db.exec("ALTER TABLE segment_times ADD COLUMN hops INTEGER NOT NULL DEFAULT 1");
  if (!colNames.has('day_of_week')) db.exec("ALTER TABLE segment_times ADD COLUMN day_of_week INTEGER NOT NULL DEFAULT 0");
  if (!colNames.has('hour')) db.exec("ALTER TABLE segment_times ADD COLUMN hour INTEGER NOT NULL DEFAULT 0");
  db.exec("CREATE INDEX IF NOT EXISTS idx_seg_cal ON segment_times(route_id, day_of_week, hour)");

  const calCols = db.prepare("PRAGMA table_info(calibrated_segments)").all() as Array<{ name: string }>;
  if (!new Set(calCols.map((c) => c.name)).has('stddev_seconds')) {
    db.exec("ALTER TABLE calibrated_segments ADD COLUMN stddev_seconds REAL NOT NULL DEFAULT 0");
  }
  const avgCols = db.prepare("PRAGMA table_info(segment_averages)").all() as Array<{ name: string }>;
  if (!new Set(avgCols.map((c) => c.name)).has('stddev_seconds')) {
    db.exec("ALTER TABLE segment_averages ADD COLUMN stddev_seconds REAL NOT NULL DEFAULT 0");
  }

  return db;
}

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

async function fetchJson<T>(endpoint: string, params?: Record<string, string>): Promise<T | null> {
  try {
    const url = new URL(endpoint, BASE_URL);
    if (params) {
      for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    }
    const res = await fetch(url.toString(), {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      console.error(`API ${res.status}: ${endpoint}`);
      return null;
    }
    return (await res.json()) as T;
  } catch (err) {
    console.error(`API error (${endpoint}):`, (err as Error).message);
    return null;
  }
}

async function fetchBuses(): Promise<Bus[]> {
  return (await fetchJson<Bus[]>('/routes_buses.php')) ?? [];
}

async function fetchEtas(stopId: number): Promise<EtaEntry[]> {
  const data = await fetchJson<{ etas: Record<string, { etas: EtaEntry[] }> }>(
    '/routes_eta.php',
    { stop: String(stopId) },
  );
  if (!data?.etas?.[String(stopId)]?.etas) return [];
  return data.etas[String(stopId)].etas;
}

async function fetchRoutes(): Promise<RouteInfo[]> {
  return (await fetchJson<RouteInfo[]>('/routes_routes.php', { inactive: 'true' })) ?? [];
}

async function fetchStops(): Promise<StopInfo[]> {
  return (await fetchJson<StopInfo[]>('/routes_stops.php')) ?? [];
}

// ---------------------------------------------------------------------------
// Collector logic
// ---------------------------------------------------------------------------

// Track last known stop per bus to detect stop transitions
const lastKnownStop = new Map<number, { stopId: number; timestamp: string }>();

// Track GPS-nearest stop per bus (separate from API lastStop) for accuracy tracking + dwell
const lastGpsStop = new Map<number, { stop: number; enteredAt: string }>();

// Cache route stop lists for consecutive-stop validation
const routeStopLists = new Map<number, number[]>();

// Cache stop coordinates for GPS-nearest lookup
const stopCoords = new Map<number, { lat: number; lon: number }>();

// Cache calibrated segment times per route for prediction logging
// { routeId → { "fromStop-toStop" → { avg, stddev } } }
const segmentCache = new Map<number, Map<string, { avg: number; stddev: number }>>();

// Cache calibrated dwell times per (route, stop). { routeId → { stopId → { median, stddev } } }
const dwellCache = new Map<number, Map<number, { median: number; stddev: number }>>();

function loadStopCoords(db: Database.Database): void {
  const rows = db.prepare('SELECT id, lat, lon FROM stops').all() as Array<{ id: number; lat: number; lon: number }>;
  stopCoords.clear();
  for (const r of rows) stopCoords.set(r.id, { lat: r.lat, lon: r.lon });
}

function loadSegmentCache(db: Database.Database): void {
  segmentCache.clear();
  dwellCache.clear();
  const dow = new Date().getDay();
  const calRows = db.prepare(`
    SELECT route_id, from_stop_id, to_stop_id, avg_seconds, stddev_seconds
    FROM calibrated_segments WHERE day_of_week = ?
  `).all(dow) as Array<{ route_id: number; from_stop_id: number; to_stop_id: number; avg_seconds: number; stddev_seconds: number }>;
  const avgRows = db.prepare(`
    SELECT route_id, from_stop_id, to_stop_id, avg_seconds, stddev_seconds
    FROM segment_averages
  `).all() as Array<{ route_id: number; from_stop_id: number; to_stop_id: number; avg_seconds: number; stddev_seconds: number }>;

  for (const r of avgRows) {
    if (!segmentCache.has(r.route_id)) segmentCache.set(r.route_id, new Map());
    segmentCache.get(r.route_id)!.set(`${r.from_stop_id}-${r.to_stop_id}`, { avg: r.avg_seconds, stddev: r.stddev_seconds });
  }
  for (const r of calRows) {
    if (!segmentCache.has(r.route_id)) segmentCache.set(r.route_id, new Map());
    segmentCache.get(r.route_id)!.set(`${r.from_stop_id}-${r.to_stop_id}`, { avg: r.avg_seconds, stddev: r.stddev_seconds });
  }

  // Dwell cache — all-days fallback then day-specific override
  const dwellAvgRows = db.prepare(`
    SELECT route_id, stop_id, median_dwell_seconds, stddev_dwell_seconds
    FROM dwell_averages
  `).all() as Array<{ route_id: number; stop_id: number; median_dwell_seconds: number; stddev_dwell_seconds: number }>;
  const dwellCalRows = db.prepare(`
    SELECT route_id, stop_id, median_dwell_seconds, stddev_dwell_seconds
    FROM calibrated_dwells WHERE day_of_week = ?
  `).all(dow) as Array<{ route_id: number; stop_id: number; median_dwell_seconds: number; stddev_dwell_seconds: number }>;
  for (const r of dwellAvgRows) {
    if (!dwellCache.has(r.route_id)) dwellCache.set(r.route_id, new Map());
    dwellCache.get(r.route_id)!.set(r.stop_id, { median: r.median_dwell_seconds, stddev: r.stddev_dwell_seconds });
  }
  for (const r of dwellCalRows) {
    if (!dwellCache.has(r.route_id)) dwellCache.set(r.route_id, new Map());
    dwellCache.get(r.route_id)!.set(r.stop_id, { median: r.median_dwell_seconds, stddev: r.stddev_dwell_seconds });
  }
}

/** Find the nearest stop on a bus's route given GPS position. Returns stop_id or null. */
function nearestStopOnRoute(routeId: number, lat: number, lon: number): number | null {
  const stops = routeStopLists.get(routeId);
  if (!stops) return null;
  let bestStop: number | null = null;
  let bestD2 = Infinity;
  for (const sid of stops) {
    const sc = stopCoords.get(sid);
    if (!sc) continue;
    const dLat = lat - sc.lat;
    const dLon = lon - sc.lon;
    const d2 = dLat * dLat + dLon * dLon;
    if (d2 < bestD2) { bestD2 = d2; bestStop = sid; }
  }
  return bestStop;
}

function loadRouteStopLists(db: Database.Database): void {
  const rows = db.prepare('SELECT id, stops_json FROM routes WHERE stops_json IS NOT NULL').all() as Array<{ id: number; stops_json: string }>;
  for (const r of rows) {
    try {
      routeStopLists.set(r.id, JSON.parse(r.stops_json));
    } catch { /* skip */ }
  }
}

/**
 * Check how many hops from stopA to stopB on a route.
 * Returns the number of stops between them (1 = consecutive), or -1 if not on route.
 */
function countHopsOnRoute(routeId: number, fromStop: number, toStop: number): number {
  const stops = routeStopLists.get(routeId);
  if (!stops || stops.length === 0) return -1;
  const fromIdx = stops.indexOf(fromStop);
  const toIdx = stops.indexOf(toStop);
  if (fromIdx === -1 || toIdx === -1) return -1;
  // Forward distance on the loop
  return (toIdx - fromIdx + stops.length) % stops.length;
}

/**
 * Compute predicted ETAs for every downstream stop from a bus's current position.
 * Returns array of { toStopId, etaSec, lowSec, highSec }.
 */
function computeDownstreamEtas(
  routeId: number,
  busStopIdx: number,
): Array<{ toStopId: number; fromStopId: number; etaSec: number; lowSec: number; highSec: number }> {
  const stops = routeStopLists.get(routeId);
  if (!stops || stops.length === 0) return [];
  const segMap = segmentCache.get(routeId);
  if (!segMap || segMap.size === 0) return [];

  // Fallback average segment time across this route
  const values = [...segMap.values()];
  const avgSeg = values.reduce((a, b) => a + b.avg, 0) / values.length;
  // Fallback stddev: 50% of avg (wide uncertainty when no data)
  const fallbackStddev = avgSeg * 0.5;

  // NOTE: segment times are now arrival-to-arrival (include dwell at origin),
  // so do NOT add dwellCache here — that would double-count.

  const n = stops.length;
  const fromStopId = stops[busStopIdx];
  const results: Array<{ toStopId: number; fromStopId: number; etaSec: number; lowSec: number; highSec: number }> = [];
  let cumulativeEta = 0;
  let cumulativeVar = 0;
  for (let step = 1; step < n; step++) {
    const prevIdx = (busStopIdx + step - 1) % n;
    const curIdx = (busStopIdx + step) % n;

    const key = `${stops[prevIdx]}-${stops[curIdx]}`;
    const seg = segMap.get(key);
    if (seg) {
      cumulativeEta += seg.avg;
      cumulativeVar += seg.stddev * seg.stddev;
    } else {
      cumulativeEta += avgSeg;
      cumulativeVar += fallbackStddev * fallbackStddev;
    }
    const stddev = Math.sqrt(cumulativeVar);
    results.push({
      toStopId: stops[curIdx],
      fromStopId,
      etaSec: cumulativeEta,
      lowSec: Math.max(0, cumulativeEta - stddev),
      highSec: cumulativeEta + stddev,
    });
  }
  return results;
}

function logGpsTransitions(db: Database.Database, buses: Bus[], now: string): void {
  const insertArr = db.prepare(`
    INSERT INTO gps_arrivals (bus_id, bus_name, route_id, stop_id, arrived_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  const insertDwell = db.prepare(`
    INSERT INTO gps_dwells (bus_id, bus_name, route_id, stop_id, dwell_seconds, entered_at, left_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const insertSeg = db.prepare(`
    INSERT INTO segment_times (bus_id, bus_name, route_id, from_stop_id, to_stop_id, travel_seconds, hops, day_of_week, hour, recorded_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertPred = db.prepare(`
    INSERT INTO predictions (bus_id, bus_name, route_id, from_stop_id, to_stop_id,
                             predicted_eta_sec, predicted_low_sec, predicted_high_sec, predicted_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const nowDate = new Date(now);
  const dayOfWeek = nowDate.getDay();
  const hour = nowDate.getHours();

  const tx = db.transaction(() => {
    for (const bus of buses) {
      if (!bus.lat || !bus.lon) continue;
      const near = nearestStopOnRoute(bus.route, bus.lat, bus.lon);
      if (near === null) continue;
      const prev = lastGpsStop.get(bus.id);
      if (prev?.stop === near) continue; // no transition

      // Record dwell at the previous stop (time bus spent as nearest to it)
      if (prev !== undefined) {
        const elapsedSec = (nowDate.getTime() - new Date(prev.enteredAt).getTime()) / 1000;
        if (elapsedSec >= 15 && elapsedSec < 3600) {
          insertDwell.run(bus.id, bus.name, bus.route, prev.stop, elapsedSec, prev.enteredAt, now);

          // Segment travel time: interval between entering prev and entering new.
          // This INCLUDES dwell at prev (intentional — matches rider experience: "if bus is at A,
          // how long until it reaches B" naturally includes the pause at A).
          // Only record if it's a consecutive hop on the route, to filter jumps.
          const hops = countHopsOnRoute(bus.route, prev.stop, near);
          if (hops === 1) {
            insertSeg.run(
              bus.id, bus.name, bus.route, prev.stop, near,
              elapsedSec, 1, dayOfWeek, hour, now,
            );
          }
        }
      }

      lastGpsStop.set(bus.id, { stop: near, enteredAt: now });

      // Skip first sighting — no useful prediction anchor
      if (prev === undefined) continue;

      insertArr.run(bus.id, bus.name, bus.route, near, now);

      const stops = routeStopLists.get(bus.route);
      if (!stops) continue;
      const idx = stops.indexOf(near);
      if (idx === -1) continue;
      const etas = computeDownstreamEtas(bus.route, idx);
      for (const e of etas) {
        insertPred.run(
          bus.id, bus.name, bus.route, e.fromStopId, e.toStopId,
          e.etaSec, e.lowSec, e.highSec, now,
        );
      }
    }
  });
  tx();
}

function collectBusPositions(db: Database.Database, buses: Bus[]): void {
  // Use SQLite-compatible datetime format (space separator, no trailing Z)
  const nowDate = new Date();
  const now = nowDate.toISOString().replace('T', ' ').replace('Z', '');
  const dayOfWeek = nowDate.getDay(); // 0=Sun .. 6=Sat
  const hour = nowDate.getHours();

  const insert = db.prepare(`
    INSERT INTO bus_positions (bus_id, bus_name, route_id, lat, lon, heading, last_stop_id, api_timestamp, collected_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertArrival = db.prepare(`
    INSERT INTO stop_arrivals (bus_id, bus_name, route_id, stop_id, arrived_at)
    VALUES (?, ?, ?, ?, ?)
  `);

  const updateDeparture = db.prepare(`
    UPDATE stop_arrivals SET departed_at = ?, dwell_seconds = (julianday(?) - julianday(arrived_at)) * 86400
    WHERE bus_id = ? AND stop_id = ? AND departed_at IS NULL
  `);

  const insertSegment = db.prepare(`
    INSERT INTO segment_times (bus_id, bus_name, route_id, from_stop_id, to_stop_id, travel_seconds, hops, day_of_week, hour, recorded_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const tx = db.transaction(() => {
    for (const bus of buses) {
      insert.run(bus.id, bus.name, bus.route, bus.lat, bus.lon, bus.heading, bus.lastStop, bus.lastUpdate, now);

      // Detect stop transitions from the API's last_stop_id — we use this for
      // dwell tracking in stop_arrivals (kept for backwards compatibility), but
      // NOT for segment_times any more: the API's last_stop_id is too noisy
      // (it often reports a stale stop while a bus is idling). Segments are
      // now GPS-based and logged in logGpsTransitions().
      const prev = lastKnownStop.get(bus.id);
      if (prev && prev.stopId !== bus.lastStop) {
        updateDeparture.run(now, now, bus.id, prev.stopId);
        insertArrival.run(bus.id, bus.name, bus.route, bus.lastStop, now);
      } else if (!prev) {
        insertArrival.run(bus.id, bus.name, bus.route, bus.lastStop, now);
      }

      // Only update timestamp when the stop actually changes (or first seen)
      if (!prev || prev.stopId !== bus.lastStop) {
        lastKnownStop.set(bus.id, { stopId: bus.lastStop, timestamp: now });
      }
    }
  });

  tx();
}

function collectEtas(db: Database.Database, stopId: number, etas: EtaEntry[]): void {
  const insert = db.prepare(`
    INSERT INTO eta_snapshots (stop_id, bus_id, bus_name, route_id, eta_seconds, collected_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
  `);

  const tx = db.transaction(() => {
    for (const eta of etas) {
      insert.run(stopId, eta.bus_id, eta.bus_name, eta.route, eta.avg * 60);
    }
  });
  tx();
}

function refreshStaticData(db: Database.Database, routes: RouteInfo[], stops: StopInfo[]): void {
  const insertRoute = db.prepare(`
    INSERT OR REPLACE INTO routes (id, name, short_name, description, color, stops_json, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
  `);
  const insertStop = db.prepare(`
    INSERT OR REPLACE INTO stops (id, name, lat, lon, updated_at)
    VALUES (?, ?, ?, ?, datetime('now'))
  `);

  const tx = db.transaction(() => {
    for (const r of routes) {
      insertRoute.run(r.id, r.name, r.short_name, r.description, r.color, JSON.stringify(r.stops));
    }
    for (const s of stops) {
      insertStop.run(s.id, s.name, s.lat, s.lon);
    }
  });
  tx();
}

// ---------------------------------------------------------------------------
// Vehicle profile updater (runs every 5 minutes)
// ---------------------------------------------------------------------------

function updateCalibratedSegments(db: Database.Database): void {
  // Per day-of-week — compute avg, sum(x²), count; derive stddev in JS.
  const calRows = db.prepare(`
    SELECT route_id, from_stop_id, to_stop_id, day_of_week,
           AVG(travel_seconds) as avg_s,
           AVG(travel_seconds * travel_seconds) as avg_sq,
           COUNT(*) as n
    FROM segment_times
    WHERE hops = 1
      AND recorded_at > datetime('now', '-30 days')
      AND travel_seconds BETWEEN 15 AND 1200
    GROUP BY route_id, from_stop_id, to_stop_id, day_of_week
    HAVING COUNT(*) >= 2
  `).all() as Array<{
    route_id: number; from_stop_id: number; to_stop_id: number; day_of_week: number;
    avg_s: number; avg_sq: number; n: number;
  }>;

  const insertCal = db.prepare(`
    INSERT OR REPLACE INTO calibrated_segments
    (route_id, from_stop_id, to_stop_id, day_of_week, avg_seconds, stddev_seconds, sample_count, last_updated)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `);

  const txCal = db.transaction(() => {
    for (const r of calRows) {
      const variance = Math.max(0, r.avg_sq - r.avg_s * r.avg_s);
      const stddev = Math.sqrt(variance);
      insertCal.run(r.route_id, r.from_stop_id, r.to_stop_id, r.day_of_week, r.avg_s, stddev, r.n);
    }
  });
  txCal();

  // Overall averages (all days, fallback)
  const avgRows = db.prepare(`
    SELECT route_id, from_stop_id, to_stop_id,
           AVG(travel_seconds) as avg_s,
           AVG(travel_seconds * travel_seconds) as avg_sq,
           COUNT(*) as n
    FROM segment_times
    WHERE hops = 1
      AND recorded_at > datetime('now', '-30 days')
      AND travel_seconds BETWEEN 15 AND 1200
    GROUP BY route_id, from_stop_id, to_stop_id
    HAVING COUNT(*) >= 1
  `).all() as Array<{
    route_id: number; from_stop_id: number; to_stop_id: number;
    avg_s: number; avg_sq: number; n: number;
  }>;

  const insertAvg = db.prepare(`
    INSERT OR REPLACE INTO segment_averages
    (route_id, from_stop_id, to_stop_id, avg_seconds, stddev_seconds, sample_count, last_updated)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
  `);

  const txAvg = db.transaction(() => {
    for (const r of avgRows) {
      const variance = Math.max(0, r.avg_sq - r.avg_s * r.avg_s);
      const stddev = Math.sqrt(variance);
      insertAvg.run(r.route_id, r.from_stop_id, r.to_stop_id, r.avg_s, stddev, r.n);
    }
  });
  txAvg();
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function updateCalibratedDwells(db: Database.Database): void {
  // Use GPS-derived dwells (more accurate than the API's lastStop-based stop_arrivals).
  // Filter: >= 30s excludes drive-throughs.
  const raw = db.prepare(`
    SELECT route_id, stop_id,
           CAST(strftime('%w', entered_at) AS INTEGER) AS day_of_week,
           dwell_seconds
    FROM gps_dwells
    WHERE dwell_seconds BETWEEN 30 AND 1800
      AND entered_at > datetime('now', '-30 days')
  `).all() as Array<{ route_id: number; stop_id: number; day_of_week: number; dwell_seconds: number }>;

  // Group by (route, stop, dow) and by (route, stop) for fallback
  const byDow = new Map<string, number[]>();
  const byAll = new Map<string, number[]>();
  for (const r of raw) {
    const kDow = `${r.route_id}|${r.stop_id}|${r.day_of_week}`;
    const kAll = `${r.route_id}|${r.stop_id}`;
    if (!byDow.has(kDow)) byDow.set(kDow, []);
    if (!byAll.has(kAll)) byAll.set(kAll, []);
    byDow.get(kDow)!.push(r.dwell_seconds);
    byAll.get(kAll)!.push(r.dwell_seconds);
  }

  const insertCal = db.prepare(`
    INSERT OR REPLACE INTO calibrated_dwells
    (route_id, stop_id, day_of_week, median_dwell_seconds, stddev_dwell_seconds, sample_count, last_updated)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
  `);
  const insertAvg = db.prepare(`
    INSERT OR REPLACE INTO dwell_averages
    (route_id, stop_id, median_dwell_seconds, stddev_dwell_seconds, sample_count, last_updated)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
  `);

  const tx = db.transaction(() => {
    for (const [key, values] of byDow) {
      if (values.length < 3) continue;
      const med = median(values);
      const mean = values.reduce((a, b) => a + b, 0) / values.length;
      const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
      const stddev = Math.sqrt(variance);
      const [routeId, stopId, dow] = key.split('|').map(Number);
      insertCal.run(routeId, stopId, dow, med, stddev, values.length);
    }
    for (const [key, values] of byAll) {
      if (values.length < 3) continue;
      const med = median(values);
      const mean = values.reduce((a, b) => a + b, 0) / values.length;
      const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
      const stddev = Math.sqrt(variance);
      const [routeId, stopId] = key.split('|').map(Number);
      insertAvg.run(routeId, stopId, med, stddev, values.length);
    }
  });
  tx();
}

function updateVehicleProfiles(db: Database.Database): void {
  // Calculate average speed from segment times
  db.exec(`
    INSERT OR REPLACE INTO vehicle_profiles (bus_name, route_id, avg_speed_kmh, avg_dwell_seconds, avg_loop_minutes, sample_count, last_updated)
    SELECT
      st.bus_name,
      st.route_id,
      NULL as avg_speed_kmh,
      COALESCE(dwell.avg_dwell, 0) as avg_dwell_seconds,
      AVG(st.travel_seconds) / 60.0 as avg_loop_minutes,
      COUNT(*) as sample_count,
      datetime('now') as last_updated
    FROM segment_times st
    LEFT JOIN (
      SELECT bus_name, route_id, AVG(dwell_seconds) as avg_dwell
      FROM stop_arrivals
      WHERE dwell_seconds IS NOT NULL AND dwell_seconds > 0 AND dwell_seconds < 600
      GROUP BY bus_name, route_id
    ) dwell ON dwell.bus_name = st.bus_name AND dwell.route_id = st.route_id
    WHERE st.recorded_at > datetime('now', '-7 days')
    GROUP BY st.bus_name, st.route_id
    HAVING COUNT(*) >= 3
  `);
}

// ---------------------------------------------------------------------------
// Query interface: predicted arrival time
// ---------------------------------------------------------------------------

export interface ArrivalPrediction {
  bus_id: number;
  bus_name: string;
  route_id: number;
  route_name: string;
  route_color: string;
  stop_id: number;
  stop_name: string;
  official_eta_seconds: number | null;
  predicted_eta_seconds: number | null;
  confidence: 'low' | 'medium' | 'high';
  vehicle_profile: {
    avg_dwell_seconds: number | null;
    avg_segment_minutes: number | null;
    sample_count: number;
  } | null;
}

/**
 * Get predicted arrival times for given stops.
 * Called by the query script — this is the main public interface.
 */
export function getPredictions(
  db: Database.Database,
  stopIds: number[] = DEFAULT_STOPS,
  routeFilter: number[] = WATCHED_ROUTES,
): ArrivalPrediction[] {
  const predictions: ArrivalPrediction[] = [];

  // Get latest ETAs from snapshots (last 2 minutes)
  const recentEtas = db.prepare(`
    SELECT stop_id, bus_id, bus_name, route_id, eta_seconds,
           collected_at
    FROM eta_snapshots
    WHERE stop_id IN (${stopIds.map(() => '?').join(',')})
      AND collected_at > datetime('now', '-2 minutes')
    ORDER BY collected_at DESC
  `).all(...stopIds) as Array<{
    stop_id: number; bus_id: number; bus_name: string;
    route_id: number; eta_seconds: number; collected_at: string;
  }>;

  // Deduplicate: keep latest per (stop, bus)
  const seen = new Set<string>();
  const dedupedEtas = recentEtas.filter(e => {
    const key = `${e.stop_id}-${e.bus_id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Get route and stop names
  const routeMap = new Map<number, { name: string; color: string }>();
  const routes = db.prepare('SELECT id, name, color FROM routes').all() as Array<{ id: number; name: string; color: string }>;
  for (const r of routes) routeMap.set(r.id, { name: r.name, color: r.color });

  const stopMap = new Map<number, string>();
  const stops = db.prepare('SELECT id, name FROM stops').all() as Array<{ id: number; name: string }>;
  for (const s of stops) stopMap.set(s.id, s.name);

  // Get vehicle profiles
  const profileMap = new Map<string, { avg_dwell_seconds: number; avg_segment_minutes: number; sample_count: number }>();
  const profiles = db.prepare('SELECT * FROM vehicle_profiles').all() as Array<{
    bus_name: string; route_id: number; avg_dwell_seconds: number;
    avg_loop_minutes: number; sample_count: number;
  }>;
  for (const p of profiles) {
    profileMap.set(`${p.bus_name}-${p.route_id}`, {
      avg_dwell_seconds: p.avg_dwell_seconds,
      avg_segment_minutes: p.avg_loop_minutes,
      sample_count: p.sample_count,
    });
  }

  for (const eta of dedupedEtas) {
    if (routeFilter.length > 0 && !routeFilter.includes(eta.route_id)) continue;

    const route = routeMap.get(eta.route_id);
    const profile = profileMap.get(`${eta.bus_name}-${eta.route_id}`);

    // Adjust official ETA based on how old the snapshot is
    const snapshotAge = (Date.now() - new Date(eta.collected_at + 'Z').getTime()) / 1000;
    const adjustedEta = Math.max(0, eta.eta_seconds - snapshotAge);

    let predictedEta: number | null = null;
    let confidence: 'low' | 'medium' | 'high' = 'low';

    if (profile && profile.sample_count >= 10) {
      // We have enough data to adjust — use vehicle profile to scale
      // For now, simple: use official ETA but note confidence based on data
      predictedEta = Math.round(adjustedEta);
      confidence = profile.sample_count >= 50 ? 'high' : 'medium';
    } else {
      predictedEta = Math.round(adjustedEta);
      confidence = profile ? 'medium' : 'low';
    }

    predictions.push({
      bus_id: eta.bus_id,
      bus_name: eta.bus_name,
      route_id: eta.route_id,
      route_name: route?.name ?? `Route ${eta.route_id}`,
      route_color: route?.color ?? '000000',
      stop_id: eta.stop_id,
      stop_name: stopMap.get(eta.stop_id) ?? `Stop ${eta.stop_id}`,
      official_eta_seconds: eta.eta_seconds,
      predicted_eta_seconds: predictedEta,
      confidence,
      vehicle_profile: profile ?? null,
    });
  }

  // Sort by predicted ETA
  predictions.sort((a, b) => (a.predicted_eta_seconds ?? 9999) - (b.predicted_eta_seconds ?? 9999));

  return predictions;
}

/**
 * Get active buses on watched routes.
 */
export function getActiveBuses(
  db: Database.Database,
  routeFilter: number[] = WATCHED_ROUTES,
): Array<{ bus_id: number; bus_name: string; route_id: number; route_name: string; lat: number; lon: number; last_stop: string; updated: string }> {
  const latest = db.prepare(`
    SELECT bp.bus_id, bp.bus_name, bp.route_id, bp.lat, bp.lon, bp.last_stop_id,
           bp.collected_at, s.name as stop_name, r.name as route_name
    FROM bus_positions bp
    LEFT JOIN stops s ON s.id = bp.last_stop_id
    LEFT JOIN routes r ON r.id = bp.route_id
    WHERE bp.collected_at > datetime('now', '-2 minutes')
      ${routeFilter.length > 0 ? `AND bp.route_id IN (${routeFilter.join(',')})` : ''}
    ORDER BY bp.collected_at DESC
  `).all() as Array<{
    bus_id: number; bus_name: string; route_id: number; lat: number; lon: number;
    last_stop_id: number; collected_at: string; stop_name: string; route_name: string;
  }>;

  // Deduplicate by bus_id
  const seenBuses = new Set<number>();
  return latest.filter(b => {
    if (seenBuses.has(b.bus_id)) return false;
    seenBuses.add(b.bus_id);
    return true;
  }).map(b => ({
    bus_id: b.bus_id,
    bus_name: b.bus_name,
    route_id: b.route_id,
    route_name: b.route_name ?? `Route ${b.route_id}`,
    lat: b.lat,
    lon: b.lon,
    last_stop: b.stop_name ?? `Stop ${b.last_stop_id}`,
    updated: b.collected_at,
  }));
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

let pollCount = 0;
let lastStaticRefresh = 0;
let lastProfileUpdate = 0;

async function poll(db: Database.Database): Promise<void> {
  pollCount++;
  const now = Date.now();

  // Refresh static data every 6 hours
  if (now - lastStaticRefresh > 6 * 60 * 60 * 1000) {
    console.log(`[${new Date().toISOString()}] Refreshing static route/stop data...`);
    const [routes, stops] = await Promise.all([fetchRoutes(), fetchStops()]);
    if (routes.length > 0 && stops.length > 0) {
      refreshStaticData(db, routes, stops);
      loadRouteStopLists(db);
      loadStopCoords(db);
      lastStaticRefresh = now;
      console.log(`  ${routes.length} routes, ${stops.length} stops cached`);
    }
  }

  // Poll bus positions
  const buses = await fetchBuses();
  if (buses.length > 0) {
    collectBusPositions(db, buses);
    logGpsTransitions(db, buses, new Date().toISOString().replace('T', ' ').replace('Z', ''));
  }

  // ETA polling disabled — we compute our own from calibrated segment data
  // for (const stopId of DEFAULT_STOPS) {
  //   const etas = await fetchEtas(stopId);
  //   if (etas.length > 0) { collectEtas(db, stopId, etas); }
  // }

  // Update vehicle profiles + calibrated segments every 5 minutes
  if (now - lastProfileUpdate > 5 * 60 * 1000) {
    updateVehicleProfiles(db);
    updateCalibratedSegments(db);
    updateCalibratedDwells(db);
    loadSegmentCache(db);
    lastProfileUpdate = now;
  }

  if (pollCount % 60 === 0) {
    // Log stats every ~30 min
    const posCount = (db.prepare('SELECT COUNT(*) as c FROM bus_positions').get() as { c: number }).c;
    const arrCount = (db.prepare('SELECT COUNT(*) as c FROM stop_arrivals').get() as { c: number }).c;
    const profCount = (db.prepare('SELECT COUNT(*) as c FROM vehicle_profiles').get() as { c: number }).c;
    console.log(`[${new Date().toISOString()}] Stats: ${posCount} positions, ${arrCount} arrivals, ${profCount} profiles | ${buses.length} buses active`);
  }
}

async function main(): Promise<void> {
  console.log('Yale Shuttle Collector starting...');
  console.log(`  DB: ${DB_PATH}`);
  console.log(`  Poll interval: ${POLL_INTERVAL_MS / 1000}s`);
  console.log(`  Watched stops: ${DEFAULT_STOPS.join(', ')}`);
  console.log(`  Watched routes: ${WATCHED_ROUTES.join(', ')}`);

  const db = initDb();

  // Initial static data load
  const [routes, stops] = await Promise.all([fetchRoutes(), fetchStops()]);
  if (routes.length > 0 && stops.length > 0) {
    refreshStaticData(db, routes, stops);
    loadRouteStopLists(db);
    loadStopCoords(db);
    lastStaticRefresh = Date.now();
    console.log(`  Loaded ${routes.length} routes, ${stops.length} stops`);
  } else {
    loadRouteStopLists(db); // load from cache
    loadStopCoords(db);
  }
  loadSegmentCache(db);

  console.log('Collector running. Ctrl+C to stop.\n');

  // Poll loop
  const tick = async () => {
    try {
      await poll(db);
    } catch (err) {
      console.error('Poll error:', err);
    }
  };

  await tick(); // First poll immediately
  setInterval(tick, POLL_INTERVAL_MS);

  // Graceful shutdown
  process.on('SIGINT', () => {
    console.log('\nShutting down...');
    db.close();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    console.log('\nShutting down...');
    db.close();
    process.exit(0);
  });
}

// If run directly, start the collector. If imported, export the query functions.
if (process.argv[1]?.endsWith('index.ts') || process.argv[1]?.endsWith('index.js')) {
  main();
}
