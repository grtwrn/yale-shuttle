/**
 * Hour-of-day stand tables at LAYOVER cells (incident layoverhourstands20261005).
 *
 * The served stand table `q` is pooled over every hour of 30 days (see
 * `SPLIT_WINDOW_DAYS` in calibrator.ts). At most stops that is right: a kerb
 * stop's (stop, hour) cell has a median of two samples. At a layover it is
 * not. Blue Weekend at 333 Cedar (4:10) holds a median 530 / 700 / 590 s at
 * 07 / 08 / 09 h ET and 40-70 s at 14-17 h, against a pooled median of about
 * 220 s, so the ride and pickup countdowns ran 3-8 min short through every
 * morning hold (cedarhold20261004).
 *
 * What ships is one extra table per GATED cell, `qh`: the same ten quantiles
 * over the visits whose ET time of day is within {@link HOUR_STAND_HALF_WIDTH_MIN}
 * of the moment the calibrator runs, shrunk quantile by quantile toward the
 * pooled `q` with weight n / (n + {@link HOUR_STAND_SHRINK_K}). The calibrator
 * runs every five minutes, so the window slides with the clock rather than
 * jumping at the top of the hour. `q` itself is untouched: the client still
 * takes the stop's class (layover or not), the route's class pools and P(stop)
 * from it, and prices only the stand from `qh`. A cell without `qh` is priced
 * exactly as before, byte for byte.
 *
 * TWO GATES, as for the lap covariate (lapFit.ts), and for the same reason —
 * a better point estimate can be worse for a rider:
 *
 *  - {@link gateHourCell}, per CELL: day-blocked 5-fold cross-validation inside
 *    the cell, each held-out visit priced from the other folds' days by the
 *    pooled table and by the hour table exactly as they ship, the paired
 *    absolute error bootstrapped by day; served only when the upper end of the
 *    one-sided 90% interval is below zero. A cell that does not beat the
 *    pooled table beyond its own day-to-day noise stays off.
 *  - {@link HOUR_STAND_ROUTE_IDS}, per ROUTE: the rollout ledger. A route is
 *    listed only with a paired rider-sim run on record.
 *
 * Cells that already carry a served lap fit (`lapB`) or release fit are left
 * alone: those models were fitted and rider-gated against the pooled table,
 * and stacking a second conditioning under them was never measured. So is a
 * stop the route lists twice (its per-pass tables are the client's first
 * choice and carry no `qh`).
 */
import { sql, type SQL } from "drizzle-orm";

import { fromQuantiles, quantile } from "../../web/src/eta/dist.js";
import type { DB } from "../db/client.js";
import type { DwellStats, TransitNetwork } from "../network/TransitNetwork.js";
import { percentile } from "./shrinkage.js";

/** Half-width of the time-of-day window, minutes (the cedarhold backtest's +-1 h). */
export const HOUR_STAND_HALF_WIDTH_MIN = 60;
/** Pseudo-visits the pooled table is worth in the shrink (the cedarhold backtest's K = 8). */
export const HOUR_STAND_SHRINK_K = 8;
/** A cell needs this many visits in the window to be a candidate at all. */
export const HOUR_STAND_MIN_VISITS = 60;
/** A cell is a LAYOVER when its pooled median stand reaches this: web/src/eta/tables.ts LAYOVER_MIN_SEC (a test pins the two). */
export const HOUR_STAND_LAYOVER_MIN_SEC = 120;
/**
 * Service days the cell gate needs. Eight, not the lap gate's ten: the table
 * window is 30 days, and a weekend-only line (Blue Weekend, the grocery lines)
 * has 8-10 service days in it, so ten would switch the incident's own cell off
 * every Saturday morning. The bootstrap's upper bound, not this count, is what
 * carries the day-to-day noise.
 */
export const HOUR_STAND_GATE_MIN_DAYS = 8;
const GATE_FOLDS = 5;
const GATE_BOOTSTRAP = 400;
const GATE_UPPER_Q = 0.9;
/** A fold's training half needs this many visits for its tables to mean anything. */
const GATE_MIN_TRAIN = 30;
/** How often the gate is recomputed. Like the lap fit, it is a property of the timetable, not of the hour. */
export const HOUR_STAND_GATE_INTERVAL_MS = 6 * 60 * 60 * 1000;
const Q_COUNT = 10;
const MIN_PER_DAY = 1440;

