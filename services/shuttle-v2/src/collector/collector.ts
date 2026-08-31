import type Database from "better-sqlite3";

import { calibrate } from "../calibrator/calibrator.js";
import type { DB, DbBundle } from "../db/client.js";
import {
  arrivals,
  rawPositions,
  routes as routesTable,
  segments,
  stops as stopsTable,
} from "../db/schema.js";
import { distanceMeters } from "../network/geo.js";
import { NetworkRef } from "../network/NetworkRef.js";
import { TransitNetwork } from "../network/TransitNetwork.js";
import type { BusPosition, Route, Stop } from "../schema/api.js";

import type { BusObservation, BusState, DetectorEvent } from "./detector.js";
import { stepMany } from "./detector.js";
import { UpstreamClient, UpstreamError, type RawBus } from "./upstream.js";

// Cadences --------------------------------------------------------------------

const POLL_INTERVAL_MS = 5_000;
const CALIBRATE_INTERVAL_MS = 5 * 60_000;
const STATIC_REFRESH_INTERVAL_MS = 6 * 60 * 60_000;
const RETENTION_INTERVAL_MS = 60 * 60_000;

// How close a bus must actually be before we call it "at" a stop. The
// detector's `nearestStopId` is an unbounded nearest-neighbour with no radius,
// so without this a bus idling mid-route claims whichever stop happens to be
// closest — observed at 166–558 m on 5 of 16 live buses.
const AT_STOP_MAX_M = 75;

/**
 * A bus is "live" only while it keeps appearing in the upstream feed. Once it
 * goes out of service, upstream stops reporting it — but its last position
 * would otherwise linger in `livePositions` forever. Without this TTL a Red
 * bus seen at 6pm is still served at 10pm (after Red stops running), which is
 * exactly the "shows routes that aren't active" bug. 120 s tolerates a couple
 * of missed polls (GPS dropout in a garage/tunnel) without flickering a bus
 * that's genuinely running.
 */
const LIVE_BUS_TTL_MS = 120_000;

/**
 * Drop per-bus detector state after this long off the radar. The detector
 * already re-anchors after MAX_OBSERVATION_GAP_MS (10 min), so anything older
 * would re-anchor anyway — pruning just keeps the `states` map from growing
 * across very long uptimes / fleet-roster churn.
 */
const STATE_TTL_MS = 30 * 60_000;

// Retention windows -----------------------------------------------------------

const RAW_POSITION_RETAIN_MS = 6 * 60 * 60_000; // 6 h
const ARRIVAL_RETAIN_MS = 90 * 24 * 60 * 60_000; // 90 d
const SEGMENT_RETAIN_MS = 90 * 24 * 60 * 60_000; // 90 d (calibrator looks back 30 d)

// Batched-delete tuning carried forward from the v1 retention fix:
// large transactions starved the poll loop and tripped /healthz.
const RETENTION_BATCH = 2_000;
const RETENTION_MAX_MS_PER_TABLE = 4_000;

// Logging ---------------------------------------------------------------------

export interface Logger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

const consoleLogger: Logger = {
  info: (msg, meta) => console.log(JSON.stringify({ level: "info", msg, ...meta })),
  warn: (msg, meta) => console.warn(JSON.stringify({ level: "warn", msg, ...meta })),
  error: (msg, meta) => console.error(JSON.stringify({ level: "error", msg, ...meta })),
};

// Implementation --------------------------------------------------------------

export interface CollectorOptions {
  upstream?: UpstreamClient;
  logger?: Logger;
}

/**
 * Long-lived orchestrator. Owns the in-memory `TransitNetwork` (via a
 * `NetworkRef` so static refreshes can swap topology atomically) and the
 * per-bus `BusState` map. Runs four independent timers:
 *
 *  - poll        every 5 s   — fetch buses, run detector, persist events
 *  - calibrate   every 5 min — recompute segment/dwell stats from SQLite
 *  - static      every 6 h   — refresh stops/routes from upstream
 *  - retention   every 1 h   — batched-delete old raw_positions
 *
 * The HTTP server in the same process holds the same `NetworkRef` and reads
 * live state directly — no IPC, no cross-process cache invalidation.
 */
export class Collector {
  readonly ref: NetworkRef;

