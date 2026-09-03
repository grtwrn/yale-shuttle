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
import {
  derivePath,
  isBetterThanUpstream,
  traceFailures,
  type Sample,
} from "../network/derivePath.js";
import { distanceMeters, type LatLon } from "../network/geo.js";
import { NetworkRef } from "../network/NetworkRef.js";
import { TransitNetwork } from "../network/TransitNetwork.js";
import type { BusPosition, Route, Stop } from "../schema/api.js";

import type { BusObservation, BusState, DetectorEvent, TrackPlan } from "./detector.js";
import { planTracks, reconcileTracks, stepMany } from "./detector.js";
import {
  PathStore,
  shouldReplacePath,
  stopFitM,
  toStoredPath,
  upstreamNowBeats,
  type StoredPath,
} from "./pathStore.js";
import { type Announcement, UpstreamClient, UpstreamError, type RawBus } from "./upstream.js";

// Cadences --------------------------------------------------------------------

const POLL_INTERVAL_MS = 5_000;
const CALIBRATE_INTERVAL_MS = 5 * 60_000;
const STATIC_REFRESH_INTERVAL_MS = 6 * 60 * 60_000;
// Service banners change on a human timescale (a construction notice lives for
// weeks), but when one appears riders should see it the same trip, not six
// hours later. Five minutes is frequent enough and costs one tiny GET.
const ANNOUNCEMENTS_INTERVAL_MS = 5 * 60_000;
const RETENTION_INTERVAL_MS = 60 * 60_000;

/**
 * Path derivation: one route per tick, every minute.
 *
 * The work is a SQLite fetch of a route's recent samples plus O(samples x
 * stops) distance arithmetic, and it runs on the same synchronous connection
 * and the same event loop as the poll and the HTTP server. Measured against a
 * production-sized `raw_positions` (66,375 rows) on the slowest machine
 * involved — the Raspberry Pi this is developed on, comfortably slower than the
 * Fly machine — the busiest route costs 24 ms to fetch and 26 ms to derive; a
 * route with no samples costs 0.02 ms, because the new (route_id, collected_at)
 * index turns "has this route run?" into an index probe. So the worst tick is
 * ~50 ms and the typical tick is a rounding error. That is a hundredth of the
 * 5 s poll interval and two orders of magnitude below the 1.1 s stall the
 * calibrator used to cause.
 *
 * One route per tick rather than all fifteen is the whole reason those numbers
 * stay small: the same sweep done at once would be a ~200 ms freeze in the
 * middle of a poll, and there is nothing to gain from it. A sweep therefore
 * takes ~15 min, which is the right timescale anyway — service windows are
 * hours long (the night routes run 18:00-01:00), so a route gets dozens of
 * attempts every day it runs, and a route that is idle costs nothing to skip.
 */
const DERIVE_INTERVAL_MS = 60_000;

/**
 * How far back to look for samples. Matched to the raw-position retention
 * window: anything older has already been swept, so a longer window would only
 * widen the index range for no extra rows.
 */
const DERIVE_WINDOW_MS = 6 * 60 * 60_000;

/**
 * Don't bother fetching unless the route has at least this many recent samples.
 * A derivation needs one lap covering every stop, and a lap is 20-40 min of
 * 5-second polls, so anything under ~20 minutes' worth cannot produce one.
 * Checked with a COUNT against the index (sub-millisecond) so the common case —
 * a route that is not running — never touches the rows at all.
 */
const DERIVE_MIN_SAMPLES = 240;

/**
 * Ceiling on rows pulled into memory for one derivation. Six hours of 5 s polls
 * across four buses is ~17k rows, so this is not reached in normal operation;
 * it exists because retention is a best-effort hourly sweep, and a few failed
 * sweeps must not turn this job into an unbounded read.
 */
const DERIVE_MAX_SAMPLES = 20_000;

/**
 * After a route's path is stored, leave it alone for this long. A stored path
 * is already an improvement over upstream; refining it is worth doing, but not
 * every 15 minutes, and every replacement rewrites geometry the map is drawing.
 * Half an hour still gives a night route a dozen chances per service window.
 */
const DERIVE_STORE_COOLDOWN_MS = 30 * 60_000;

/** Log a tick that took longer than this — the budget above is ~50 ms. */
const DERIVE_SLOW_MS = 250;

/**
 * How soon to retry a failed static refresh, and the ceiling for the
 * exponential backoff. Without this, one flaky upstream response at boot
 * left the network as whatever SQLite happened to hold — empty on a fresh
 * volume — for the full 6 h until the next scheduled refresh.
 */