/**
 * THE ROLLOUT LEDGER: routes with a paired rider-sim run on record. The cell
 * gate decides WHICH cells of a listed route are served; this records only
 * which routes have been watched at rider level. Adding a route means running
 * the pair (`scripts/eta-replay/hour-stand-patch.ts` + `rider-sim/run.ts`,
 * master vs the branch, then `--compare`) and pasting its numbers beside it.
 *
 * - **4 (Blue Weekend)** — Sat 2026-10-03 and Sun 2026-10-04, both held out
 *   (the gate as of each day's start, every five-minute table from visits in
 *   by then; SERVER_ETA=1), 4,083 and 3,819 paired waits: STRAND 0 fixed / 0
 *   introduced on both days, jump >= 180 s 42 / 0 and 18 / 0, reversal >= 60 s
 *   31 / 33 and 40 / 51, dropped 0 / 0. Share of countdown time with the bus
 *   arriving > 60 s before the shown range (the stranding direction)
 *   3.26 -> 3.26% and 5.73 -> 5.73%; before 10:00 ET, time with the bus
 *   > 2 min LATER than shown (the incident) 42.3 -> 39.2% and 28.1 -> 24.7%.
 *   Only 4:10 passes the cell gate; 4:116 (Stop & Shop) scores worse and is off.
 *
 * Measured and NOT listed (2026-10-01 and 10-02, every gate-passing cell on):
 * Orange Day STRAND 0 / 23 and jump >= 180 s 111 / 246 on 10-01; Purple jump
 * 32 / 43 and 34 / 56; Brown's early share 4.22 -> 5.45% on 10-01; Blue Day
 * and Gold fix jumps (124 / 0, 100 / 13) but add withdrawn arrivals (22, 14)
 * and Blue Day's early share rises 5.15 -> 5.30% on 10-02. Red and Blue Night
 * carry served lap fits, so their cells are skipped and both pairs were
 * byte-identical there.
 */
export const HOUR_STAND_ROUTE_IDS: ReadonlySet<number> = new Set([4]);

/** One visit of a cell: when the bus came, how long it stood (0 for a pinned pass). */
export interface StandVisit {
  at: number;
  stand: number;
  /** ET minute of the day of `at`. */
  tod: number;
  /** ET calendar day of `at`, the gate's resampling unit. */
  day: string;
}

// -- ET clock -----------------------------------------------------------------

/**
 * ET minute of the day. The calibrator cannot use `getHours()`: the suites run
 * under TZ=UTC as well as TZ=America/New_York. One shared formatter, memoised
 * per UTC hour (US offsets are whole hours and change on a UTC hour boundary,
 * so the minute within the hour never needs the formatter).
 */
const ET_PARTS = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23",
});
const etHourCache = new Map<number, { hour: number; day: string }>();
function etHour(ms: number): { hour: number; day: string } {
  const bucket = Math.floor(ms / 3_600_000);
  const hit = etHourCache.get(bucket);
  if (hit) return hit;
  if (etHourCache.size > 8192) etHourCache.clear();
  const parts = ET_PARTS.formatToParts(new Date(bucket * 3_600_000));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const v = { hour: Number(get("hour")) % 24, day: `${get("year")}-${get("month")}-${get("day")}` };
  etHourCache.set(bucket, v);
  return v;
}

export function etMinuteOfDay(ms: number): number {
  const within = (ms - Math.floor(ms / 3_600_000) * 3_600_000) / 60_000;
  return etHour(ms).hour * 60 + within;
}

export function standVisit(at: number, stand: number): StandVisit {
  return { at, stand, tod: etMinuteOfDay(at), day: etHour(at).day };
}

/** Minutes between two times of day, the short way round midnight. */
export function todDistance(a: number, b: number): number {
  const d = Math.abs(a - b) % MIN_PER_DAY;
  return Math.min(d, MIN_PER_DAY - d);
}

// -- the table ----------------------------------------------------------------

/** Ten ascending quantiles at levels (i + 0.5) / 10: calibrator.ts `standQuantiles` (a test pins the two). */
export function tenQuantiles(samples: readonly number[]): number[] {
  const out = new Array<number>(Q_COUNT);
  for (let i = 0; i < Q_COUNT; i++) out[i] = percentile(samples, (i + 0.5) / Q_COUNT);
  return out;
}

export interface HourTable {
  /** The shrunk quantiles, ascending (a convex blend of two ascending vectors). */
  q: number[];
  /** Visits inside the window. */
  n: number;
  /** Weight on the window's own quantiles. */
  w: number;
}

/**
 * The table served at `centreTod` (ET minute of day): the window's quantiles,
 * shrunk toward `pooled` with weight n / (n + K). An empty window is the
 * pooled table itself.
 */