  private readonly db: DB;
  private readonly sqlite: Database.Database;
  private readonly upstream: UpstreamClient;
  private readonly logger: Logger;
  private readonly states = new Map<number, BusState>();
  private readonly livePositions = new Map<number, BusPosition>();

  private readonly upsertStopStmt: Database.Statement;
  private readonly upsertRouteStmt: Database.Statement;
  private readonly patchDwellStmt: Database.Statement;
  private readonly trimStmts = new Map<string, Database.Statement>();

  private pollHandle?: NodeJS.Timeout;
  private calibrateHandle?: NodeJS.Timeout;
  private staticHandle?: NodeJS.Timeout;
  private retentionHandle?: NodeJS.Timeout;

  private lastStaticRefreshAt = 0;
  // Monotonic counter over everything the HTTP layer's fat /api/buses payload
  // is derived from: live positions (every 5 s), calibrated segment/dwell
  // stats (every 5 min) and the static topology (every 6 h). The server
  // memoizes on it so 200 riders polling inside one collector tick cost one
  // payload build, not 200.
  private version = 0;
  // Liveness: when the poll timer last fired (independent of upstream health).
  // /healthz uses this so a wedged loop trips Fly's restart, while a mere
  // upstream outage (no buses to report) does not.
  private lastPollAttemptAt = Date.now();

  private constructor(
    bundle: DbBundle,
    ref: NetworkRef,
    opts: CollectorOptions,
  ) {
    this.db = bundle.db;
    this.sqlite = bundle.sqlite;
    this.ref = ref;
    this.upstream = opts.upstream ?? new UpstreamClient();
    this.logger = opts.logger ?? consoleLogger;

    // Prepared once; reused on every poll. Composing these via Drizzle's
    // template SQL works too but adds parsing on each call.
    this.upsertStopStmt = this.sqlite.prepare(`
      INSERT INTO stops (id, name, lat, lon, updated_at)
      VALUES (@id, @name, @lat, @lon, @updatedAt)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        lat = excluded.lat,
        lon = excluded.lon,
        updated_at = excluded.updated_at
    `);
    this.upsertRouteStmt = this.sqlite.prepare(`
      INSERT INTO routes (id, name, short_name, color, stops_json, path_json, updated_at)
      VALUES (@id, @name, @shortName, @color, @stopsJson, @pathJson, @updatedAt)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        short_name = excluded.short_name,
        color = excluded.color,
        stops_json = excluded.stops_json,
        path_json = excluded.path_json,
        updated_at = excluded.updated_at
    `);
    // Patch dwell metadata onto the most recent matching arrival row.
    // The detector emits dwell on the same tick as the *next* arrival, so the
    // arrival being patched was inserted at least one poll cycle earlier.
    this.patchDwellStmt = this.sqlite.prepare(`
      UPDATE arrivals
      SET departed_at = @leftAt, dwell_sec = @dwellSec
      WHERE id = (
        SELECT id FROM arrivals
        WHERE bus_id = @busId AND stop_id = @stopId
          AND arrived_at <= @enteredAt
        ORDER BY arrived_at DESC LIMIT 1
      )
    `);
    for (const table of ["raw_positions", "arrivals", "segments"] as const) {
      const col = retentionColumn(table);
      this.trimStmts.set(
        table,
        this.sqlite.prepare(
          `DELETE FROM ${table} WHERE rowid IN ` +
            `(SELECT rowid FROM ${table} WHERE ${col} < ? LIMIT ?)`,
        ),
      );
    }
  }

  /**
   * Build a Collector from whatever static data is already in SQLite. If the
   * tables are empty (fresh DB), the network starts empty; the first upstream
   * static refresh populates it before the first poll's events are processed.
   */
  static async create(bundle: DbBundle, opts: CollectorOptions = {}): Promise<Collector> {
    const stops = loadStaticStops(bundle.db);
    const routes = loadStaticRoutes(bundle.db);
    const network = TransitNetwork.build(stops, routes);
    return new Collector(bundle, new NetworkRef(network), opts);
  }

