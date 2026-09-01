import { sql } from "drizzle-orm";
import { index, integer, primaryKey, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

// Static network state, refreshed from upstream every ~6h.
export const stops = sqliteTable("stops", {
  id: integer("id").primaryKey(),
  name: text("name").notNull(),
  lat: real("lat").notNull(),
  lon: real("lon").notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const routes = sqliteTable("routes", {
  id: integer("id").primaryKey(),
  name: text("name").notNull(),
  shortName: text("short_name").notNull(),
  color: text("color").notNull(),
  // Stop ids in loop order, JSON-encoded.
  stopsJson: text("stops_json").notNull(),
  // Upstream's road-following polyline as a flat [lat, lon, lat, lon, ...] array.
  // The trip planner slices this per segment instead of asking OSRM.
  pathJson: text("path_json"),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

// Raw GPS polls, append-only. Retained for ~6h.
export const rawPositions = sqliteTable(
  "raw_positions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    busId: integer("bus_id").notNull(),
    busName: text("bus_name").notNull(),
    routeId: integer("route_id").notNull(),
    lat: real("lat").notNull(),
    lon: real("lon").notNull(),
    heading: real("heading").notNull(),
    lastStopId: integer("last_stop_id"),
    collectedAt: integer("collected_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => ({
    busTimeIdx: index("raw_positions_bus_time_idx").on(t.busId, t.collectedAt),
    // Time-leading. The hourly retention sweep probes
    // `WHERE collected_at < ? LIMIT n` with no bus_id, so the composite above
    // can't serve it and SQLite falls back to a full covering scan.
    timeIdx: index("raw_positions_time_idx").on(t.collectedAt),
  }),
);

// Derived events: a bus reached (and later left) a stop. One row per visit.
export const arrivals = sqliteTable(
  "arrivals",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    busId: integer("bus_id").notNull(),
    busName: text("bus_name").notNull(),
    routeId: integer("route_id").notNull(),
    stopId: integer("stop_id").notNull(),
    arrivedAt: integer("arrived_at", { mode: "timestamp_ms" }).notNull(),
    departedAt: integer("departed_at", { mode: "timestamp_ms" }),
    dwellSec: real("dwell_sec"),
    dow: integer("dow").notNull(),
    hour: integer("hour").notNull(),
  },
  (t) => ({
    routeStopTimeIdx: index("arrivals_route_stop_time_idx").on(
      t.routeId,
      t.stopId,
      t.arrivedAt,
    ),
    busTimeIdx: index("arrivals_bus_time_idx").on(t.busId, t.arrivedAt),
    // Time-leading. Serves the calibrator's dwell window
    // (`WHERE arrived_at >= ?`), the accuracy endpoints' arrival-match range
    // (`arrived_at BETWEEN ? AND ?`) and the retention sweep — none of which
    // constrain route_id/stop_id/bus_id, so every composite above degrades to
    // a full scan.
    timeIdx: index("arrivals_time_idx").on(t.arrivedAt),
  }),
);

// Derived: travel time between adjacent stops on a route.
// Source of truth for the segment-time estimator.
export const segments = sqliteTable(
  "segments",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    busId: integer("bus_id").notNull(),
    busName: text("bus_name").notNull(),
    routeId: integer("route_id").notNull(),
    fromStopId: integer("from_stop_id").notNull(),
    toStopId: integer("to_stop_id").notNull(),
    travelSec: real("travel_sec").notNull(),
    startedAt: integer("started_at", { mode: "timestamp_ms" }).notNull(),
    dow: integer("dow").notNull(),
    hour: integer("hour").notNull(),
  },
  (t) => ({
    routeSegTimeIdx: index("segments_route_seg_time_idx").on(
      t.routeId,
      t.fromStopId,
      t.toStopId,
      t.startedAt,
    ),
    routeSegDowHourIdx: index("segments_route_seg_dow_hour_idx").on(
      t.routeId,
      t.fromStopId,
      t.toStopId,
      t.dow,
      t.hour,
    ),
    // Time-leading. Serves the calibrator's 30-day segment window
    // (`WHERE started_at >= ?`) and the retention sweep. Both filter on
    // started_at alone, which is the *trailing* column of the composite above.
    timeIdx: index("segments_time_idx").on(t.startedAt),
  }),
);

// Every prediction we serve, for after-the-fact accuracy scoring.
export const predictionsLog = sqliteTable(
  "predictions_log",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    busId: integer("bus_id").notNull(),
    busName: text("bus_name").notNull(),
    routeId: integer("route_id").notNull(),
    fromStopId: integer("from_stop_id").notNull(),
    toStopId: integer("to_stop_id").notNull(),
    stopsAhead: integer("stops_ahead").notNull(),
    predictedSec: real("predicted_sec").notNull(),
    predictedLowSec: real("predicted_low_sec").notNull(),
    predictedHighSec: real("predicted_high_sec").notNull(),
    predictedAt: integer("predicted_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => ({
    busToTimeIdx: index("predictions_bus_to_time_idx").on(
      t.busId,
      t.toStopId,
      t.predictedAt,
    ),
    // Time-leading. Both accuracy readers (`/api/accuracy` and the v1-compat
    // variant) scan `WHERE predicted_at >= ?` with no bus_id — a request-path
    // query, so it must not be a full scan.
    timeIdx: index("predictions_time_idx").on(t.predictedAt),
  }),
);

// User-submitted bug reports and feedback. Triage queue for the operator.
export const reports = sqliteTable("reports", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
  kind: text("kind", { enum: ["issue", "feedback"] }).notNull(),
  routeId: integer("route_id"),
  body: text("body").notNull(),
  // Snapshot of viewport / current plan / accuracy state at submit time.
  context: text("context"),
  clientIp: text("client_ip"),
  status: text("status", { enum: ["open", "addressed", "wontfix"] })
    .notNull()
    .default("open"),
  note: text("note"),
});