export function hourWindowTable(visits: readonly StandVisit[], centreTod: number, pooled: readonly number[]): HourTable {
  const win: number[] = [];
  for (const v of visits) if (todDistance(v.tod, centreTod) <= HOUR_STAND_HALF_WIDTH_MIN) win.push(v.stand);
  const n = win.length;
  if (n === 0) return { q: [...pooled], n: 0, w: 0 };
  const w = n / (n + HOUR_STAND_SHRINK_K);
  const own = tenQuantiles(win);
  return { q: own.map((x, i) => w * x + (1 - w) * pooled[i]!), n, w };
}

/** The number the client reads off a table: its median, through the client's own distribution. */
export function shippedMedian(q: readonly number[]): number {
  return quantile(fromQuantiles(q), 0.5);
}

// -- the cell gate ------------------------------------------------------------

export interface HourGateResult {
  /** Passed the cell gate (the route ledger is applied separately). */
  pass: boolean;
  /** Why not, when it did not. */
  reason: string;
  /** Held-out MAE of the pooled table's median, seconds. */
  pooled: number;
  /** Held-out MAE of the hour table's median, seconds. */
  hour: number;
  /** Mean (actual - predicted) of each arm, seconds: positive = the bus stood LONGER than priced. */
  biasPooled: number;
  biasHour: number;
  /** The same two before 10:00 ET, and how many visits that is. */
  morningBiasPooled: number;
  morningBiasHour: number;
  morningN: number;
  /** Upper end of the one-sided day-clustered interval on (hour - pooled) MAE. */
  upper: number;
  days: number;
  n: number;
  /** Pooled median stand over the whole window (the layover test). */
  medStand: number;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashKey(k: string): number {
  let h = 2166136261;
  for (let i = 0; i < k.length; i++) h = Math.imul(h ^ k.charCodeAt(i), 16777619);
  return h >>> 0;
}

const avg = (a: readonly number[]): number => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);

/**
 * THE CELL GATE. Day-blocked 5-fold CV inside the cell, as `gateCell` in
 * lapFit.ts: the cell's service days, sorted and dealt round-robin into five
 * folds; each fold's visits are priced from the OTHER folds' visits by both
 * arms exactly as they ship (pooled: the ten-quantile table's median through
 * the client's distribution; hour: the window table centred on the visit's own
 * ET time of day, shrunk to that pooled table). The per-visit paired
 * absolute-error difference is bootstrapped BY DAY (stands within a day share
 * a bus, a timetable and the weather), and the cell passes only when the upper
 * end of the one-sided 90% interval is still below zero.
 */
export function gateHourCell(key: string, visits: readonly StandVisit[]): HourGateResult {
  const all = visits.map((v) => v.stand);
  const medStand = all.length ? shippedMedian(tenQuantiles(all)) : NaN;
  const byDay = new Map<string, StandVisit[]>();
  for (const v of visits) {
    let l = byDay.get(v.day);
    if (!l) byDay.set(v.day, (l = []));
    l.push(v);
  }
  const days = [...byDay.keys()].sort();
  const base = {
    pooled: NaN, hour: NaN, biasPooled: NaN, biasHour: NaN, morningBiasPooled: NaN, morningBiasHour: NaN, morningN: 0,
    upper: NaN, days: days.length, n: 0, medStand,
  };
  if (visits.length < HOUR_STAND_MIN_VISITS) return { ...base, pass: false, reason: `visits ${visits.length} < ${HOUR_STAND_MIN_VISITS}` };
  if (!(medStand >= HOUR_STAND_LAYOVER_MIN_SEC)) return { ...base, pass: false, reason: `not a layover (median ${Math.round(medStand)} s)` };
  if (days.length < HOUR_STAND_GATE_MIN_DAYS) return { ...base, pass: false, reason: `days ${days.length} < ${HOUR_STAND_GATE_MIN_DAYS}` };
  const fold = new Map<string, number>();
  days.forEach((d, i) => fold.set(d, i % GATE_FOLDS));
  const diffByDay = new Map<string, { sum: number; n: number }>();
  const eP: number[] = [], eH: number[] = [], sP: number[] = [], sH: number[] = [], mP: number[] = [], mH: number[] = [];
  for (let f = 0; f < GATE_FOLDS; f++) {
    const train: StandVisit[] = [], test: StandVisit[] = [];
    for (const v of visits) (fold.get(v.day) === f ? test : train).push(v);
    if (train.length < GATE_MIN_TRAIN || test.length === 0) continue;
    const pooledQ = tenQuantiles(train.map((v) => v.stand));
    const pooledMed = shippedMedian(pooledQ);
    for (const v of test) {
      const hourMed = shippedMedian(hourWindowTable(train, v.tod, pooledQ).q);
      const dP = Math.abs(pooledMed - v.stand), dH = Math.abs(hourMed - v.stand);
      eP.push(dP); eH.push(dH); sP.push(v.stand - pooledMed); sH.push(v.stand - hourMed);
      if (v.tod < 600) { mP.push(v.stand - pooledMed); mH.push(v.stand - hourMed); }
      const acc = diffByDay.get(v.day) ?? { sum: 0, n: 0 };
      acc.sum += dH - dP; acc.n++;
      diffByDay.set(v.day, acc);
    }
  }
  const scored = {
    pooled: avg(eP), hour: avg(eH), biasPooled: avg(sP), biasHour: avg(sH),
    morningBiasPooled: avg(mP), morningBiasHour: avg(mH), morningN: mP.length, n: eP.length, days: diffByDay.size,
  };
  if (eP.length === 0 || diffByDay.size < HOUR_STAND_GATE_MIN_DAYS) {
    return { ...base, ...scored, pass: false, reason: `scored days ${diffByDay.size} < ${HOUR_STAND_GATE_MIN_DAYS}` };
  }
  const cells = [...diffByDay.values()];
  const rnd = mulberry32(hashKey(key) ^ 0x4e57);
  const boot: number[] = [];
  for (let b = 0; b < GATE_BOOTSTRAP; b++) {
    let sum = 0, n = 0;
    for (let i = 0; i < cells.length; i++) {
      const c = cells[Math.floor(rnd() * cells.length)]!;
      sum += c.sum; n += c.n;
    }
    if (n > 0) boot.push(sum / n);
  }
  boot.sort((a, b) => a - b);
  const upper = boot.length ? boot[Math.min(boot.length - 1, Math.floor(GATE_UPPER_Q * boot.length))]! : NaN;
  const pass = upper < 0;
  return { ...base, ...scored, upper, pass, reason: pass ? "pass" : `upper ${upper.toFixed(1)} s >= 0 (not better beyond day-to-day noise)` };
}

