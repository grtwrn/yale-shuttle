import { sql } from "drizzle-orm";
import { index, integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

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

export type DbStop = typeof stops.$inferSelect;
export type DbRoute = typeof routes.$inferSelect;
export type DbRawPosition = typeof rawPositions.$inferSelect;
export type DbArrival = typeof arrivals.$inferSelect;
export type DbSegment = typeof segments.$inferSelect;
export type DbPredictionLog = typeof predictionsLog.$inferSelect;
export type DbReport = typeof reports.$inferSelect;
