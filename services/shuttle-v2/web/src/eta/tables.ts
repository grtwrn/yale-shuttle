/**
 * The calibration tables as distributions, one stand per stop and one drive
 * per hop, with a prior for every thin or missing cell — and the profile the
 * filter's kernel needs (a speed per leg, a stop probability per stop).
 *
 * Sources, in order of preference:
 *
 *  stand at stop j   `dwells[j].q`  (ten quantiles of `stop_visits.stand_sec`,
 *                    passes as 0 s — so P(stop) is the mass at zero). A stop
 *                    the route visits twice (9, 10) has its own table per
 *                    occurrence under `"<id>#<index>"`, the pooled one as the
 *                    fallback. Shrunk toward the ROUTE'S OWN pool of stops of
 *                    the same class — layover (median >= LAYOVER_MIN_SEC) or
 *                    ordinary — so a thin layover cell leans on the other
 *                    layovers' shape, not on a kerb stop's. (A hand-typed
 *                    prior of the wrong shape pulled a 3-visit layover's
 *                    median from ~420 s to 202 s — the review's finding 6.)
 *  drive on hop i    `segments["A-B"].dq` (ten quantiles of `legs.leg_sec`,
 *                    drive + hold), shrunk toward the route's pace prior:
 *                    road metres x `pace.spm` (seconds per metre, route
 *                    pooled). Missing dq: the served `drive` median as a
 *                    lognormal; missing that: the pace prior alone; missing
 *                    that too: the arrival-to-arrival `avg`/`sd` as a
 *                    lognormal that INCLUDES the stand at A. A route with no
 *                    measured hop at all is not priced by the model (index.ts
 *                    falls back to the legacy arithmetic).
 *
 * `pace` travels inside `segmentTimes[route]["__pace"]` (a reserved key, see
 * v1compat.ts) so the client signature did not have to change. Road metres
 * per hop come from the ring (`legM`), the same length the server's pace is
 * measured against.
 */

import { haversineMeters, type LatLon } from "../geo";
import { BUS_SPEED_M_S } from "../routes";
import { cdf, fromQuantiles, lognormalMeanSd, mixture, quantile, shrinkToward, type Dist } from "./dist";
import { DEFAULT_DRIVE_M_S, DEFAULT_P_STOP, type Ring } from "./ring";

/** Shrinkage weight for drives, as in calibrator/shrinkage.ts: the pace prior is the same shape scaled. */
export const SHRINK_K = 8;
/**
 * Shrinkage weight for stands toward the route's class pool: the prior's
 * effective sample size. Three: a cell of three visits leans half on its
 * class, a cell of thirty keeps 90% of its own shape.
 */
export const STAND_SHRINK_K = 3;
/** A cell needs this many visits before its own median chooses its class. */
const CLASS_MIN_N = 3;

/** A stop whose typical (median) stand reaches this is a layover: hopPricing.ts APPROACH_LAYOVER_MIN_SEC. */
export const LAYOVER_MIN_SEC = 120;

/**
 * The ordinary-stop prior of last resort, used only on a route with no stand
 * table at all: a bus rolls through one stop in eight and otherwise stands
 * 15-60 s (docs/departure-derivation.md, MIN_DWELL_SEC 15 s).
 */
export const DEFAULT_STAND_Q: readonly number[] = [0, 15, 17, 20, 24, 29, 35, 44, 60, 95];

export interface StopModel {
  stand: Dist;
  /** Median stand reaches LAYOVER_MIN_SEC. */
  layover: boolean;
  /** P(the bus stops at all) — the served share, else the table's mass above zero. */
  pStop: number;
  /** True when a served table (any n) backed this. */
  measured: boolean;
}

export interface HopModel {
  drive: Dist;
  /** The served number was arrival-to-arrival and already holds the stand at A. */
  includesStand: boolean;
  measured: boolean;
  /** Typical driving speed on the hop, m/s (road metres / median drive), for the kernel. */
  speedMps: number;
}

export interface RouteTables {
  stops: StopModel[];
  hops: HopModel[];
  /** True when at least one hop carries a measured drive: the model may price this route. */
  priced: boolean;
}

export interface SegmentLike { avg: number; sd?: number | undefined; n: number; drive?: number | undefined; driveN?: number | undefined; dq?: number[] | undefined; dqn?: number | undefined; spm?: number[] | undefined; legM?: number | undefined }
export interface DwellLike { med: number; n: number; q?: number[] | undefined; qn?: number | undefined; pstop?: number | undefined }

export const PACE_KEY = "__pace";

const DEFAULT_STAND = fromQuantiles(DEFAULT_STAND_Q);

function ascending(q: readonly number[] | undefined): q is number[] {
  if (!q || q.length < 3) return false;
  for (let i = 1; i < q.length; i++) if (!(q[i]! >= q[i - 1]!) || !Number.isFinite(q[i]!)) return false;
  return Number.isFinite(q[0]!);
}

