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
    // Route-leading. The path-derivation job asks for one route's recent
    // samples; neither index above can answer that, so it degraded to a scan of
    // every row in the retention window (~66k in production) even for a route
    // that has not run all day. With this index an idle route costs 0.02 ms
    // instead of 21 ms, and the busiest route's fetch drops 36 ms -> 24 ms.
    // The cost is one more index to maintain on the 5-second insert batch,
    // measured at 0.10 ms for 16 rows.
    routeTimeIdx: index("raw_positions_route_time_idx").on(t.routeId, t.collectedAt),
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
  // Triage priority, set by the operator or the feedback bot — never by the
  // submitting rider (self-declared urgency would make everything urgent).
  priority: text("priority", { enum: ["urgent", "normal", "nice_to_have"] })
    .notNull()
    .default("normal"),
  note: text("note"),
  // The reporter's anonymous browser id (see daily_actives above), captured so
  // a rider can later see the status of THEIR OWN reports via /api/my-reports.
  // Nullable: older rows, and riders with storage disabled, have none.
  anonId: text("anon_id"),
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

/**
 * Route geometry derived from where buses actually drove — one row per route,
 * the survivor of everything the raw samples that produced it cannot outlive.
 *
 * Upstream publishes a `path` per route and several are far too coarse to draw
 * with: Orange Night ships 37 points for a 9.5 km loop, so a stop sits a median
 * 97 m from its own route line. `raw_positions` holds thousands of real points
 * along the actual roads for the same loop — but it is swept after 6 h, so a
 * derivation has to be persisted or it dies with its inputs, and every restart
 * would redraw the map from upstream's polyline again.
 *
 * That retention window is also why this table has to *accumulate*. A route can
 * only be derived while it is running: Green and Purple stop by ~19:30, the
 * night routes run 18:00–01:00, Grocery only at weekends. At any instant most
 * routes have no usable samples at all, so the job keeps the best result it has
 * ever seen and simply leaves the rest alone until their buses come back out.
 *
 * The quality columns are what make "best" decidable without re-deriving:
 * `medianStopM` / `maxStopM` are how far this route's stops sit from this line,
 * which is the one property the drawing code needs, and they let a later
 * candidate be compared against the incumbent (re-measured against the current
 * stop list, so an upstream stop move can't leave a stale figure standing).
 */
export const derivedPaths = sqliteTable("derived_paths", {
  // One derivation per route; the upsert makes re-derivation idempotent.
  routeId: integer("route_id").primaryKey(),
  // Simplified polyline as a JSON [[lat, lon], ...] array, matching the shape
  // `routes.path_json` already stores so both sides can be parsed identically.
  pathJson: text("path_json").notNull(),
  pointCount: integer("point_count").notNull(),
  // How many stops the quality figures below were measured over. A change here
  // means upstream reshaped the route, and the stored geometry is for a
  // different loop than the one we would draw today.
  stopCount: integer("stop_count").notNull(),
  medianStopM: real("median_stop_m").notNull(),
  // The tail, and the reason it is here: the line is used to locate each stop
  // on it, so one stop stranded 280 m away breaks that leg's geometry however
  // comfortable the median is. `derivePath` selects on this, and so does the
  // rule that decides whether a later candidate displaces this row.
  p90StopM: real("p90_stop_m").notNull(),
  maxStopM: real("max_stop_m").notNull(),
  lengthM: real("length_m").notNull(),
  // Legs of the route that could not be traced along this line when it was
  // stored — the measure the accept/replace decisions actually turn on, kept so
  // the operator can see why a path is still in place without re-deriving it.
  traceFailures: integer("trace_failures").notNull(),
  // Which vehicle's trace won. Purely diagnostic — useful when a derivation
  // looks wrong and the question is whether one bus took a detour.
  busId: integer("bus_id").notNull(),
  // How many raw samples were on the table when this was derived, and when.
  // Together they answer "is this the best we can do, or was it a thin night?"
  sampleCount: integer("sample_count").notNull(),
  derivedAt: integer("derived_at", { mode: "timestamp_ms" }).notNull(),
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
export type DbDerivedPath = typeof derivedPaths.$inferSelect;