  async start(): Promise<void> {
    await this.refreshStaticIfNeeded(true);
    // Warm calibration from existing samples before the first poll, so
    // day-zero predictions aren't pure distance-based priors.
    this.runCalibrate();

    this.pollHandle = setInterval(() => void this.runPoll(), POLL_INTERVAL_MS);
    this.calibrateHandle = setInterval(() => this.runCalibrate(), CALIBRATE_INTERVAL_MS);
    this.staticHandle = setInterval(
      () => void this.refreshStaticIfNeeded(false),
      STATIC_REFRESH_INTERVAL_MS,
    );
    this.retentionHandle = setInterval(() => this.runRetention(), RETENTION_INTERVAL_MS);
    for (const h of [this.pollHandle, this.calibrateHandle, this.staticHandle, this.retentionHandle]) {
      h?.unref();
    }

    void this.runPoll();
    this.logger.info("collector.started");
  }

  stop(): void {
    for (const h of [this.pollHandle, this.calibrateHandle, this.staticHandle, this.retentionHandle]) {
      if (h) clearInterval(h);
    }
    this.logger.info("collector.stopped");
  }

  // -- Tick handlers ---------------------------------------------------------

  private async runPoll(): Promise<void> {
    // Record the attempt first so liveness reflects "the loop is firing",
    // not "upstream is healthy".
    this.lastPollAttemptAt = Date.now();
    let buses: RawBus[];
    try {
      buses = await this.upstream.buses();
    } catch (err) {
      this.logUpstreamError("poll", err);
      return;
    }
    if (buses.length === 0) return;

    // Persistence + detector can throw (SQLite locked/full, bad geometry). A
    // single bad tick must never reject the poll promise — that would surface
    // as an unhandledRejection and could take the whole process down.
    try {
      const now = Date.now();
      const observations: BusObservation[] = buses
        .filter((b) => Number.isFinite(b.lat) && Number.isFinite(b.lon))
        .map((b) => ({
          busId: b.id,
          busName: b.name,
          routeId: b.route,
          lat: b.lat,
          lon: b.lon,
          heading: b.heading,
          lastStopId: b.lastStop ?? null,
          collectedAt: now,
        }));

      this.persistRawPositions(observations);
      const events = stepMany(this.ref.get(), this.states, observations);
      if (events.length > 0) this.persistEvents(events);
      this.updateLivePositions(observations);
    } catch (err) {
      this.logger.error("collector.poll_process_failed", {
        error: (err as Error).message,
      });
    }
  }

  /** Milliseconds since the poll loop last fired. Liveness signal for /healthz. */
  pollStalenessMs(): number {
    return Date.now() - this.lastPollAttemptAt;
  }

  /**
   * Cache key for anything derived from collector state. Changes on every
   * live-position update, calibration pass and topology swap — and on nothing
   * else, so a reader that has already built a view of this version can serve
   * it unchanged.
   */
  dataVersion(): number {
    return this.version;
  }

  /**
   * Snapshot of the latest observed position per bus. Read by the HTTP
   * server's /api/live and by the trip planner's wait-time estimator.
   * Returns a freshly-cloned array so consumers can't mutate internal state.
   */
  getLiveBuses(): BusPosition[] {
    // Filter at read time (not just at poll time): during an upstream outage
    // runPoll bails before updating positions, so the only thing keeping
    // ghosts out of the response is this freshness check against the clock.
    const cutoff = Date.now() - LIVE_BUS_TTL_MS;
    const out: BusPosition[] = [];
    for (const b of this.livePositions.values()) {
      if (b.collectedAt >= cutoff) out.push(b);
    }
    return out;
  }

