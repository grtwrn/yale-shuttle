import { z } from "zod";

/** Local-only archive interchange. It contains evidence, never executable model code. */
export const STOP_STUDY_MAX_BYTES = 25 * 1024 * 1024;
const time = z.number().finite().min(0).max(4_102_444_800_000);
const seconds = z.number().finite();
const id = z.number().int().nonnegative();
const text = z.string().max(500);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const at = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(at) && new Date(at).toISOString().slice(0, 10) === value;
}, "Invalid calendar date");
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const position = z.object({
  at: time, lat: z.number().finite().min(-90).max(90),
  lon: z.number().finite().min(-180).max(180), busId: id,
  distanceM: seconds.nonnegative().nullable(), gapSec: seconds.nonnegative().nullable(),
}).strict();

export const StopStudyPredictionSchema = z.object({
  model: text,
  arm: z.enum(["baseline", "candidate"]),
  issuedAt: time,
  target: z.literal("departure"),
  targetStopId: id,
  predictedTotalSec: seconds.nonnegative(),
  predictedRemainingSec: seconds.nonnegative().nullable(),
  actualRemainingSec: seconds.nullable(),
  displayKind: z.enum(["total", "remaining"]),
  displaySec: seconds.nonnegative(),
  observedStartAt: time,
  /** First in this arm's unsampled associated display rows, before pairing. */
  firstCapturedDisplay: z.boolean(),
  occurrenceAgreement: z.boolean(),
  downstream: z.object({
    targetStopId: id,
    targetStopIndex: id,
    targetArrivalId: text,
    targetAt: time,
    quantileLevels: z.array(z.number().finite().min(0).max(1)).min(1).max(100),
    // Saved ETA bounds may be negative. Preserve them rather than changing evidence.
    quantilesSec: z.array(seconds).min(1).max(100),
    actualRemainingSec: seconds,
  }).strict().superRefine((value, ctx) => {
    if (value.quantileLevels.length !== value.quantilesSec.length)
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "ETA levels and values differ in length" });
    if (value.quantileLevels.some((q, i) => i > 0 && q <= value.quantileLevels[i - 1]!))
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "ETA levels must increase" });
    if (value.quantilesSec.some((q, i) => i > 0 && q < value.quantilesSec[i - 1]!))
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "ETA values must not decrease" });
  }).optional(),
}).strict();

export const StopStudyVisitSchema = z.object({
  id: text,
  day,
  routeId: id,
  routePatternId: text,
  stopId: id,
  stopIndex: id,
  busId: id,
  busKey: text,
  busName: text,
  anchoredAt: time,
  pinnedAt: time.nullable(),
  recordedPinnedAt: time.nullable(),
  arrivedAt: time.nullable(),
  departedAt: time.nullable(),
  recordedStandSec: seconds.nonnegative().nullable(),
  pinnedStandSec: seconds.nonnegative().nullable(),
  outcome: text,
  how: text.nullable(),
  confidence: z.number().finite().min(0).max(1).nullable(),
  qualityNotes: z.array(text).max(30),
  previousDepartureAt: time.nullable(),
  loopSec: seconds.nonnegative().nullable(),
  labelStatus: z.enum(["complete", "censored"]),
  leftCensored: z.boolean(),
  rightCensored: z.boolean(),
  originalEpisodeId: text.nullable(),
  predictions: z.array(StopStudyPredictionSchema).max(20_000),
  positions: z.array(position).max(20_000).optional(),
}).strict();

