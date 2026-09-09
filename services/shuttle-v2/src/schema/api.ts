import { z } from "zod";

// Wall-clock epoch milliseconds. Aliased so the API surface reads cleanly
// and so a future switch to ISO strings only touches one place.
export const EpochMsSchema = z.number().int().nonnegative();
export type EpochMs = z.infer<typeof EpochMsSchema>;

export const LatLonSchema = z.object({
  lat: z.number(),
  lon: z.number(),
});
export type LatLon = z.infer<typeof LatLonSchema>;

export const StopSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  lat: z.number(),
  lon: z.number(),
});
export type Stop = z.infer<typeof StopSchema>;

export const RouteSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  shortName: z.string(),
  color: z.string(),
  stops: z.array(z.number().int()),
  // [lat, lon] polyline from upstream. Optional because older imports may lack it.
  path: z.array(z.tuple([z.number(), z.number()])).optional(),
  // The operator's free-text timetable ("7am - 6pm, M - F") from
  // routes_routes.php. In-memory only: the `routes` table has no column for it,
  // so a route loaded from the DB fallback simply lacks it. Parsed by
  // server/publishedHours.ts into the `route_hours` riders are shown.
  description: z.string().optional(),
  // Upstream's "in service right now" flag from routes_routes.php. In-memory
  // only, like `description`; refreshed every 5 min by the collector and
  // served as `route_active` so the client can say "not running today"
  // from the operator's own word rather than from inference.
  active: z.boolean().optional(),
  // Upstream's own stop order, kept when `stops` had to be REPAIRED against
  // upstream's own polyline (src/network/alignStops.ts). In-memory only, like
  // `description`: the network runs on the repaired order — the detector, the
  // legs it bills and the hop keys the calibrator fills — while `/api/buses`
  // keeps publishing this one, so the map and the planner still draw and list
  // exactly what upstream sent. Absent on every route the line already
  // describes, which is fourteen of fifteen.
  publishedStops: z.array(z.number().int()).optional(),
});
export type Route = z.infer<typeof RouteSchema>;

export const BusPositionSchema = z.object({
  busId: z.number().int(),
  busName: z.string(),
  routeId: z.number().int(),
  lat: z.number(),
  lon: z.number(),
  heading: z.number(),
  lastStopId: z.number().int().nullable(),
  // Derived state: bus is currently dwelling at this stop since this timestamp.
  atStopId: z.number().int().nullable(),
  atStopSince: EpochMsSchema.nullable(),
  /**
   * The detector's stationary clock (`BusState.stationarySince`), published
   * WHETHER OR NOT the bus is at a stop.
   *
   * `atStopSince` only exists inside `AT_STOP_MAX_M` (75 m) of a stop, so a
   * bus taking its layover SHORT of the marker publishes nothing at all and
   * the client can only read it as driving. Red #310 did exactly that on
   * 2026-09-04: 7 min at rest 147 m short of 344 Winchester, then ~2 min
   * at the marker itself. See `APPROACH_ZONE_M` in web/src/hopPricing.ts.
   *
   * This is the same clock, unfiltered. Off a stop it measures time since the
   * bus last moved more than `STATIONARY_RADIUS_M` (125 m) from where it came
   * to rest, so a bus in motion resets it every few polls and only a genuine
   * rest lets it grow.
   */
  stationarySince: EpochMsSchema.nullable().optional(),
  /** The stop the stationary clock is pinned to, or null when resting off-marker. */
  stationaryStopId: z.number().int().nullable().optional(),
  /**
   * When the bus's reported fix last changed (detector.ts `MOVED_M`).
   *
   * `stationarySince` is pinned to a stop and therefore keeps running while a
   * bus drives through that stop's zone; this one is pinned to nothing, so it
   * is the only thing in the payload that says whether the bus is moving right
   * now. A client seeing its first frame has no history to infer it from.
   */
  lastMovedAt: EpochMsSchema.nullable().optional(),
  collectedAt: EpochMsSchema,
});
export type BusPosition = z.infer<typeof BusPositionSchema>;

/** Optional /api/buses stop prior; the current visit's outcome is never served. */
export const StandingForecastPriorSchema = z.object({
  route_id: z.number().int(), route_pattern_id: z.string(),
  canonical_stop_ids: z.array(z.number().int()).min(2),
  stop_id: z.number().int(), stop_index: z.number().int().nonnegative(),
  observed_visit_start_at: EpochMsSchema, previous_departed_at: EpochMsSchema,
  history_available_at: EpochMsSchema, phase_slot_at: z.number().finite(),
  phase_error_q: z.array(z.number().finite()).min(3), phase_weight: z.number().finite().min(0).max(1),
  duration_dist: z.object({ xs: z.array(z.number().finite().nonnegative()).min(1),
    ps: z.array(z.number().finite().min(0).lt(1)).min(1), tail_hazard: z.number().finite().positive() }),
  fitted_at: EpochMsSchema, valid_until: EpochMsSchema,
}).refine(v => v.canonical_stop_ids[v.stop_index] === v.stop_id &&
  v.previous_departed_at < v.observed_visit_start_at && v.history_available_at <= v.observed_visit_start_at &&
  v.fitted_at <= v.observed_visit_start_at && v.valid_until > v.observed_visit_start_at &&
  v.phase_error_q.every((x, i, q) => i === 0 || x >= q[i - 1]!) &&
  v.duration_dist.xs.length === v.duration_dist.ps.length &&
  v.duration_dist.xs.every((x, i, q) => i === 0 || x > q[i - 1]!) &&
  v.duration_dist.ps.every((p, i, q) => i === 0 || p >= q[i - 1]!), "inconsistent standing forecast");
