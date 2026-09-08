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
 *                    A route with no pool of a class falls through to the
 *                    ALL-ROUTES pool of that class (`globalClassPools`, built
 *                    from every route's tables); a stop with no table at all
 *                    takes the route's ordinary pool, else the network's,
 *                    else DEFAULT_STAND_Q — and is flagged unmeasured.
 *  drive on hop i    `segments["A-B"].dq` (ten quantiles of `legs.leg_sec`,
 *                    drive + hold), shrunk toward the route's pace prior:
 *                    road metres x `pace.spm` (seconds per metre). The server
 *                    serves a pace for EVERY route — its own where it has
 *                    legs, the all-routes pooled one where it has none
 *                    (calibrator.ts `withPooledPace`, flagged `spmPooled`) —
 *                    so every hop has a drive prior. Missing dq: the served
 *                    `drive` median as a lognormal; missing that: the pace
 *                    prior alone, flagged unmeasured (the pooled quantiles
 *                    are wider than a route's own, so the range widens where
 *                    the route has not been measured); no pace at all (a
 *                    cold database): the arrival-to-arrival `avg`/`sd` as a
 *                    lognormal that INCLUDES the stand at A, and last the
 *                    road at BUS_SPEED_M_S. So `priced` is false only for a
 *                    route with no hop the model can put a number on at all —
 *                    a cold database with no pace anywhere. Nothing dispatches
 *                    on it any more (there is no second estimator to dispatch
 *                    to); it is the diagnostic `no-bridged-ring.test.ts`
 *                    asserts against the payload fixture.
 *
 * `pace` travels inside `segmentTimes[route]["__pace"]` (a reserved key, see
 * v1compat.ts) so the client signature did not have to change. Road metres
 * per hop come from the ring (`legM`), the same length the server's pace is
 * measured against.
 *
 * WHAT A DWELL STATISTIC ACTUALLY MEASURES — read this before using the v1
 * `med` / `avg` fields for anything. `dwells[r][stop].med` does NOT measure
 * how long a bus stands: `detector.ts` computes ONE elapsed time per
 * transition (nearest stop A -> nearest stop B) and emits it as both the
 * dwell at A and the segment A->B — 119,329 of 119,329 joined rows over 30
 * days were identical — so `seg.avg - med` is two estimators of the same
 * quantity disagreeing, not "the drive" (the dwell median exceeded the whole
 * segment average on 41.2% of hops). Two shipped changes rested on that
 * decomposition and were reverted (docs/eta-accuracy.md). This model reads
 * `q` (the stand at the stop, from `stop_visits`) and `dq` (the whole leg,
 * from `legs`), which ARE two measurements; `avg` is touched only in the
 * cold-database branch below, and there as the whole hop it is.
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
  /**
   * The rest hidden INSIDE the hop, when there is one: a bus that lays over
   * off any stop (a yard by the terminus, a relief run) is not in any stand
   * table — the stand tables are pinned within 75 m of a stop — but the leg
   * it rests on carries it, as a drive whose median exceeds road metres x
   * pace by a layover's length (LAYOVER_MIN_SEC). On the 9/4 tables: Blue
   * West's last hop 960 s for 1,044 m (free 167 s), Blue Night 587 vs 204,
   * Orange East 500 vs 274, Brown 476 vs 324. The excess, quantile
   * by quantile, is the hidden stand; a bus HOLDING mid-leg on such a hop
   * is priced as that rest continuing (given the time already stood) plus
   * the free-flow drive left, not as a fraction of a 16-minute "drive".
   * Null on an ordinary hop, whose drive is its free-flow time.
   */
  hidden: Dist | null;
  /** The free-flow drive (road metres x pace) when a pace is served, for the hold pricing. */
  free: Dist | null;
}

export interface RouteTables {
  stops: StopModel[];
  hops: HopModel[];
  /**
   * Whether there is anything to price a leg ON — a hop's own `dq`/`drive`,
   * the route's pace, or the NETWORK's pooled pace. Nothing dispatches on it
   * any more (there is no second estimator to dispatch to); it is the
   * diagnostic `no-bridged-ring.test.ts` asserts for every served route, and
   * it is false only for a cold database with no pace anywhere.
   */
  priced: boolean;
}