const STATIC_RETRY_BASE_MS = 60_000;
const STATIC_RETRY_MAX_MS = 15 * 60_000;

/**
 * Sanity bounds on an upstream coordinate. The feed is loosely typed (ints
 * arrive as strings, so `Number("")` → NaN sails through Zod's coercion) and
 * a GPS unit that has lost its fix reports 0/0. Either one anchors a bus to
 * whatever stop is nearest to nonsense and writes fabricated arrivals and
 * segments into the calibration tables.
 */
const MAX_ABS_LAT = 90;
const MAX_ABS_LON = 180;

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

/** One route's derived geometry, as the operator sees it. */
export interface DerivedPathRouteStat {
  routeId: number;
  shortName: string | null;
  points: number;
  stopCount: number;
  /** Stop-to-line distance as measured when this was derived. */
  medianStopM: number;
  p90StopM: number;
  maxStopM: number;
  /** Re-measured against the stop list in force now; null if the route is gone. */
  currentMedianStopM: number | null;
  currentP90StopM: number | null;
  lengthM: number;
  /** Legs that cannot be drawn along this line — the decisive measure. */
  traceFailures: number;
  busId: number;
  sampleCount: number;
  derivedAt: number;
  ageHours: number;
  /** What upstream's published polyline offers instead, for comparison. */
  upstreamPoints: number | null;
  upstreamMedianStopM: number | null;
  upstreamP90StopM: number | null;
  upstreamTraceFailures: number | null;
}

export interface DerivedPathStats {
  /** Routes in the network, and how many of them have a derived path stored. */
  routes: number;
  derived: number;
  /** Ticks that got as far as looking at a route, and ticks that stored one. */
  runs: number;
  stores: number;
  lastRunAt: number | null;
  lastRunMs: number | null;
  maxRunMs: number;
  paths: DerivedPathRouteStat[];
}

export interface CollectorOptions {
  upstream?: UpstreamClient;
  logger?: Logger;
}

