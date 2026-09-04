import { sql } from "drizzle-orm";
import { index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

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

/**
 * One row per pass of a stop by a bus: the DEPARTURE instant the detector never
 * had, with the evidence it rests on. Derived by `src/collector/departure.ts`
 * from the same positions and the detector's own stop-pinned clock; the
 * `arrivals`/`segments` rows are untouched and still measure what they always
 * did (arrival to arrival, twice).
 *
 * `stand_sec = departed_at − arrived_at` is the time the bus stood at the
 * stop — the quantity `arrivals.dwell_sec` is often mistaken for and is not
 * (`docs/eta-error-budget.md`). `outcome` keeps a skipped stop apart from a
 * stop: a 0 s stand folded into a stop's distribution biases every quantile
 * down, and the low tail is what a conditional-rest table reads first.
 * `pinned_at` is production's `at_stop_since`, so a consumer that conditions
 * on `r = now − at_stop_since` can measure on that clock instead.
 *
 * `(anchor_bus_id, stop_id, anchored_at)` joins the `arrivals` row the pass
 * belongs to. `stop_index` is the position in the route sequence — the
 * identity on the West Campus out-and-backs, where a stop id occurs twice.
 *
 * Retained with `arrivals` (90 d): a few hundred rows a day.
 */
export const stopVisits = sqliteTable(
  "stop_visits",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    busId: integer("bus_id").notNull(),
    busName: text("bus_name").notNull(),
    anchorBusId: integer("anchor_bus_id").notNull(),
    routeId: integer("route_id").notNull(),
    stopId: integer("stop_id").notNull(),
    stopIndex: integer("stop_index").notNull(),
    anchoredAt: integer("anchored_at", { mode: "timestamp_ms" }).notNull(),
    pinnedAt: integer("pinned_at", { mode: "timestamp_ms" }),
    arrivedAt: integer("arrived_at", { mode: "timestamp_ms" }),
    departedAt: integer("departed_at", { mode: "timestamp_ms" }),
    standSec: real("stand_sec"),
    insideSec: real("inside_sec"),
    outcome: text("outcome", { enum: ["stopped", "passed", "unresolved"] }).notNull(),
    how: text("how", { enum: ["far", "next", "clock", "gap"] }),
    confidence: real("confidence"),
    // Evidence — the observation, not only the decision.
    firstStepM: real("first_step_m"),
    steps: integer("steps").notNull(),
    farM: real("far_m"),
    confirmSec: real("confirm_sec"),
    restPolls: integer("rest_polls").notNull(),
    shuffles: integer("shuffles").notNull(),
    firstMovedAt: integer("first_moved_at", { mode: "timestamp_ms" }),
    lastAtRestAt: integer("last_at_rest_at", { mode: "timestamp_ms" }),
    closestM: real("closest_m").notNull(),
    dow: integer("dow").notNull(),
    hour: integer("hour").notNull(),
  },
  (t) => ({
    routeStopTimeIdx: index("stop_visits_route_stop_time_idx").on(t.routeId, t.stopId, t.anchoredAt),
    // Time-leading, for the retention sweep.
    timeIdx: index("stop_visits_time_idx").on(t.anchoredAt),
  }),
);

/**
 * One row per hop, kerb to kerb: from the departure at `from_stop_id` to the
 * first rest at `to_stop_id`, with the seconds spent stopped MID-leg split out.
 * `drive_sec + hold_sec = leg_sec`. A hop's proration may scale `drive_sec`;
 * it must never scale the stand at the origin, which is what `segments.
 * travel_sec` bundles in. `to_pinned_at` is `at_stop_since` at the far end,
 * for a consumer on that clock. Retained with `segments` (90 d).
 */
export const legs = sqliteTable(
  "legs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    busId: integer("bus_id").notNull(),
    busName: text("bus_name").notNull(),
    routeId: integer("route_id").notNull(),
    fromStopId: integer("from_stop_id").notNull(),
    fromIndex: integer("from_index").notNull(),
    toStopId: integer("to_stop_id").notNull(),
    toIndex: integer("to_index").notNull(),
    hops: integer("hops").notNull(),
    departedAt: integer("departed_at", { mode: "timestamp_ms" }).notNull(),
    arrivedAt: integer("arrived_at", { mode: "timestamp_ms" }).notNull(),
    toPinnedAt: integer("to_pinned_at", { mode: "timestamp_ms" }),
    legSec: real("leg_sec").notNull(),
    holdSec: real("hold_sec").notNull(),
    driveSec: real("drive_sec").notNull(),
    holds: integer("holds").notNull(),
    reached: integer("reached", { mode: "boolean" }).notNull(),
    dow: integer("dow").notNull(),
    hour: integer("hour").notNull(),
  },
  (t) => ({
    routeHopTimeIdx: index("legs_route_hop_time_idx").on(t.routeId, t.fromStopId, t.toStopId, t.departedAt),
    timeIdx: index("legs_time_idx").on(t.departedAt),
  }),
);