  private updateLivePositions(observations: readonly BusObservation[]): void {
    for (const o of observations) {
      const state = this.states.get(o.busId);
      const dwellingForMs = state ? o.collectedAt - state.enteredAt : 0;
      // Consider the bus to be "at" its nearest stop once it's been there
      // long enough that it isn't just passing through. Mirrors the
      // detector's MIN_DWELL_SEC threshold so the UI dot stays put while
      // the bus actually waits.
      // ...and only if it's actually THERE. `nearestStopId` is an unbounded
      // nearest-neighbour, so a bus idling anywhere on the route was reported
      // "at" whatever stop happened to be closest — 5 of 16 live buses were
      // claiming a stop 166–558 m away. Clients treat at_stop_id as ground
      // truth over GPS, so those bogus anchors made buses appear to jump
      // backwards and swung ETAs by a third of a loop (reports #32, #37, #38).
      const atStopCandidate = state && dwellingForMs >= 15_000
        ? this.ref.get().stops.get(state.nearestStopId)
        : undefined;
      const atStop = state && atStopCandidate &&
        distanceMeters(o, atStopCandidate) <= AT_STOP_MAX_M
        ? { id: state.nearestStopId, since: state.enteredAt }
        : null;
      this.livePositions.set(o.busId, {
        busId: o.busId,
        busName: o.busName,
        routeId: o.routeId,
        lat: o.lat,
        lon: o.lon,
        heading: o.heading,
        lastStopId: o.lastStopId,
        atStopId: atStop ? atStop.id : null,
        atStopSince: atStop ? atStop.since : null,
        collectedAt: o.collectedAt,
      });
    }
    // Drop buses that have aged out of the feed so the map doesn't grow
    // unbounded and getLiveBuses stays cheap. (getLiveBuses also filters, to
    // cover the no-poll/outage case.)
    const now = observations[0]?.collectedAt ?? Date.now();
    const liveCutoff = now - LIVE_BUS_TTL_MS;
    for (const [id, b] of this.livePositions) {
      if (b.collectedAt < liveCutoff) this.livePositions.delete(id);
    }
    const stateCutoff = now - STATE_TTL_MS;
    for (const [id, s] of this.states) {
      if (s.lastObservedAt < stateCutoff) this.states.delete(id);
    }
    this.version++;
  }

  private runCalibrate(): void {
    try {
      const stats = calibrate(this.db, this.ref.get());
      // Calibration mutates the live network's stats in place, so readers
      // memoizing on dataVersion() must be told the segment/dwell numbers moved.
      this.version++;
      this.logger.info("collector.calibrated", { ...stats });
    } catch (err) {
      this.logger.error("collector.calibrate_failed", {
        error: (err as Error).message,
      });
    }
  }

  private async refreshStaticIfNeeded(force: boolean): Promise<void> {
    const now = Date.now();
    if (!force && now - this.lastStaticRefreshAt < STATIC_REFRESH_INTERVAL_MS) return;
    try {
      const [stops, routes] = await Promise.all([this.upstream.stops(), this.upstream.routes()]);
      if (stops.length === 0 || routes.length === 0) return;
      this.persistStatic(stops, routes);
      // Build fresh, run calibration into it, then swap — so the new network
      // is already calibrated when consumers start reading it.
      const rebuilt = TransitNetwork.build(stops, routes);
      calibrate(this.db, rebuilt);
      this.ref.replace(rebuilt);
      this.version++;
      this.lastStaticRefreshAt = now;
      this.logger.info("collector.static_refreshed", {
        stops: stops.length,
        routes: routes.length,
      });
    } catch (err) {
      this.logUpstreamError("static_refresh", err);
    }
  }

  private runRetention(): void {
    // Runs in a bare setInterval — a throw here would be an uncaughtException
    // and crash the process. Contain it; a failed sweep just retries next hour.
    try {
      const now = Date.now();
      const trims: Array<[string, number]> = [
        ["raw_positions", now - RAW_POSITION_RETAIN_MS],
        ["arrivals", now - ARRIVAL_RETAIN_MS],
        ["segments", now - SEGMENT_RETAIN_MS],
      ];
      for (const [table, cutoffMs] of trims) {
        const stmt = this.trimStmts.get(table);
        if (!stmt) continue;
        const start = Date.now();
        let total = 0;
        while (Date.now() - start < RETENTION_MAX_MS_PER_TABLE) {
          const res = stmt.run(cutoffMs, RETENTION_BATCH);
          total += res.changes;
          if (res.changes === 0) break;
        }
        if (total > 0) this.logger.info("collector.retention", { table, deleted: total });
      }
    } catch (err) {
      this.logger.error("collector.retention_failed", { error: (err as Error).message });
    }
  }

  // -- Persistence helpers ---------------------------------------------------

  private persistRawPositions(observations: readonly BusObservation[]): void {
    if (observations.length === 0) return;
    this.db
      .insert(rawPositions)
      .values(
        observations.map((o) => ({
          busId: o.busId,
          busName: o.busName,
          routeId: o.routeId,
          lat: o.lat,
          lon: o.lon,
          heading: o.heading,
          lastStopId: o.lastStopId,
          collectedAt: new Date(o.collectedAt),
        })),
      )
      .run();
  }

