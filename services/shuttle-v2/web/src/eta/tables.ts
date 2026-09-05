/**
 * The calibration tables as distributions, one stand per stop and one drive
 * per hop, with a prior for every thin or missing cell.
 *
 * Sources, in order of preference:
 *
 *  stand at stop j   `dwells[j].q`  (ten quantiles of `stop_visits.stand_sec`,
 *                    passes as 0 s — so P(stop) is the mass at zero), shrunk
 *                    toward the ordinary-stop prior with weight qn / (qn + k).
 *  drive on hop i    `segments["A-B"].dq` (ten quantiles of `legs.leg_sec`,
 *                    drive + hold), shrunk toward the route's pace prior:
 *                    chord metres x `pace.spm` (seconds per chord metre, route
 *                    pooled). Missing dq: the served `drive` median as a
 *                    lognormal; missing that: the arrival-to-arrival `avg`/`sd`
 *                    as a lognormal that INCLUDES the stand at A (a hop is paid
 *                    once, so no stand is added at A in that case); missing
 *                    everything: chord / BUS_SPEED_M_S.
 *
 * `pace` travels inside `segmentTimes[route]["__pace"]` (a reserved key, see
 * v1compat.ts) so the client signature did not have to change.
 */

import { haversineMeters, type LatLon } from "../geo";
import { BUS_SPEED_M_S } from "../routes";
import { cdf, fromQuantiles, lognormalMeanSd, quantile, shrinkToward, type Dist } from "./dist";

/** Shrinkage weight for drives, as in calibrator/shrinkage.ts: the pace prior is the same shape scaled. */
export const SHRINK_K = 8;
/**
 * Shrinkage weight for stands. Deliberately small: the ordinary-stop prior is
 * a different SHAPE from a layover's, and mixing a quarter of it into 344
 * Winchester's table (n = 25 at k = 8) pulled that stop's median from ~300 s
 * to 184 s — the whole layover under-priced by two minutes on the recorded
 * pass. At k = 2 a cell of 25 keeps 93% of its own shape and a cell of 2
 * leans half on the prior, which is what the prior is for.
 */
export const STAND_SHRINK_K = 2;

/** A stop whose typical (median) stand reaches this is a layover: hopPricing.ts APPROACH_LAYOVER_MIN_SEC. */
export const LAYOVER_MIN_SEC = 120;

/**
 * The ordinary-stop prior: a bus rolls through one stop in eight and otherwise
 * stands 15-60 s (docs/departure-derivation.md, MIN_DWELL_SEC 15 s). Ten knots
 * at (i + 0.5) / 10, the calibrator's convention.
 */
export const DEFAULT_STAND_Q: readonly number[] = [0, 15, 17, 20, 24, 29, 35, 44, 60, 95];

export interface StopModel {
  stand: Dist;
  /** Median stand reaches LAYOVER_MIN_SEC. */
  layover: boolean;
  /** True when a served table (any n) backed this. */
  measured: boolean;
}

export interface HopModel {
  drive: Dist;
  /** The served number was arrival-to-arrival and already holds the stand at A. */
  includesStand: boolean;
  measured: boolean;
}

export interface RouteTables {
  stops: StopModel[];
  hops: HopModel[];
}

export interface SegmentLike { avg: number; sd?: number | undefined; n: number; drive?: number | undefined; driveN?: number | undefined; dq?: number[] | undefined; dqn?: number | undefined; spm?: number[] | undefined }
export interface DwellLike { med: number; n: number; q?: number[] | undefined; qn?: number | undefined }

export const PACE_KEY = "__pace";

const DEFAULT_STAND = fromQuantiles(DEFAULT_STAND_Q);

function ascending(q: readonly number[] | undefined): q is number[] {
  if (!q || q.length < 3) return false;
  for (let i = 1; i < q.length; i++) if (!(q[i]! >= q[i - 1]!) || !Number.isFinite(q[i]!)) return false;
  return Number.isFinite(q[0]!);
}

export function stopModel(dwell: DwellLike | undefined): StopModel {
  if (!dwell || !ascending(dwell.q)) return { stand: DEFAULT_STAND, layover: false, measured: false };
  const n = dwell.qn ?? dwell.n;
  const emp = fromQuantiles(dwell.q);
  const stand = shrinkToward(emp, DEFAULT_STAND, Math.max(0, n), STAND_SHRINK_K);
  return { stand, layover: quantile(stand, 0.5) >= LAYOVER_MIN_SEC, measured: true };
}

export function hopModel(seg: SegmentLike | undefined, chordM: number, pace: readonly number[] | undefined): HopModel {
  const paceOk = ascending(pace) && chordM > 0;
  const prior: Dist | null = paceOk
    ? fromQuantiles(pace.map((s) => s * chordM))
    : null;
  if (seg && ascending(seg.dq)) {
    const emp = fromQuantiles(seg.dq);
    const n = seg.dqn ?? seg.driveN ?? seg.n;
    return { drive: prior ? shrinkToward(emp, prior, Math.max(0, n), SHRINK_K) : emp, includesStand: false, measured: true };
  }
  if (seg && seg.drive !== undefined && Number.isFinite(seg.drive) && seg.drive >= 0) {
    const emp = lognormalMeanSd(Math.max(5, seg.drive), Math.max(5, seg.drive * 0.35));
    const n = seg.driveN ?? seg.n;
    return { drive: prior ? shrinkToward(emp, prior, Math.max(0, n), SHRINK_K) : emp, includesStand: false, measured: true };
  }
  if (prior) return { drive: prior, includesStand: false, measured: false };
  if (seg && seg.n >= 1 && Number.isFinite(seg.avg) && seg.avg > 0) {
    return { drive: lognormalMeanSd(seg.avg, seg.sd ?? seg.avg * 0.5), includesStand: true, measured: true };
  }
  const guess = Math.max(30, chordM / BUS_SPEED_M_S);
  return { drive: lognormalMeanSd(guess, guess * 0.5), includesStand: false, measured: false };
}

export function buildTables(
  stops: readonly number[],
  stopCoords: Record<number, LatLon>,
  routeSegs: Record<string, SegmentLike>,
  routeDwells: Record<string, DwellLike>,
): RouteTables {
  const N = stops.length;
  const pace = routeSegs[PACE_KEY]?.spm;
  const out: RouteTables = { stops: [], hops: [] };
  for (let i = 0; i < N; i++) {
    const a = stops[i]!, b = stops[(i + 1) % N]!;
    out.stops.push(stopModel(routeDwells[String(a)]));
    const ca = stopCoords[a], cb = stopCoords[b];
    const chord = ca && cb ? haversineMeters(ca, cb) : 0;
    out.hops.push(hopModel(routeSegs[`${a}-${b}`], chord, pace));
  }
  return out;
}

/** P(the bus stops at all) from the stand distribution's mass at zero. */
export function pStop(m: StopModel): number {
  return 1 - cdf(m.stand, 0);
}