/** Every candidate cell's gate result, keyed `"<route>:<stop>"`. */
export function computeHourStandGates(cells: ReadonlyMap<string, readonly StandVisit[]>): Map<string, HourGateResult> {
  const out = new Map<string, HourGateResult>();
  for (const [key, visits] of cells) out.set(key, gateHourCell(key, visits));
  return out;
}

/**
 * The cells to serve: gate passed AND the route is on the ledger. The other
 * per-cell exclusions (a lap or release fit, a stop the route repeats) are
 * applied where the table is attached, since they depend on the calibration.
 */
export function servedHourStandCells(
  gates: ReadonlyMap<string, HourGateResult>,
  routes: ReadonlySet<number> = HOUR_STAND_ROUTE_IDS,
): Set<string> {
  const out = new Set<string>();
  for (const [key, g] of gates) {
    if (!g.pass) continue;
    if (!routes.has(Number(key.slice(0, key.indexOf(":"))))) continue;
    out.add(key);
  }
  return out;
}

/**
 * Put this moment's table on every served cell, beside its pooled `q`. Skips
 * a cell with no pooled table (the hour table shrinks TOWARD it), a cell with
 * a served lap or release fit, a stop the route lists twice, and an empty
 * window (the pooled table is then the whole answer). Returns the number of
 * cells carrying `qh`.
 */
export function attachHourStandTables(
  dwells: Map<string, DwellStats>,
  network: TransitNetwork,
  visits: ReadonlyMap<string, readonly StandVisit[]>,
  nowMs: number,
): number {
  const tod = etMinuteOfDay(nowMs);
  // Tests inject a bare setCalibration sink without routes (as for attachOccurrenceStandTables).
  const knowsRoutes = Boolean(network.routes) && typeof network.positionsOnRoute === "function";
  let count = 0;
  for (const [key, vs] of visits) {
    const cur = dwells.get(key);
    if (!cur || cur.q === undefined) continue;
    if (cur.lapB !== undefined || cur.release !== undefined) continue;
    const colon = key.indexOf(":");
    const routeId = Number(key.slice(0, colon)), stopId = Number(key.slice(colon + 1));
    if (knowsRoutes && network.positionsOnRoute(routeId, stopId).length > 1) continue;
    const t = hourWindowTable(vs, tod, cur.q);
    if (t.n === 0) continue;
    dwells.set(key, { ...cur, qh: t.q, qhn: t.n });
    count++;
  }
  return count;
}

// -- loading --------------------------------------------------------------------

interface VisitRow { routeId: number; stopId: number; anchoredAt: number; stand: number }

/** Which rows to read: some routes, or some cells. Omitted: every cell (the replay's full table). */
export interface StandVisitFilter {
  routes?: ReadonlySet<number>;
  cells?: ReadonlySet<string>;
}

