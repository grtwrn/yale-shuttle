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
   * 2026-09-04: 6 min 40 s at rest 140 m short of 344 Winchester, then ~1 min
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
  collectedAt: EpochMsSchema,
});
export type BusPosition = z.infer<typeof BusPositionSchema>;

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