export interface SegmentLike { avg: number; sd?: number | undefined; n: number; drive?: number | undefined; driveN?: number | undefined; dq?: number[] | undefined; dqn?: number | undefined; spm?: number[] | undefined; spmN?: number | undefined; spmPooled?: boolean | undefined; legM?: number | undefined }
export interface DwellLike { med: number; n: number; q?: number[] | undefined; qn?: number | undefined; pstop?: number | undefined }

export const PACE_KEY = "__pace";

const DEFAULT_STAND = fromQuantiles(DEFAULT_STAND_Q);

function ascending(q: readonly number[] | undefined): q is number[] {
  if (!q || q.length < 3) return false;
  for (let i = 1; i < q.length; i++) if (!(q[i]! >= q[i - 1]!) || !Number.isFinite(q[i]!)) return false;
  return Number.isFinite(q[0]!);
}

export interface ClassPools { layover: Dist | null; ordinary: Dist | null }

/** The route's two class pools, each a qn-weighted mixture of its members' tables. */
export function classPools(routeDwells: Record<string, DwellLike>): ClassPools {
  const lay: [Dist, number][] = [], ord: [Dist, number][] = [];
  collectClassMembers(routeDwells, lay, ord);
  return { layover: lay.length ? mixture(lay) : null, ordinary: ord.length ? mixture(ord) : null };
}

/**
 * The ALL-ROUTES class pools: every stand table of every route, in the same
 * two classes. The level above the route in the hierarchy stop -> route
 * class pool -> network class pool: a route that has no layover table of its
 * own leans on the network's layovers, and a route with no tables at all
 * (the grocery lines, which run one weekend and whose visits the retention
 * window often does not hold) prices every stop from the network's ordinary
 * pool rather than from a hand-typed constant.
 */
export function globalClassPools(dwellsByRoute: Record<string, Record<string, DwellLike>>): ClassPools {
  const lay: [Dist, number][] = [], ord: [Dist, number][] = [];
  for (const r in dwellsByRoute) collectClassMembers(dwellsByRoute[r]!, lay, ord);
  return { layover: lay.length ? mixture(lay) : null, ordinary: ord.length ? mixture(ord) : null };
}

function collectClassMembers(routeDwells: Record<string, DwellLike>, lay: [Dist, number][], ord: [Dist, number][]): void {
  for (const k in routeDwells) {
    const d = routeDwells[k]!;
    if (!ascending(d.q)) continue;
    const n = d.qn ?? d.n;
    if (!(n >= CLASS_MIN_N)) continue;
    const emp = fromQuantiles(d.q);
    (quantile(emp, 0.5) >= LAYOVER_MIN_SEC ? lay : ord).push([emp, n]);
  }
}

/** The route's pools where it has them, the network's where it does not. */
export function poolsWithFallback(route: ClassPools, global: ClassPools | undefined): ClassPools {
  return { layover: route.layover ?? global?.layover ?? null, ordinary: route.ordinary ?? global?.ordinary ?? null };
}

export function stopModel(dwell: DwellLike | undefined, pools: ClassPools): StopModel {
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
    return { drive, includesStand: false, measured: true, speedMps: speedOf(drive), hidden: prior ? hiddenRest(drive, prior) : null, free: prior };
  }
  if (seg && seg.drive !== undefined && Number.isFinite(seg.drive) && seg.drive >= 0) {
    const emp = lognormalMeanSd(Math.max(5, seg.drive), Math.max(5, seg.drive * 0.35));
    const n = seg.driveN ?? seg.n;
    const drive = prior ? shrinkToward(emp, prior, Math.max(0, n), SHRINK_K) : emp;
    return { drive, includesStand: false, measured: true, speedMps: speedOf(drive), hidden: prior ? hiddenRest(drive, prior) : null, free: prior };
  }
  // The pace prior alone — the route's own, or the network's pooled one on a
  // line the collector has not timed yet. Unmeasured: the row gets the `~`,
  // and the pooled quantiles are wider than a route's own, so the 10-90 range
  // widens where the route has not been measured.
  if (prior) return { drive: prior, includesStand: false, measured: false, speedMps: speedOf(prior), hidden: null, free: prior };
  // No pace anywhere (a cold database): the v1 arrival-to-arrival hop, which
  // CONTAINS the stand at A (see the header) — arrival.ts adds no stand for
  // such a hop. Unmeasured for the `~`: a whole-hop mean and sd are not the
  // leg's distribution.
  if (seg && seg.n >= 1 && Number.isFinite(seg.avg) && seg.avg > 0) {
    return { drive: lognormalMeanSd(seg.avg, seg.sd ?? seg.avg * 0.5), includesStand: true, measured: false, speedMps: DEFAULT_DRIVE_M_S, hidden: null, free: null };
  }
  const guess = Math.max(30, roadM / BUS_SPEED_M_S);
  return { drive: lognormalMeanSd(guess, guess * 0.5), includesStand: false, measured: false, speedMps: DEFAULT_DRIVE_M_S, hidden: null, free: null };
}