/**
 * What the CLIENT actually displayed — a prediction about a bus, with no
 * viewer attached.
 *
 * ── The privacy shape (read this before adding a column) ──────────────────
 *
 * A row is a statement about a VEHICLE: "bus #310's ETA to stop 48 was being
 * shown as 5 min at 08:12:30, by the bundle `a1b2c3`". It carries no anonymous
 * id, no IP, no user agent, no coordinates, no origin, no destination and no
 * session key — there is nothing here two rows could be joined on to make one
 * browser's trail, which is the property `daily_actives` buys by storing one
 * row per (day, id) and nothing else.
 *
 * Three things keep it that way, and each is load-bearing:
 *
 * 1. **The quantity does not depend on the rider.** `computeUpcomingArrivals`
 *    prices (bus → stop); the rider's location enters the app one layer up, in
 *    `pickLiveArrival`'s catchability rule and the walk legs. Logging at the
 *    arrivals layer means a row cannot encode where anyone was standing, only
 *    which stop was on some screen.
 * 2. **The server DEDUPLICATES before writing.** `(bus_id, to_stop_id,
 *    predicted_at, surface)` is UNIQUE and `predicted_at` is quantised to
 *    `PREDICTION_BUCKET_MS`, so thirty riders watching one stop on one screen
 *    in one bucket produce ONE row. A row therefore means "at least one client somewhere had
 *    this on screen", never "a rider was here" — and the write volume is
 *    bounded by buses x stops x time rather than by traffic.
 * 3. **First writer wins.** `INSERT OR IGNORE`, so a late poster cannot
 *    overwrite a value another client already established for a bucket.
 *
 * `client_build` is the hash out of the bundle filename the browser is running
 * (`assets/index-<hash>.js`). It is the same for everybody on a deploy, so it
 * identifies the CODE, not the reader — and it is the column that stops the
 * failure this table exists to end: stability numbers measured against a
 * client that had not shipped in months, and a hotfix's before/after credited
 * to the wrong PR. Every row says which bundle produced it.
 *
 * Pair with `arrivals` on (bus_name, route_id, stop_id) — `bus_name` is the
 * identity, `bus_id` is reissued per service block (see the data-quality
 * invariants). The `bus_id` columns are kept because the two pre-existing
 * accuracy readers join on them.
 */
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
    /** Bundle hash the reading came from; null for rows written before it existed. */
    clientBuild: text("client_build"),
    /**
     * WHICH SCREEN showed it: `trip` (the trip card), `ride` (the on-bus
     * countdown to the alight stop), `card` (a route card on the Map tab).
     *
     * It exists because of a change, not a curiosity. Until 2026-09-04 the
     * route cards ran a SEPARATE ETA estimator, and this table deliberately
     * logged only the trip card — pooling two estimators in one column is the
     * inference error the table was built to stop. Merging them onto
     * `computeUpcomingArrivals` removes that error and creates a subtler one:
     * the route cards report a much larger and differently shaped population
     * (every line, every stop, mostly far-horizon) than the trip card (one
     * board stop a rider chose). Pooled silently, the median would move
     * because the MIX changed, and it would read as the estimator changing.
     *
     * So the surface is part of the dedup key, not a decoration: one row per
     * (vehicle, stop, bucket, surface), and every accuracy query says which
     * population it means. Rows written before this column existed are `trip`,
     * which is what they were.
     *
     * It does not weaken the privacy shape above. A row still says "at least
     * one client somewhere had this on screen", now with which screen; it is a
     * property of the APP, deduplicated across every browser, and there is
     * still nothing two rows can be joined on to make one browser's trail.
     */
    surface: text("surface").notNull().default("trip"),
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
    // THE dedup key, and therefore half the privacy argument above: one row per
    // (vehicle, stop, quantised instant) no matter how many browsers report it.
    shownUniq: uniqueIndex("predictions_shown_uniq").on(
      t.busId,
      t.toStopId,
      t.predictedAt,
      t.surface,
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
 * What riders type into the destination box — the words only, never who typed
 * them.
 *
 * The point is to fix lookup with evidence instead of guesses: which searches
 * find NOTHING (a place to add — "one6three" and "ice rink" were both found
 * this way, by hand, from rider reports), and which are common enough that
 * their matching is worth tuning.
 *
 * The privacy shape is deliberate and is the reason this table can exist at
 * all. A destination is the most revealing thing this app ever sees — a
 * clinic, somebody's home address — so a row is keyed by (ET day, normalised
 * query) and carries COUNTS. There is no anon id, no IP, no time of day and
 * no session: two searches by one rider and one search by two riders are the
 * same row, and nothing here can reconstruct one person's route. That is a
 * stricter promise than `daily_actives` keeps, and it should stay stricter.
 *
 * Swept at 30 days, shorter than the 90 the rider counts keep, because a
 * month is long enough to spot a missing place and there is no reason to hold
 * the words longer than that.
 */