/**
 * The same visits, value and bounds as calibrator.ts `loadStandGroups` (a
 * pinned pass is a 0 s stand; nothing whose evidence postdates `nowMs`), one
 * row per visit because the window needs each visit's time. The filter goes
 * into the SQL, so the five-minute path reads the served cells' rows only
 * (a few hundred) rather than the window's ~80k.
 */
export function loadStandVisits(
  db: DB,
  windowDays: number,
  nowMs: number,
  filter: StandVisitFilter = {},
): Map<string, StandVisit[]> {
  const out = new Map<string, StandVisit[]>();
  const conds: SQL[] = [];
  if (filter.routes) {
    if (filter.routes.size === 0) return out;
    conds.push(sql`route_id IN (${sql.join([...filter.routes].map((r) => sql`${r}`), sql`, `)})`);
  }
  if (filter.cells) {
    const pairs = [...filter.cells].map((k) => k.split(":").map(Number)).filter((p) => p.length === 2 && p.every(Number.isInteger));
    if (pairs.length === 0) return out;
    conds.push(sql`(${sql.join(pairs.map(([r, st]) => sql`(route_id = ${r} AND stop_id = ${st})`), sql` OR `)})`);
  }
  const cutoff = nowMs - windowDays * 86_400_000;
  const rows = db.all<VisitRow>(sql`
    SELECT route_id AS routeId, stop_id AS stopId, anchored_at AS anchoredAt,
      CASE WHEN outcome = 'passed' THEN 0 ELSE (departed_at - pinned_at) / 1000.0 END AS stand
    FROM stop_visits
    WHERE anchored_at >= ${cutoff} AND anchored_at <= ${nowMs}
      AND (CASE WHEN departed_at IS NULL AND outcome = 'passed'
            THEN MAX(anchored_at, COALESCE(first_moved_at, anchored_at))
            ELSE MAX(departed_at, COALESCE(first_moved_at, departed_at)) END
          ) + MAX(0, COALESCE(confirm_sec, 0)) * 1000 <= ${nowMs}
      AND pinned_at IS NOT NULL
      AND (
        (outcome = 'stopped' AND departed_at IS NOT NULL AND departed_at >= pinned_at)
        OR outcome = 'passed'
      )
      ${conds.length ? sql`AND ${sql.join(conds, sql` AND `)}` : sql``}
    ORDER BY anchored_at
  `);
  for (const r of rows) {
    const key = `${r.routeId}:${r.stopId}`;
    let l = out.get(key);
    if (!l) out.set(key, (l = []));
    l.push(standVisit(r.anchoredAt, r.stand));
  }
  return out;
}

/** Candidate cells only: enough visits, and a layover by the pooled median. */
export function layoverCandidates(cells: ReadonlyMap<string, readonly StandVisit[]>): Map<string, readonly StandVisit[]> {
  const out = new Map<string, readonly StandVisit[]>();
  for (const [key, visits] of cells) {
    if (visits.length < HOUR_STAND_MIN_VISITS) continue;
    if (!(shippedMedian(tenQuantiles(visits.map((v) => v.stand))) >= HOUR_STAND_LAYOVER_MIN_SEC)) continue;
    out.set(key, visits);
  }
  return out;
}

/**
 * Refreshes the gate at most every {@link HOUR_STAND_GATE_INTERVAL_MS}; never
 * throws. A gate that cannot be read is a gate that serves nothing, and then
 * every stand prices exactly as before.
 */
export class HourStandGateCache {
  private gates: Map<string, HourGateResult> = new Map();
  private served: Set<string> = new Set();
  private at = 0;
  constructor(
    private readonly db: DB,
    private readonly windowDays: number,
    /** The rollout ledger; production reads (and gates) only these routes' cells. */
    private readonly routes: ReadonlySet<number> = HOUR_STAND_ROUTE_IDS,
  ) {}
  get(nowMs: number = Date.now()): ReadonlySet<string> {
    if (this.at !== 0 && nowMs - this.at < HOUR_STAND_GATE_INTERVAL_MS) return this.served;
    try {
      this.gates = computeHourStandGates(layoverCandidates(loadStandVisits(this.db, this.windowDays, nowMs, { routes: this.routes })));
      this.served = servedHourStandCells(this.gates, this.routes);
    } catch {
      this.gates = new Map();
      this.served = new Set();
    }
    this.at = nowMs;
    return this.served;
  }
  /** The last gate table (ledger routes only), for logs. */
  results(): ReadonlyMap<string, HourGateResult> {
    return this.gates;
  }
}