export type StandingForecastPrior = z.infer<typeof StandingForecastPriorSchema>;

// /api/buses response: live snapshot plus everything a client needs to render
// the map without a second round-trip.
export const LiveSnapshotSchema = z.object({
  buses: z.array(BusPositionSchema),
  stops: z.array(StopSchema),
  routes: z.array(RouteSchema),
  serverTime: EpochMsSchema,
});
export type LiveSnapshot = z.infer<typeof LiveSnapshotSchema>;

// Trip planning ----------------------------------------------------------------

export const WalkLegSchema = z.object({
  mode: z.literal("walk"),
  // Null when walking from the user's coordinates rather than a stop
  // (start and end legs); a stop id when transferring between stops.
  fromStopId: z.number().int().nullable(),
  toStopId: z.number().int().nullable(),
  meters: z.number().nonnegative(),
  seconds: z.number().nonnegative(),
});

export const RideLegSchema = z.object({
  mode: z.literal("ride"),
  routeId: z.number().int(),
  boardStopId: z.number().int(),
  alightStopId: z.number().int(),
  // The specific live bus the planner expects to board, when known.
  busName: z.string().nullable(),
  waitSec: z.number().nonnegative(),
  rideSec: z.number().nonnegative(),
  // 90% confidence interval around (waitSec + rideSec).
  confidenceLowSec: z.number().nonnegative(),
  confidenceHighSec: z.number().nonnegative(),
});

export const PlanLegSchema = z.discriminatedUnion("mode", [
  WalkLegSchema,
  RideLegSchema,
]);
export type PlanLeg = z.infer<typeof PlanLegSchema>;

export const PlanSchema = z.object({
  totalSec: z.number().nonnegative(),
  confidenceLowSec: z.number().nonnegative(),
  confidenceHighSec: z.number().nonnegative(),
  legs: z.array(PlanLegSchema),
  // For UI: which dimension makes this plan stand out on the frontier.
  badge: z
    .enum(["fastest", "fewest-transfers", "least-walking", "walk-only"])
    .nullable(),
});
export type Plan = z.infer<typeof PlanSchema>;

export const PlanRequestSchema = z.object({
  from: LatLonSchema,
  to: LatLonSchema,
  // Null or absent means "now". Future timestamps trigger schedule-based
  // estimation (no live buses). This was `.nullable()` alone, which made the
  // field *required* — the handler's `departAt ?? now()` fallback was dead
  // code and a body that simply omitted the key got a 400.
  departAt: EpochMsSchema.nullable().optional(),
});
export type PlanRequest = z.infer<typeof PlanRequestSchema>;

export const PlanResponseSchema = z.object({
  plans: z.array(PlanSchema),
  // Routes that geographically connect from→to but aren't currently
  // running. Surfaced so the UI can say "the Grocery TJ route goes
  // there, next active Sat 10:00 AM" instead of just showing Walk.
  potentialRoutes: z.array(
    z.object({
      routeId: z.number().int(),
      boardStopId: z.number().int(),
      alightStopId: z.number().int(),
      nextActiveAt: EpochMsSchema.nullable(),
    }),
  ),
});
export type PlanResponse = z.infer<typeof PlanResponseSchema>;

// Accuracy --------------------------------------------------------------------

export const AccuracyBucketSchema = z.object({
  stopsAhead: z.union([z.number().int(), z.literal("10+")]),
  n: z.number().int().nonnegative(),
  medianAbsErrorSec: z.number(),
  p90AbsErrorSec: z.number(),
  p95AbsErrorSec: z.number(),
});
export type AccuracyBucket = z.infer<typeof AccuracyBucketSchema>;

export const AccuracyResponseSchema = z.object({
  windowDays: z.number().int().positive(),
  overall: AccuracyBucketSchema.omit({ stopsAhead: true }),
  byStopsAhead: z.array(AccuracyBucketSchema),
});
export type AccuracyResponse = z.infer<typeof AccuracyResponseSchema>;

// Reports ---------------------------------------------------------------------

export const ReportSubmitSchema = z.object({
  kind: z.enum(["issue", "feedback"]),
  routeId: z.number().int().nullable(),
  body: z.string().min(1).max(2000),
  context: z.unknown().optional(),
});
export type ReportSubmit = z.infer<typeof ReportSubmitSchema>;