export const StopStudySchema = z.object({
  schemaVersion: z.literal(1),
  source: z.literal("saved_study"),
  title: text,
  generatedAt: time,
  timezone: z.literal("America/New_York"),
  days: z.array(day).min(1).max(366),
  routes: z.array(z.object({ routeId: id, name: text, shortName: text }).strict()).max(1_000),
  stops: z.array(z.object({ stopId: id, name: text,
    lat: z.number().finite().min(-90).max(90).nullable(),
    lon: z.number().finite().min(-180).max(180).nullable(),
  }).strict()).max(10_000),
  visits: z.array(StopStudyVisitSchema).max(50_000),
  /** Normalized GPS avoids duplicating each fix across overlapping visit windows. */
  positionTracks: z.array(z.object({ routeId: id, busId: id, busKey: text,
    positions: z.array(position).max(100_000),
  }).strict()).max(1_000).optional(),
  provenance: z.object({
    exporterVersion: z.literal("stop-study-v1"),
    inputs: z.array(z.object({ role: text, name: text, sha256: hash }).strict()).min(1).max(1_000),
    sourceHashes: z.record(hash),
    sampling: z.object({
      forecastIntervalSec: z.number().finite().nonnegative(),
      positionIntervalSec: z.number().finite().nonnegative().nullable(),
      pairedQueriesOnly: z.literal(true),
      firstPairedDisplayPreserved: z.literal(true),
      description: text,
    }).strict(),
    counts: z.record(z.number().int().nonnegative()),
    warnings: z.array(text).max(100),
    context: z.object({ cohort: text, training: text, comparison: text }).strict().optional(),
    arrivalSelection: z.object({ kind: z.enum(["next_served", "target_stop"]), targetStopId: id.nullable() }).strict().optional(),
  }).strict(),
}).strict().superRefine((study, ctx) => {
  const visits = new Set<string>();
  const targets = new Map<string, string>();
  let predictions = 0;
  const tracks = new Set<string>();
  let positionCount = 0;
  for (const track of study.positionTracks ?? []) {
    const key = `${track.routeId}:${track.busId}:${track.busKey}`;
    if (tracks.has(key)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Duplicate GPS track ${key}` });
    tracks.add(key); positionCount += track.positions.length;
    if (track.positions.some((p, i) => p.busId !== track.busId || (i > 0 && p.at <= track.positions[i - 1]!.at)))
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `GPS identity/time order differs in ${key}` });
  }
  if (positionCount > 300_000) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Study exceeds 300,000 GPS fixes" });
  for (const visit of study.visits) {
    if (visits.has(visit.id)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Duplicate visit ${visit.id}` });
    visits.add(visit.id);
    if (!study.days.includes(visit.day))
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Visit date missing from study ${visit.id}` });
    if (visit.labelStatus === "complete" && visit.pinnedAt !== null && visit.departedAt !== null && visit.pinnedAt > visit.departedAt)
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Complete visit pin follows departure ${visit.id}` });
    if ((visit.labelStatus === "censored" || visit.leftCensored || visit.rightCensored) && visit.pinnedStandSec !== null)
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Censored visit cannot have a complete total ${visit.id}` });
    const keys = new Set<string>();
    const first = new Map<string, number>();
    const earliest = new Map<string, number>();
    for (const prediction of visit.predictions) {
      const key = `${prediction.issuedAt}:${prediction.arm}`;
      if (keys.has(key)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Duplicate forecast ${visit.id}:${key}` });
      keys.add(key);
      earliest.set(prediction.arm, Math.min(earliest.get(prediction.arm) ?? Infinity, prediction.issuedAt));
      if (prediction.firstCapturedDisplay) {
        if (first.has(prediction.arm)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Duplicate first display ${visit.id}:${prediction.arm}` });
        first.set(prediction.arm, prediction.issuedAt);
      }
      if (prediction.observedStartAt > prediction.issuedAt)
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Observed start follows prediction ${visit.id}` });
      if (prediction.targetStopId !== visit.stopId)
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Forecast stop differs from visit ${visit.id}` });
      if (prediction.downstream) {
        const d = prediction.downstream;
        const identity = `${visit.routeId}:${visit.busKey}:${d.targetAt}:${d.targetStopId}:${d.targetStopIndex}`;
        const previous = targets.get(d.targetArrivalId);
        if (previous !== undefined && previous !== identity)
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Conflicting arrival identity ${d.targetArrivalId}` });
        targets.set(d.targetArrivalId, identity);
      }
    }
    for (const [arm, at] of first) if (at !== earliest.get(arm))
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `First display flag is on a later row ${visit.id}:${arm}` });
    predictions += visit.predictions.length;
  }
  if (predictions > 100_000) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Study exceeds 100,000 forecasts" });
});

export type StopStudy = z.infer<typeof StopStudySchema>;
export type StopStudyVisit = z.infer<typeof StopStudyVisitSchema>;
export type StopStudyPrediction = z.infer<typeof StopStudyPredictionSchema>;

export function validateStopStudy(input: unknown): StopStudy {
  return StopStudySchema.parse(input);
}

export function parseStopStudyJson(json: string): StopStudy {
  if (new TextEncoder().encode(json).byteLength > STOP_STUDY_MAX_BYTES)
    throw new Error("Study exceeds the 25 MiB import limit");
  return validateStopStudy(JSON.parse(json));
}