export const searchTerms = sqliteTable(
  "search_terms",
  {
    /** ET calendar day, "YYYY-MM-DD" — the same service day the rest uses. */
    day: text("day").notNull(),
    /** Lower-cased, whitespace-collapsed query. Capped at 60 chars. */
    q: text("q").notNull(),
    /** How many times it was searched that day. */
    n: integer("n").notNull().default(0),
    /** How many of those returned nothing at all — the "add this place" signal. */
    zero: integer("zero").notNull().default(0),
  },
  (t) => ({ pk: primaryKey({ columns: [t.day, t.q] }) }),
);

export type DbSearchTerm = typeof searchTerms.$inferSelect;

/**
 * Browsers that belong to the OPERATOR, so the dashboard can tell a rider's
 * report from the operator's own.
 *
 * Deliberately NOT `excluded_anon_ids`: the operator's phone is a real rider
 * and must keep counting in the usage numbers. This table answers a different
 * question — "did somebody other than me write in?" — which on 2026-09-03 had
 * exactly one true answer out of 69 reports, and finding that out took a
 * by-hand grouping of ids and IP addresses.
 *
 * Seeded from SHUTTLE_OPERATOR_ANON_IDS (comma-separated) at startup, so a
 * redeploy cannot forget who the operator is, and extendable at runtime via
 * POST /api/stats/operator.
 */
export const operatorAnonIds = sqliteTable("operator_anon_ids", {
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
export type DbOperatorAnonId = typeof operatorAnonIds.$inferSelect;
export type DbDerivedPath = typeof derivedPaths.$inferSelect;

/**
 * Findings from the rider canary (`scripts/rider-canary.mjs`), shipped here so
 * the operator can see them.
 *
 * The canary runs on the Pi and wrote only to a local JSONL file. On
 * 2026-09-04 it caught the ETA defect the operator had been chasing —
 * `Red  eta-jump: "now, then 66 min" -> "in 7, 25 min" in 15 s` at 07:37 ET —
 * and the finding sat in that file until he hit the same bug himself and asked
 * whether the canary was even watching. The detection worked; nothing read it.
 * This table is the missing half: `scripts/canary-ship.mjs` POSTs each run's
 * SUMMARY (never its samples or page text) to /api/canary/runs, /stats renders
 * it, and the server decides which findings are worth waking someone for.
 *
 * One row per run, and small by construction: a run is ~40 KB in the local log
 * and ~1 KB here, because everything that made it big — 100 samples, two 3 KB
 * page dumps per jump — is diagnostic detail that belongs on the machine that
 * captured it. What travels is what the operator reads.
 */
export const canaryRuns = sqliteTable(
  "canary_runs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /**
     * `<startedAt>-<line>`, unique. The shipper is a cursor over an
     * append-only log and a re-ship after a failed POST must not double a
     * finding, so re-sending a run is a no-op rather than a duplicate row.
     */
    runKey: text("run_key").notNull().unique(),
    startedAt: integer("started_at").notNull(),
    endedAt: integer("ended_at"),
    /** Route label as the rider sees it — "Blue Day", not a route id. */
    line: text("line").notNull(),
    tripFrom: text("trip_from"),
    tripTo: text("trip_to"),
    /** 1 when the run raised no finding at all. */
    ok: integer("ok").notNull(),
    /** 1 when a bus actually reached the board stop while the canary watched. */
    arrived: integer("arrived").notNull(),
    watchedMin: real("watched_min"),
    /** Countdown readings parsed. Under 2 the run proves nothing. */
    readings: integer("readings").notNull().default(0),
    reversals: integer("reversals").notNull().default(0),
    catastrophic: integer("catastrophic").notNull().default(0),
    worstDriftSec: real("worst_drift_sec"),
    firstSightMissSec: integer("first_sight_miss_sec"),
    /** `[{kind, detail}]` — the sentences the operator reads, capped. */
    failuresJson: text("failures_json").notNull().default("[]"),
    /**
     * `[{atMs, fromSec, driftSec, from, to, announced}]` — the catastrophic
     * countdown transitions, kept STRUCTURED rather than as prose because the
     * escalation rule turns on `fromSec` (how imminent the bus was said to be)
     * and a regex over a sentence is not a rule anyone can test.
     */
    jumpsJson: text("jumps_json").notNull().default("[]"),
    /** When this run was pushed out of band, if it was. Null = never. */
    alertedAt: integer("alerted_at"),
    /** When the same line was later seen healthy, so the alert could close. */
    resolvedAt: integer("resolved_at"),
    receivedAt: integer("received_at").notNull(),
  },
  (t) => ({
    // The dashboard reads "the last N hours, newest first" and the escalation
    // rule reads "this line's recent runs" — both lead with time.
    timeIdx: index("canary_runs_time_idx").on(t.startedAt),
    lineTimeIdx: index("canary_runs_line_time_idx").on(t.line, t.startedAt),
  }),
);

export type DbCanaryRun = typeof canaryRuns.$inferSelect;