/** The route's two class pools, each a qn-weighted mixture of its members' tables. */
export function classPools(routeDwells: Record<string, DwellLike>): { layover: Dist | null; ordinary: Dist | null } {
  const lay: [Dist, number][] = [], ord: [Dist, number][] = [];
  for (const k in routeDwells) {
    const d = routeDwells[k]!;
    if (!ascending(d.q)) continue;
    const n = d.qn ?? d.n;
    if (!(n >= CLASS_MIN_N)) continue;
    const emp = fromQuantiles(d.q);
    (quantile(emp, 0.5) >= LAYOVER_MIN_SEC ? lay : ord).push([emp, n]);
  }
  return { layover: lay.length ? mixture(lay) : null, ordinary: ord.length ? mixture(ord) : null };
}

export function stopModel(dwell: DwellLike | undefined, pools: { layover: Dist | null; ordinary: Dist | null }): StopModel {
  const ordinaryPrior = pools.ordinary ?? DEFAULT_STAND;
  if (!dwell || !ascending(dwell.q)) {
    return { stand: ordinaryPrior, layover: false, pStop: DEFAULT_P_STOP, measured: false };
  }
  const n = Math.max(0, dwell.qn ?? dwell.n);
  const emp = fromQuantiles(dwell.q);
  const ownClassIsLayover = n >= CLASS_MIN_N && quantile(emp, 0.5) >= LAYOVER_MIN_SEC;
  const prior = ownClassIsLayover ? (pools.layover ?? emp) : ordinaryPrior;
  const stand = shrinkToward(emp, prior, n, STAND_SHRINK_K);
  const pStop = dwell.pstop !== undefined && Number.isFinite(dwell.pstop)
    ? Math.min(1, Math.max(0, dwell.pstop))
    : 1 - cdf(stand, 0);
  return { stand, layover: quantile(stand, 0.5) >= LAYOVER_MIN_SEC, pStop, measured: true };
}

export function hopModel(seg: SegmentLike | undefined, roadM: number, pace: readonly number[] | undefined): HopModel {
  const paceOk = ascending(pace) && roadM > 0;
  const prior: Dist | null = paceOk ? fromQuantiles(pace.map((s) => s * roadM)) : null;
  const speedOf = (d: Dist) => {
    const med = quantile(d, 0.5);
    return roadM > 0 && med > 0 ? roadM / med : DEFAULT_DRIVE_M_S;
  };
  if (seg && ascending(seg.dq)) {
    const emp = fromQuantiles(seg.dq);
    const n = seg.dqn ?? seg.driveN ?? seg.n;
    const drive = prior ? shrinkToward(emp, prior, Math.max(0, n), SHRINK_K) : emp;
    return { drive, includesStand: false, measured: true, speedMps: speedOf(drive) };
  }
  if (seg && seg.drive !== undefined && Number.isFinite(seg.drive) && seg.drive >= 0) {
    const emp = lognormalMeanSd(Math.max(5, seg.drive), Math.max(5, seg.drive * 0.35));
    const n = seg.driveN ?? seg.n;
    const drive = prior ? shrinkToward(emp, prior, Math.max(0, n), SHRINK_K) : emp;
    return { drive, includesStand: false, measured: true, speedMps: speedOf(drive) };
  }
  if (prior) return { drive: prior, includesStand: false, measured: false, speedMps: speedOf(prior) };
  if (seg && seg.n >= 1 && Number.isFinite(seg.avg) && seg.avg > 0) {
    return { drive: lognormalMeanSd(seg.avg, seg.sd ?? seg.avg * 0.5), includesStand: true, measured: true, speedMps: DEFAULT_DRIVE_M_S };
  }
  const guess = Math.max(30, roadM / BUS_SPEED_M_S);
  return { drive: lognormalMeanSd(guess, guess * 0.5), includesStand: false, measured: false, speedMps: DEFAULT_DRIVE_M_S };
}

export function buildTables(
  stops: readonly number[],
  stopCoords: Record<number, LatLon>,
  routeSegs: Record<string, SegmentLike>,
  routeDwells: Record<string, DwellLike>,
  ring?: Ring,
): RouteTables {
  const N = stops.length;
  const pace = routeSegs[PACE_KEY]?.spm;
  const pools = classPools(routeDwells);
  const out: RouteTables = { stops: [], hops: [], priced: false };
  for (let i = 0; i < N; i++) {
    const a = stops[i]!, b = stops[(i + 1) % N]!;
    // A stop the route visits twice has a table per occurrence; the pooled
    // one is the fallback.
    out.stops.push(stopModel(routeDwells[`${a}#${i}`] ?? routeDwells[String(a)], pools));
    const seg = routeSegs[`${a}-${b}`];
    const ca = stopCoords[a], cb = stopCoords[b];
    const chord = ca && cb ? haversineMeters(ca, cb) : 0;
    const roadM = seg?.legM && Number.isFinite(seg.legM) && seg.legM > 0 ? seg.legM : ring ? ring.legM[i]! : chord;
    const hop = hopModel(seg, roadM, pace);
    out.hops.push(hop);
    if (hop.measured && !hop.includesStand) out.priced = true;
  }
  return out;
}
