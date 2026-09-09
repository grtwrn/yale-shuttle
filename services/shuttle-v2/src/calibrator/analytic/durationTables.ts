/** Exact standing-only subset of web/src/eta/tables.ts; parity tests pin the shared law. */
import { cdf, fromQuantiles, mixture, quantile, shrinkToward, type Dist } from "./dist.js";
const DEFAULT_P_STOP = 0.877;
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

export interface DwellLike { med: number; n: number; q?: number[] | undefined; qn?: number | undefined; pstop?: number | undefined }

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