/**
 * Long-lived orchestrator. Owns the in-memory `TransitNetwork` (via a
 * `NetworkRef` so static refreshes can swap topology atomically) and the
 * per-bus `BusState` map. Runs five independent timers:
 *
 *  - poll        every 5 s   — fetch buses, run detector, persist events
 *  - calibrate   every 5 min — recompute segment/dwell stats from SQLite
 *  - static      every 6 h   — refresh stops/routes from upstream
 *  - retention   every 1 h   — batched-delete old raw_positions
 *  - derive      every 1 min — one route's geometry from observed positions
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
  /**
   * Per-vehicle maps, both keyed by *track key* rather than by upstream's
   * `bus_id` — see `trackKeyFor` in the detector for why the id is not an
   * identity. `livePositions` shares the key so that a bus whose id is
   * reissued replaces its own map entry instead of appearing twice: keyed by
   * id, the retired entry lingered for the full 120 s live TTL and the map
   * drew two markers with the same fleet number. Three of the 15 reissues in
   * a 6.6 h production replay had the new id appear inside that TTL.
   */
  private readonly states = new Map<string, BusState>();
  private readonly livePositions = new Map<string, BusPosition>();
  /** Names seen carried by two live ids at once, cumulative. */
  private contendedNameEvents = 0;

  private readonly upsertStopStmt: Database.Statement;
  private readonly upsertRouteStmt: Database.Statement;
  private readonly patchDwellStmt: Database.Statement;
  private readonly trimStmts = new Map<string, Database.Statement>();
  private readonly countRouteSamplesStmt: Database.Statement;
  private readonly selectRouteSamplesStmt: Database.Statement;

  /**
   * Route geometry derived from observed GPS, best-so-far per route.
   *
   * Loaded from `derived_paths` at construction and only ever added to or
   * upgraded — never cleared. That is deliberate and load-bearing: a route can
   * only be derived while it is running, and `raw_positions` is swept after six
   * hours, so for most of the day most routes have nothing to derive from. If
   * this map tracked "what can we derive right now" instead of "the best we
   * have ever derived", every night route's geometry would vanish each morning.
   */
  private readonly derivedPathsByRoute: Map<number, StoredPath>;
  private readonly pathStore: PathStore;
  /** Round-robin position in the route list — one route considered per tick. */
  private deriveCursor = 0;
  /** Per-route "don't try again before" for routes whose path was just stored. */
  private readonly deriveNextAttemptAt = new Map<number, number>();
  /**
   * Which static refresh a route's stored path was last checked against. The
   * check below (has upstream's published path overtaken ours?) only has a new
   * answer when the topology has been refreshed, so this reduces it from every
   * tick to once per route per six hours.
   *
   * A counter rather than `lastStaticRefreshAt`: two refreshes inside the same
   * millisecond are indistinguishable by timestamp, and the failure mode is
   * silent — the check is skipped and the route keeps a path upstream has
   * overtaken.
   */
  private readonly deriveValidatedGeneration = new Map<number, number>();
  private deriveRuns = 0;
  private deriveStores = 0;
  private deriveLastAt: number | null = null;
  private deriveLastMs: number | null = null;
  private deriveMaxMs = 0;

  private pollHandle?: NodeJS.Timeout;
  private calibrateHandle?: NodeJS.Timeout;
  private staticHandle?: NodeJS.Timeout;
  private retentionHandle?: NodeJS.Timeout;
  private deriveHandle?: NodeJS.Timeout;

  private lastStaticRefreshAt = 0;
  /** Bumped by every successful static refresh; see deriveValidatedGeneration. */
  private staticGeneration = 0;
  /**
   * True from the moment `runPoll` starts until it finishes, including across
   * every `await`. The poll timer fires every 5 s but the upstream fetch is
   * allowed 10 s, so under upstream latency two or three `runPoll` bodies
   * would otherwise be in flight at once. They all mutate the same `states`
   * and `livePositions` maps *after* resuming from their awaits, so a slow
   * poll's continuation could apply a stale observation on top of a newer
   * one — resetting a bus's `enteredAt`/`nearestStopId` anchor and emitting
   * bogus `segment` and `dwell` rows straight into the calibration tables.
   * The corruption is silent and permanent; the samples outlive the outage.
   */
  private pollInFlight = false;
  /** Ticks dropped because the previous poll was still running. */
  private pollSkipped = 0;
  private staticRefreshInFlight = false;
  // Last successfully fetched service banners; kept on fetch failure so a
  // flaky upstream never blanks a live construction notice.
  private announcementsList: Announcement[] = [];
  private announcementsHandle: ReturnType<typeof setInterval> | null = null;
  private staticRetryHandle: NodeJS.Timeout | undefined;
  private staticRetryDelayMs = STATIC_RETRY_BASE_MS;
  /** Upstream rows rejected by `sanitizeObservations`, cumulative. */
  private droppedObservations = 0;
  /** Last collectedAt stamp handed to observations; enforces strict order. */
  private lastObservationStampMs = 0;
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
    //
    // Matched on the dwell's `anchorBusId` — the id in force when the bus
    // ARRIVED — not on the id reporting now. Upstream reissues a bus's id at
    // service-block boundaries, and now that tracking survives a reissue a
    // dwell can span one; matching on the current id would silently patch
    // nothing and leave `departed_at`/`dwell_sec` null on a real visit.
    this.patchDwellStmt = this.sqlite.prepare(`
      UPDATE arrivals
      SET departed_at = @leftAt, dwell_sec = @dwellSec
      WHERE id = (
        SELECT id FROM arrivals
        WHERE bus_id = @anchorBusId AND stop_id = @stopId
          AND arrived_at <= @enteredAt
        ORDER BY arrived_at DESC LIMIT 1
      )
    `);
    // Both hit raw_positions_route_time_idx. The COUNT is the cheap gate that
    // keeps an idle route (the usual case) from ever reading a row; the fetch
    // takes the MOST RECENT samples under the cap, hence DESC — `derivePath`
    // sorts each bus's trace by time itself, so the row order here is free.
    this.countRouteSamplesStmt = this.sqlite.prepare(
      "SELECT COUNT(*) AS n FROM raw_positions WHERE route_id = ? AND collected_at >= ?",
    );
    this.selectRouteSamplesStmt = this.sqlite.prepare(
      "SELECT bus_id AS busId, lat, lon, collected_at AS collectedAt " +
        "FROM raw_positions WHERE route_id = ? AND collected_at >= ? " +
        "ORDER BY collected_at DESC LIMIT ?",
    );
    this.pathStore = new PathStore(this.sqlite);
    this.derivedPathsByRoute = this.pathStore.loadAll();

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
    // Deliberately not run once at startup: boot already does a static refresh
    // and a full calibration before the health check can pass, and the first
    // sweep costs nothing to wait a minute for.
    this.deriveHandle = setInterval(() => this.runDerivePaths(), DERIVE_INTERVAL_MS);
    void this.refreshAnnouncements();
    this.announcementsHandle = setInterval(
      () => void this.refreshAnnouncements(),
      ANNOUNCEMENTS_INTERVAL_MS,
    );
    for (const h of [
      this.pollHandle,
      this.calibrateHandle,
      this.staticHandle,
      this.retentionHandle,
      this.deriveHandle,
      this.announcementsHandle,
    ]) {
      h?.unref();
    }

    void this.runPoll();
    this.logger.info("collector.started");
  }

  stop(): void {
    for (const h of [
      this.pollHandle,
      this.calibrateHandle,
      this.staticHandle,
      this.retentionHandle,
      this.deriveHandle,
      this.announcementsHandle,
    ]) {
      if (h) clearInterval(h);
    }
    this.cancelStaticRetry();
    this.logger.info("collector.stopped");
  }

  // -- Tick handlers ---------------------------------------------------------

  private async runPoll(): Promise<void> {
    if (this.pollInFlight) {
      // Never silent: a rising `skipped` is the only signal that upstream
      // latency has crossed the poll interval, which is the sole condition
      // under which we deliberately lose samples.
      this.pollSkipped++;
      this.logger.warn("collector.poll_skipped_overlap", {
        skippedTotal: this.pollSkipped,
        inFlightForMs: Date.now() - this.lastPollAttemptAt,
      });
      return;
    }
    this.pollInFlight = true;
    // Record the attempt first so liveness reflects "the loop is firing",
    // not "upstream is healthy". Deliberately NOT updated on a skipped tick:
    // if a fetch ever wedges past its AbortSignal, /healthz should go stale
    // and let Fly restart us, rather than report a healthy loop that is in
    // fact stuck behind one hung request.
    this.lastPollAttemptAt = Date.now();
    try {
      let buses: RawBus[];
      try {
        buses = await this.upstream.buses();
      } catch (err) {
        this.logUpstreamError("poll", err);
        return;
      }
      if (this.upstream.lastDroppedRows > 0) {
        this.droppedObservations += this.upstream.lastDroppedRows;
        this.logger.warn("collector.upstream_rows_dropped", {
          dropped: this.upstream.lastDroppedRows,
          kept: buses.length,
        });
      }

      // Persistence + detector can throw (SQLite locked/full, bad geometry). A
      // single bad tick must never reject the poll promise — that would surface
      // as an unhandledRejection and could take the whole process down.
      try {
        // Strictly monotonic: two polls CAN complete within one millisecond
        // (observed in tests on fast machines; possible in prod under a burst
        // of catch-up ticks), and everything downstream that orders
        // observations by collectedAt treats a timestamp tie as staleness.
        // Sub-millisecond skew is harmless; an unorderable pair is not.
        const now = Math.max(Date.now(), this.lastObservationStampMs + 1);
        this.lastObservationStampMs = now;
        const observations = this.sanitizeObservations(buses, now);

        // Prune on every tick, not only on ticks that carried observations.
        // Upstream returns `[]` overnight when nothing is running, and the
        // pruning used to live inside `updateLivePositions`, which those
        // ticks skip — so the maps held whatever the last bus of the day
        // left behind until the next morning.
        this.pruneStale(now);

        if (observations.length === 0) return;

        this.persistRawPositions(observations);
        // One plan per poll, shared by both per-vehicle maps so their keys can
        // never diverge — `updateLivePositions` reads `states` by the same key.
        const plan = planTracks(observations);
        if (plan.contendedNames.size > 0) {
          this.contendedNameEvents += plan.contendedNames.size;
          this.logger.warn("collector.bus_name_contended", {
            names: [...plan.contendedNames],
            total: this.contendedNameEvents,
          });
        }
        reconcileTracks(this.livePositions, plan);
        const events = stepMany(this.ref.get(), this.states, observations, plan);
        if (events.length > 0) this.persistEvents(events);
        this.updateLivePositions(observations, plan);
      } catch (err) {
        this.logger.error("collector.poll_process_failed", {
          error: (err as Error).message,
        });
      }
    } finally {
      this.pollInFlight = false;
    }
  }

  /**
   * Turn raw upstream rows into observations we're willing to act on.
   *
   * Three failure modes this closes, all of which otherwise reach the
   * calibration tables:
   *
   *  1. **Non-finite numbers.** `RawBusSchema` coerces strings with
   *     `z.string().transform(Number)` and never refines the result, so `""`,
   *     `"null"` or `"n/a"` parse cleanly to `NaN`. A NaN `busId` binds as
   *     SQL NULL against a NOT NULL column: the insert throws and the whole
   *     tick — every other bus included — is lost.
   *  2. **Null island.** A GPS unit with no fix reports 0/0. That is finite,
   *     so it survives every type check, anchors to whichever stop is
   *     "nearest" to the Gulf of Guinea, and emits arrivals and segments.
   *  3. **Duplicate bus ids in one payload.** Two rows for the same bus share
   *     a `collectedAt`, so the detector sees a 0-second transition and
   *     records a segment with `travelSec: 0`.
   *
   * Dropping the offending row (rather than rejecting the payload in Zod)
   * keeps one bad bus from costing us the other fifteen.
   */
  private sanitizeObservations(buses: readonly RawBus[], now: number): BusObservation[] {
    const byBusId = new Map<number, BusObservation>();
    let dropped = 0;
    for (const b of buses) {
      if (
        !Number.isFinite(b.id) ||
        !Number.isFinite(b.route) ||
        !Number.isFinite(b.lat) ||
        !Number.isFinite(b.lon) ||
        Math.abs(b.lat) > MAX_ABS_LAT ||
        Math.abs(b.lon) > MAX_ABS_LON ||
        (b.lat === 0 && b.lon === 0)
      ) {
        dropped++;
        continue;
      }
      byBusId.set(b.id, {
        busId: b.id,
        busName: b.name,
        routeId: b.route,
        lat: b.lat,
        lon: b.lon,
        // Heading is cosmetic, so normalize a bad one rather than discard an
        // otherwise-good position — but never let NaN into the JSON payload.
        heading: Number.isFinite(b.heading) ? b.heading : 0,
        lastStopId:
          b.lastStop != null && Number.isFinite(b.lastStop) ? b.lastStop : null,
        collectedAt: now,
      });
    }
    if (dropped > 0) {
      this.droppedObservations += dropped;
      this.logger.warn("collector.observations_dropped", {
        dropped,
        droppedTotal: this.droppedObservations,
        received: buses.length,
      });
    }
    return [...byBusId.values()];
  }

  /**
   * Age out per-bus state. Runs every poll, including ticks where upstream
   * gave us nothing — see the call site in `runPoll`.
   */
  private pruneStale(now: number): void {
    const liveCutoff = now - LIVE_BUS_TTL_MS;
    for (const [key, b] of this.livePositions) {
      if (b.collectedAt < liveCutoff) this.livePositions.delete(key);
    }
    const stateCutoff = now - STATE_TTL_MS;
    for (const [key, s] of this.states) {
      if (s.lastObservedAt < stateCutoff) this.states.delete(key);
    }
  }

  /**
   * Counters for observability. `skipped` rising means upstream latency has
   * exceeded the 5 s poll interval; `droppedObservations` rising means the
   * feed is emitting rows we refuse to trust.
   */
  pollStats(): { skipped: number; droppedObservations: number; knownBuses: number } {
    return {
      skipped: this.pollSkipped,
      droppedObservations: this.droppedObservations,
      knownBuses: this.livePositions.size,
    };
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

  private updateLivePositions(
    observations: readonly BusObservation[],
    // `runPoll` passes the plan it already shared with `stepMany`, so both
    // maps key identically. Defaulted for callers that only have observations.
    plan: TrackPlan = planTracks(observations),
  ): void {
    for (const o of observations) {
      const key = plan.keys.get(o.busId) ?? o.busName;
      const state = this.states.get(key);
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
        // `stationarySince`, NOT `enteredAt`: the latter restarts whenever a
        // different stop becomes nearest, and a bus shuffling a few metres
        // while parked flips that. A rider watched "⏸ 45s" on a bus most of
        // the way through a ~10 min layover at 344 Winchester (2026-09-03),
        // which zeroed the stall credit and charged the layover twice. The
        // stationary clock only restarts on real movement. See BusState.
        ? { id: state.nearestStopId, since: state.stationarySince }
        : null;
      this.livePositions.set(key, {
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
    // Aging-out of stale buses moved to `pruneStale`, called once per poll
    // from `runPoll` — including the ticks where upstream returned nothing,
    // which never reach this method.
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

  /** The service banners Yale's own map shows. Failure keeps the last batch. */
  announcements(): readonly Announcement[] {
    return this.announcementsList;
  }

  private async refreshAnnouncements(): Promise<void> {
    try {
      const fresh = await this.upstream.announcements();
      const changed = JSON.stringify(fresh) !== JSON.stringify(this.announcementsList);
      this.announcementsList = fresh;
      if (changed) {
        // The /api/buses payload embeds these and is memoized on dataVersion().
        this.version++;
        this.logger.info("collector.announcements_changed", { count: fresh.length });
      }
    } catch {
      // Not worth a log line per failure: the endpoint answers HTML during
      // upstream deploys. The banner riders saw stays up, which is right.
    }
  }

  private async refreshStaticIfNeeded(force: boolean): Promise<void> {
    // Same overlap hazard as the poll loop: two concurrent refreshes would
    // each build a network and race to `ref.replace`, and the loser's
    // calibration work is thrown away. Far rarer (6 h timer vs. a 10 s fetch)
    // but the guard is free.
    if (this.staticRefreshInFlight) return;
    const now = Date.now();
    if (!force && now - this.lastStaticRefreshAt < STATIC_REFRESH_INTERVAL_MS) return;
    this.staticRefreshInFlight = true;
    try {
      const [stops, routes] = await Promise.all([this.upstream.stops(), this.upstream.routes()]);
      if (stops.length === 0 || routes.length === 0) {
        // An empty feed is a failure, not a refresh: keep the topology we
        // have and try again soon rather than in six hours.
        this.logger.warn("collector.static_refresh_empty", {
          stops: stops.length,
          routes: routes.length,
        });
        this.scheduleStaticRetry();
        return;
      }
      this.persistStatic(stops, routes);
      // Build fresh, run calibration into it, then swap — so the new network
      // is already calibrated when consumers start reading it.
      const rebuilt = TransitNetwork.build(stops, routes);
      calibrate(this.db, rebuilt);
      this.ref.replace(rebuilt);
      this.version++;
      this.lastStaticRefreshAt = now;
      this.staticGeneration++;
      this.cancelStaticRetry();
      this.logger.info("collector.static_refreshed", {
        stops: stops.length,
        routes: routes.length,
      });
    } catch (err) {
      this.logUpstreamError("static_refresh", err);
      this.scheduleStaticRetry();
    } finally {
      this.staticRefreshInFlight = false;
    }
  }

  /**
   * Retry a failed static refresh on a backoff instead of waiting out the
   * 6 h cadence. On a fresh volume the network is built from an empty SQLite,
   * so one flaky response at boot used to mean six hours of "no routes, no
   * stops, no plans" — a total outage that looked like a healthy process.
   */
  private scheduleStaticRetry(): void {
    if (this.staticRetryHandle) return;
    const delay = this.staticRetryDelayMs;
    this.logger.warn("collector.static_retry_scheduled", { delayMs: delay });
    this.staticRetryHandle = setTimeout(() => {
      this.staticRetryHandle = undefined;
      this.staticRetryDelayMs = Math.min(delay * 2, STATIC_RETRY_MAX_MS);
      void this.refreshStaticIfNeeded(true);
    }, delay);
    this.staticRetryHandle.unref();
  }

  private cancelStaticRetry(): void {
    if (this.staticRetryHandle) {
      clearTimeout(this.staticRetryHandle);
      this.staticRetryHandle = undefined;
    }
    this.staticRetryDelayMs = STATIC_RETRY_BASE_MS;
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

  /**
   * Try to derive one route's geometry from the positions buses actually
   * reported, and keep it if it is the best we have seen.
   *
   * Upstream publishes a `path` per route and several are far too coarse to
   * draw a rider's ride on: Orange Night ships 37 points for a 9.5 km loop, so
   * a stop sits a median 97 m from its own route line. The samples this
   * collector already writes put the same stops a median 24 m away. This is the
   * job that turns the second number into something the map can serve.
   *
   * Three properties matter more than the arithmetic:
   *
   *  - **It is opportunistic, and most attempts find nothing.** A route can
   *    only be derived while it is running. At 03:00 fourteen of fifteen routes
   *    have no samples at all, and the correct behaviour is to skip them
   *    cheaply and leave what is already stored completely alone.
   *  - **It never trades down.** A candidate must beat upstream
   *    (`isBetterThanUpstream`) *and* beat the incumbent by a clear margin
   *    (`shouldReplacePath`) before anything is written.
   *  - **It cannot throw.** This runs in a bare `setInterval`, where an
   *    exception is an uncaughtException and takes the process with it. A
   *    failed tick is simply a tick that derived nothing.
   */
  private runDerivePaths(): void {
    const startedAt = Date.now();
    let routeId: number | undefined;
    try {
      const net = this.ref.get();
      // Sorted so the sweep order is stable across topology refreshes; the
      // cursor then means the same thing from one tick to the next.
      const routeIds = [...net.routes.keys()].sort((a, b) => a - b);
      if (routeIds.length === 0) return;

      // Exactly one route per tick, in a fixed rotation. That bound is the
      // whole cost argument, so the cooldown below is a reason to do nothing
      // with this tick — never a reason to take a second route instead.
      routeId = routeIds[this.deriveCursor % routeIds.length]!;
      this.deriveCursor = (this.deriveCursor + 1) % routeIds.length;

      const route = net.routes.get(routeId);
      if (!route) return;
      // Two different views of the same stops, and both are needed. The
      // distance figures want each place once; the traced-leg count wants the
      // sequence verbatim, duplicates included, because on routes 9 and 10 the
      // second visit to a West Campus stop IS the route.
      const stops = uniqueRouteStopCoords(net, route);
      const sequence = routeStopSequence(net, route);
      if (stops.length < 2) return;

      // Before the cooldown, not after: a route that has just been derived is
      // precisely the one that would otherwise sit on a superseded path for
      // half an hour. Self-gated on the static generation, so it is a map
      // lookup on all but one tick per route per topology refresh.
      this.dropIfUpstreamOvertook(routeId, route, stops, sequence);

      // Recently stored: leave it alone. Refining a path that is already an
      // improvement is worth doing, but not every quarter of an hour.
      if ((this.deriveNextAttemptAt.get(routeId) ?? 0) > startedAt) return;

      this.deriveRuns++;
      const cutoff = startedAt - DERIVE_WINDOW_MS;
      const { n } = this.countRouteSamplesStmt.get(routeId, cutoff) as { n: number };
      if (n < DERIVE_MIN_SAMPLES) return;

      const samples = this.selectRouteSamplesStmt.all(
        routeId,
        cutoff,
        DERIVE_MAX_SAMPLES,
      ) as Sample[];

      const derived = derivePath(samples, stops);
      // null is the ordinary answer for a route that ran only partially inside
      // the window — half a lap covers no complete loop.
      if (!derived) return;
      if (!isBetterThanUpstream(derived, route.path, stops, sequence)) return;

      const stored = this.derivedPathsByRoute.get(routeId);
      if (!shouldReplacePath(stored, derived, stops, sequence, startedAt)) return;

      const row = toStoredPath(routeId, derived, sequence, samples.length, startedAt);
      this.pathStore.put(row);
      this.derivedPathsByRoute.set(routeId, row);
      // The fat /api/buses payload embeds route_paths and is memoized on
      // dataVersion(). Without this bump riders keep the upstream line until
      // something else moves the version — and the version is driven by live
      // positions, which is exactly what a route that has just stopped running
      // (the moment its best lap becomes derivable) no longer produces.
      this.version++;
      this.deriveStores++;
      this.deriveNextAttemptAt.set(routeId, startedAt + DERIVE_STORE_COOLDOWN_MS);
      this.logger.info("collector.path_derived", {
        routeId,
        shortName: route.shortName,
        points: row.pointCount,
        medianStopM: row.medianStopM,
        p90StopM: row.p90StopM,
        maxStopM: row.maxStopM,
        lengthM: row.lengthM,
        traceFailures: row.traceFailures,
        samples: row.sampleCount,
        replacedP90StopM: stored ? stored.p90StopM : null,
        upstreamPoints: route.path?.length ?? 0,
        upstreamTraceFailures: route.path ? traceFailures(route.path, sequence) : null,
      });
    } catch (err) {
      this.logger.error("collector.derive_path_failed", {
        routeId: routeId ?? null,
        error: (err as Error).message,
      });
    } finally {
      const ms = Date.now() - startedAt;
      this.deriveLastAt = startedAt;
      this.deriveLastMs = ms;
      if (ms > this.deriveMaxMs) this.deriveMaxMs = ms;
      if (ms > DERIVE_SLOW_MS) {
        // The event loop this blocks also runs the 5 s poll and every rider's
        // request, so a tick drifting past its budget is worth seeing before it
        // becomes the calibrator's 1.1 s stall again.
        this.logger.warn("collector.derive_path_slow", { routeId: routeId ?? null, ms });
      }
    }
  }

  /**
   * Give a route back to upstream if upstream's published path has overtaken
   * ours.
   *
   * Everything else here is one-directional — a derivation is only ever
   * replaced by a better derivation — which would leave a stale line in place
   * forever if upstream ever fixed the geometry this feature exists to work
   * around. Checked once per route per static refresh rather than per tick,
   * because a 6-hourly topology fetch is the only thing that can change the
   * answer.
   */
  private dropIfUpstreamOvertook(
    routeId: number,
    route: Route,
    stops: readonly LatLon[],
    sequence: readonly LatLon[],
  ): void {
    const stored = this.derivedPathsByRoute.get(routeId);
    if (!stored) return;
    if (this.deriveValidatedGeneration.get(routeId) === this.staticGeneration) return;
    this.deriveValidatedGeneration.set(routeId, this.staticGeneration);
    if (!upstreamNowBeats(stored, route.path, stops, sequence)) return;
    this.pathStore.drop(routeId);
    this.derivedPathsByRoute.delete(routeId);
    this.version++;
    this.logger.info("collector.path_derived_dropped", {
      routeId,
      shortName: route.shortName,
      reason: "upstream_overtook",
      upstreamPoints: route.path?.length ?? 0,
    });
  }

  /**
   * Best-so-far derived geometry per route, for callers that would otherwise
   * draw upstream's polyline. Empty for a route we have never caught running.
   */
  derivedPaths(): ReadonlyMap<number, readonly [number, number][]> {
    const out = new Map<number, readonly [number, number][]>();
    for (const [routeId, p] of this.derivedPathsByRoute) out.set(routeId, p.path);
    return out;
  }

  /**
   * Operator view of the derivation job: what it has stored, how good each
   * stored line is against the stops it has to serve, and what upstream's
   * polyline would have scored instead. Admin-only — it is a diagnostic, and it
   * re-measures every stored path against the live stop list, which is a few
   * thousand distance calculations rather than a lookup.
   */
  derivedPathStats(): DerivedPathStats {
    const net = this.ref.get();
    const paths: DerivedPathRouteStat[] = [];
    const finite = (x: number): number | null => (Number.isFinite(x) ? Math.round(x) : null);
    for (const [routeId, p] of this.derivedPathsByRoute) {
      const route = net.routes.get(routeId);
      const stops = route ? uniqueRouteStopCoords(net, route) : [];
      const sequence = route ? routeStopSequence(net, route) : [];
      const upstream = route?.path;
      const fit = stops.length ? stopFitM(p.path, stops) : null;
      const upFit = upstream && stops.length ? stopFitM(upstream, stops) : null;
      paths.push({
        routeId,
        shortName: route?.shortName ?? null,
        points: p.pointCount,
        stopCount: p.stopCount,
        // As stored (what it measured when derived) and as it stands today —
        // the two differ once upstream moves a stop.
        medianStopM: p.medianStopM,
        p90StopM: p.p90StopM,
        maxStopM: p.maxStopM,
        currentMedianStopM: fit ? finite(fit.medianM) : null,
        currentP90StopM: fit ? finite(fit.p90M) : null,
        lengthM: p.lengthM,
        traceFailures: sequence.length >= 2 ? traceFailures(p.path, sequence) : p.traceFailures,
        busId: p.busId,
        sampleCount: p.sampleCount,
        derivedAt: p.derivedAt,
        ageHours: Math.round((Date.now() - p.derivedAt) / 3_600_000),
        upstreamPoints: upstream?.length ?? null,
        upstreamMedianStopM: upFit ? finite(upFit.medianM) : null,
        upstreamP90StopM: upFit ? finite(upFit.p90M) : null,
        upstreamTraceFailures:
          upstream && sequence.length >= 2 ? traceFailures(upstream, sequence) : null,
      });
    }
    paths.sort((a, b) => a.routeId - b.routeId);
    return {
      routes: net.routes.size,
      derived: this.derivedPathsByRoute.size,
      runs: this.deriveRuns,
      stores: this.deriveStores,
      lastRunAt: this.deriveLastAt,
      lastRunMs: this.deriveLastMs,
      maxRunMs: this.deriveMaxMs,
      paths,
    };
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
        anchorBusId: e.anchorBusId,
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

/**
 * A route's stop coordinates, de-duplicated.
 *
 * Routes 9 and 10 visit the same stop twice for the West Campus out-and-back.
 * The sequence has to stay verbatim everywhere it describes travel, but here we
 * are only asking "how far is each stop from this line", and a stop listed
 * twice is one place — counting it twice would weight it double in the median
 * and inflate the coverage requirement inside `derivePath` for nothing.
 */
function uniqueRouteStopCoords(net: TransitNetwork, route: Route): LatLon[] {
  const seen = new Set<number>();
  const out: LatLon[] = [];
  for (const id of route.stops) {
    if (seen.has(id)) continue;
    seen.add(id);
    const stop = net.stops.get(id);
    if (stop) out.push({ lat: stop.lat, lon: stop.lon });
  }
  return out;
}

/**
 * A route's stop coordinates in order, duplicates included.
 *
 * The counterpart to `uniqueRouteStopCoords`, and the distinction matters:
 * routes 9 and 10 visit West Campus stops twice, and it is precisely that
 * second visit the traced-leg count is checking the line can draw.
 */
function routeStopSequence(net: TransitNetwork, route: Route): LatLon[] {
  const out: LatLon[] = [];
  for (const id of route.stops) {
    const stop = net.stops.get(id);
    if (stop) out.push({ lat: stop.lat, lon: stop.lon });
  }
  return out;
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