/**
 * One row per (ET calendar day, anonymous client) — the whole basis for
 * "how many people use this".
 *
 * Deliberately the least data that answers the question:
 *   - `anonId` is a random value the browser generates for itself and keeps in
 *     localStorage. It is not derived from anything about the person, and it is
 *     never stored next to an IP, a user agent, a location or a report.
 *   - No timestamps beyond the day. Two rows tell you someone was active on two
 *     days; they cannot reconstruct when, where, or what they looked at.
 *
 * IP addresses were considered and rejected: they are personal data, this app
 * just finished removing them from a public endpoint, and on a campus where
 * everyone shares wifi NAT they would badly undercount anyway.
 *
 * The primary key makes the write idempotent, so a rider polling every 5 s for
 * an hour still produces exactly one row.
 */
export const dailyActives = sqliteTable(
  "daily_actives",
  {
    // ET calendar day as "YYYY-MM-DD". ET because that is the service day the
    // rest of this schema counts in (see the dow/hour columns above).
    day: text("day").notNull(),
    anonId: text("anon_id").notNull(),
    // Depth, not identity. First/last sighting bound time-in-app for that day;
    // the counters distinguish "opened it once" from "used it all week".
    // Retention itself needs none of these — a row per (day, id) already says
    // whether a browser came back.
    firstSeenMs: integer("first_seen_ms"),
    lastSeenMs: integer("last_seen_ms"),
    polls: integer("polls").notNull().default(0),
    // Destination searches: a deliberate action, unlike the automatic poll.
    searches: integer("searches").notNull().default(0),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.day, t.anonId] }),
    // Counting a day, and sweeping old days, both scan by day alone.
    dayIdx: index("daily_actives_day_idx").on(t.day),
  }),
);

/**
 * Browsers whose activity should never appear in the usage numbers.
 *
 * Verification harnesses drive a real browser against the live site, so they
 * mint real ids and would otherwise show up as riders — and worse, as riders
 * who never return, dragging retention toward zero for a month. Excluding
 * rather than deleting keeps it reversible and auditable: the rows stay, the
 * counts ignore them, and `note` records why.
 *
 * Scripts use the fixed id in TEST_ANON_ID (scripts/testId.mjs) so a new
 * harness is excluded automatically instead of needing a cleanup afterwards.
 */
export const excludedAnonIds = sqliteTable("excluded_anon_ids", {
  anonId: text("anon_id").primaryKey(),
  note: text("note"),
  addedMs: integer("added_ms")
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
});

export type DbStop = typeof stops.$inferSelect;
export type DbRoute = typeof routes.$inferSelect;
export type DbRawPosition = typeof rawPositions.$inferSelect;
export type DbArrival = typeof arrivals.$inferSelect;
export type DbSegment = typeof segments.$inferSelect;
export type DbPredictionLog = typeof predictionsLog.$inferSelect;
export type DbReport = typeof reports.$inferSelect;
export type DbDailyActive = typeof dailyActives.$inferSelect;
export type DbExcludedAnonId = typeof excludedAnonIds.$inferSelect;