/** Quantile levels of the calibrator's ten-knot tables. */
const KNOT_LEVELS = Array.from({ length: 10 }, (_, i) => (i + 0.5) / 10);

/**
 * The stand hidden in a hop: the measured drive minus the free-flow drive,
 * quantile by quantile (comonotonic — the slow legs are the ones with the
 * rest in them), when the medians differ by a layover's length; else null.
 */
export function hiddenRest(drive: Dist, free: Dist): Dist | null {
  if (quantile(drive, 0.5) - quantile(free, 0.5) < LAYOVER_MIN_SEC) return null;
  const q: number[] = [];
  let prev = 0;
  for (const p of KNOT_LEVELS) {
    prev = Math.max(prev, quantile(drive, p) - quantile(free, p), 0);
    q.push(prev);
  }
  return fromQuantiles(q);
}

export function buildTables(
  stops: readonly number[],
  stopCoords: Record<number, LatLon>,
  routeSegs: Record<string, SegmentLike>,
  routeDwells: Record<string, DwellLike>,
  ring?: Ring,
  /** The all-routes class pools (`globalClassPools`), the level above the route's own. */
  globalPools?: ClassPools,
  /**
   * Ring position -> the index UPSTREAM gave that occurrence, on a route whose
   * order had to be repaired against its published line
   * (src/network/alignStops.ts). A server on this build already keys its
   * per-pass stand tables by the repaired order, so this is only the fallback
   * for a payload served before the change; absent everywhere else.
   */
  pubIndex?: readonly number[],
): RouteTables {
  const N = stops.length;
  const pace = routeSegs[PACE_KEY]?.spm;
  const pools = poolsWithFallback(classPools(routeDwells), globalPools);
  const out: RouteTables = { stops: [], hops: [], priced: false };
  for (let i = 0; i < N; i++) {
    const a = stops[i]!, b = stops[(i + 1) % N]!;
    // A stop the route visits twice has a table per occurrence; the pooled
    // one is the fallback.
    // The RING's index first — a server on this build keys its per-pass stand
    // tables by the same repaired order (v1compat.ts walks the network's own
    // sequence) — then the slot UPSTREAM gave the occurrence, so a payload
    // served before this change still finds its tables, then the pooled one.
    const pub = pubIndex?.[i];
    out.stops.push(stopModel(
      routeDwells[`${a}#${i}`]
        ?? (pub !== undefined ? routeDwells[`${a}#${pub}`] : undefined)
        ?? routeDwells[String(a)],
      pools,
    ));
    const seg = routeSegs[`${a}-${b}`];
    const ca = stopCoords[a], cb = stopCoords[b];
    const chord = ca && cb ? haversineMeters(ca, cb) : 0;
    const roadM = seg?.legM && Number.isFinite(seg.legM) && seg.legM > 0 ? seg.legM : ring ? ring.legM[i]! : chord;
    const hop = hopModel(seg, roadM, pace);
    out.hops.push(hop);
    // `priced` asks whether there is anything to price the leg ON, not whether
    // this route has been measured: a hop answered from the NETWORK's pooled
    // pace carries a real drive distribution, and `measured: false` is how the
    // row says so to the rider (the `~`, and the pooled quantiles' wider
    // 10-90).
    //
    // Still not a price: a whole-hop `avg` (it CONTAINS the stand at A, so it
    // is not the leg's distribution) and the last-resort road-length-over-a-
    // constant guess. Both need no pace anywhere, i.e. a cold database. It no
    // longer selects an estimator — it is read by the tests that pin every
    // served route as priceable.
    if (!hop.includesStand && (hop.measured || hop.free)) out.priced = true;
  }
  return out;
}