  private persistEvents(events: readonly DetectorEvent[]): void {
    // Inserts first (arrivals + segments), then dwell patches.
    // The detector emits arrivals on every transition AND on first sight /
    // re-anchor, so the dwell-patch always has a prior row to update.
    const arrivalRows: Array<typeof arrivals.$inferInsert> = [];
    const segmentRows: Array<typeof segments.$inferInsert> = [];

    for (const e of events) {
      if (e.kind === "arrival") {
        const d = new Date(e.arrivedAt);
        arrivalRows.push({
          busId: e.busId,
          busName: e.busName,
          routeId: e.routeId,
          stopId: e.stopId,
          arrivedAt: d,
          dow: d.getDay(),
          hour: d.getHours(),
        });
      } else if (e.kind === "segment") {
        const d = new Date(e.startedAt);
        segmentRows.push({
          busId: e.busId,
          busName: e.busName,
          routeId: e.routeId,
          fromStopId: e.fromStopId,
          toStopId: e.toStopId,
          travelSec: e.travelSec,
          startedAt: d,
          dow: d.getDay(),
          hour: d.getHours(),
        });
      }
    }

    if (arrivalRows.length > 0) this.db.insert(arrivals).values(arrivalRows).run();
    if (segmentRows.length > 0) this.db.insert(segments).values(segmentRows).run();

    for (const e of events) {
      if (e.kind !== "dwell") continue;
      this.patchDwellStmt.run({
        leftAt: e.leftAt,
        dwellSec: e.dwellSec,
        busId: e.busId,
        stopId: e.stopId,
        enteredAt: e.enteredAt,
      });
    }
  }

  private persistStatic(stops: readonly Stop[], routes: readonly Route[]): void {
    const now = Date.now();
    const tx = this.sqlite.transaction(() => {
      for (const s of stops) {
        this.upsertStopStmt.run({
          id: s.id,
          name: s.name,
          lat: s.lat,
          lon: s.lon,
          updatedAt: now,
        });
      }
      for (const r of routes) {
        this.upsertRouteStmt.run({
          id: r.id,
          name: r.name,
          shortName: r.shortName,
          color: r.color,
          stopsJson: JSON.stringify(r.stops),
          pathJson: r.path ? JSON.stringify(r.path) : null,
          updatedAt: now,
        });
      }
    });
    tx();
  }

  private logUpstreamError(where: string, err: unknown): void {
    if (err instanceof UpstreamError) {
      this.logger.warn(`collector.${where}_upstream`, { error: err.message });
    } else {
      this.logger.error(`collector.${where}_unexpected`, {
        error: (err as Error).message,
      });
    }
  }
}

// Static helpers -------------------------------------------------------------

function loadStaticStops(db: DB): Stop[] {
  return db
    .select({
      id: stopsTable.id,
      name: stopsTable.name,
      lat: stopsTable.lat,
      lon: stopsTable.lon,
    })
    .from(stopsTable)
    .all();
}

function loadStaticRoutes(db: DB): Route[] {
  const rows = db
    .select({
      id: routesTable.id,
      name: routesTable.name,
      shortName: routesTable.shortName,
      color: routesTable.color,
      stopsJson: routesTable.stopsJson,
      pathJson: routesTable.pathJson,
    })
    .from(routesTable)
    .all();
  return rows.map((r) => {
    const stops = JSON.parse(r.stopsJson) as number[];
    let path: [number, number][] | undefined;
    if (r.pathJson) {
      try {
        path = JSON.parse(r.pathJson) as [number, number][];
      } catch {
        path = undefined;
      }
    }
    return {
      id: r.id,
      name: r.name,
      shortName: r.shortName,
      color: r.color,
      stops,
      ...(path ? { path } : {}),
    };
  });
}

function retentionColumn(table: "raw_positions" | "arrivals" | "segments"): string {
  switch (table) {
    case "raw_positions":
      return "collected_at";
    case "arrivals":
      return "arrived_at";
    case "segments":
      return "started_at";
  }
}
