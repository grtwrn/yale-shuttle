/**
 * The lap covariate, fitted per (route, stop) — the server half of
 * `web/src/eta/lap.ts`.
 *
 * A bus that comes back to a regulated layover EARLY stands longer. `lap` is
 * the seconds from that bus's previous DEPARTURE from that stop to its next
 * arrival there, and it splits a table the pooled median cannot: at 344
 * Winchester over 90 days of `arrivals`, laps at 0.7-0.9 of the loop stand a
 * median 12:05 and laps at 1.1-1.4 stand 4:05, against a pooled 8:56.
 *
 * The client cannot compute any of this — it sees only live positions — so
 * the fit rides on the dwell table (`lapB`/`lapM`/`lapN`) and the age rides on
 * the bus (`buses[].lap`).
 *
 * WHY `arrivals` AND NOT `stop_visits`. The served stand table `q` comes from
 * `stop_visits` (`departed_at - pinned_at`), which is the right clock and the
 * right quantity — but that table only exists from 2026-09-03, and a slope
 * fitted on one week of a cell is a slope fitted on a handful of buses.
 * `arrivals` reaches back 90 days. The fit is expressed MULTIPLICATIVELY —
 * `lapB` is seconds of stand per second of lap DIVIDED BY the cell's own
 * median — so it is a relative sensitivity and transfers to whatever table the
 * client is actually holding. It is not an absolute number of seconds and must
 * not be read as one.
 */

/** One closed visit. */
export interface LapArrival {
  busName: string;
  routeId: number;
  stopId: number;
  arrivedAt: number;
  departedAt: number;
}

/** What one cell serves. `b` is a FRACTION of the cell's median stand per second of lap. */
export interface LapFit {
  b: number;
  /** The reference lap, seconds — the fitted median, and the pivot of the factor. */
  m: number;
  /** An EFFECTIVE count: the client's own `n / (n + LAP_SHRINK_K)` reproduces the weight below. */
  n: number;
}

/** Must equal `LAP_SHRINK_K` in web/src/eta/lap.ts; a test pins the two. */
export const LAP_SHRINK_K = 19;
/** Must equal `LAP_BAND_LO` / `LAP_BAND_HI` there. */
export const LAP_BAND_LO = 0.65;
export const LAP_BAND_HI = 1.65;
/** Must equal `LAP_F_MIN` / `LAP_F_MAX` there: the gate scores the rule that ships. */
export const LAP_F_MIN = 0.35;
export const LAP_F_MAX = 2.0;
/** Below this many in-band laps a cell has no fit at all. */
export const LAP_MIN_N = 60;
/** A cell whose typical stand is shorter than this has nothing worth splitting. */
export const LAP_MIN_MED_STAND_SEC = 120;
/** Loop lengths outside this are not loops (a depot run, a service change). */
const PERIOD_MIN_SEC = 900;
const PERIOD_MAX_SEC = 7200;
/** A stand longer than this is not a stand. */
const MAX_STAND_SEC = 2400;
/** Laps behind a cell's period estimate. */
const MIN_PERIOD_SAMPLES = 40;
/** Below this many fitted cells there is no cross-cell spread to shrink with. */
const MIN_CELLS_FOR_POOLING = 5;
/** Day-blocked CV folds behind the serving gate. */
const GATE_FOLDS = 5;
/** Day-cluster bootstrap resamples behind the gate's noise bound. Deterministic (seeded). */
const GATE_BOOTSTRAP = 400;
/**
 * The gate's confidence. A cell is served only when the UPPER end of this
 * one-sided interval on the paired MAE difference is still below zero, i.e.
 * the improvement survives the day-to-day noise at that cell.
 */
const GATE_UPPER_Q = 0.9;
/** A cell needs this many service days for a day-blocked CV to mean anything. */
const GATE_MIN_DAYS = 10;

/**
 * THE ROLLOUT GATE. Which routes have a PAIRED RIDER-SIM RUN on record showing
 * that the lap correction does not raise strands or reversals there.
 *
 * This is not an estimator switch and it is not a per-route tuning knob — the
 * arithmetic is identical on every route and every cell, and `gateCell` is
 * what decides whether a cell's fit is any good. This records only which
 * routes have been WATCHED. It exists because the cell gate proves the fit
 * beats the pooled median on held-out stand MAE, and that is necessary and
 * NOT sufficient: the split stand tables improved the stand estimate on Pink
 * and took the line 280 -> 431 strands anyway, because replacing a pessimistic
 * estimate with an unbiased one strands the half of riders whose bus leaves
 * before the median (CLAUDE.md, "The stand/drive split is served"). A better
 * point estimate can be worse for a rider, and only the rider table can say.
 *
 * **Adding a route means running the pair and pasting its numbers beside the
 * id**, exactly as `SPLIT_SERVED_ROUTE_IDS` requires: a held-out ET day,
 * `PAYLOAD_PATCH`, `scripts/eta-replay/rider-sim/run.ts` per route, then
 * `--compare`, with strands and reversals as the gate.
 *
 * - **3 (Red)** — ET day 2026-09-04, held out (the fit sees only days before
 *   it), 1,664 paired waits: STRAND 11 fixed / 5 introduced, reversal >= 60 s
 *   43 / 7, jump >= 180 s 25 / 21, drops and pin 0 / 0, worst drift 592
 *   improved / 101 worsened, first-promise |miss| 254 / 256 (a wash). The
 *   dangerous tail (`firstSightMissSec < -60`) 22.6 -> 14.8%.
 *   `docs/stand-lap-covariate.md` section 6.
 *
 * **13 (Blue Night) was measured on 2026-09-10 and is NOT served.** Its cells
 * pass the cell gate by the widest margin on the network (333 Cedar -115.5 s
 * held out) and the covariate moves the stand the right way on every evening
 * replayed, but the paired rider table on the held-out Sat 09/06 evening
 * (1,349 waits) read STRAND 0 fixed / 74 introduced, jump >= 180 s 0 / 555,
 * reversal 24 / 556 — every one of them in the SECOND slot ("then N min").
 * On a one-bus line that slot is the same bus a lap later, so its chain
 * always carries the full 333 Cedar stand as a FUTURE stand, and at the poll
 * the bus leaves that stop the stand is priced under a lap the served clock
 * has not yet reset: the number drops ~4 min and comes back a poll later
 * (CHAIN block: +185 s at the departure poll on 184 of 270 riders). The bus
 * the rider boards is untouched (slot-1 jumps 851 -> 842). gps-replay cannot
 * see it (k <= 5). Fix the lap of a stop the bus is LEAVING before adding
 * this id; `docs/stand-lap-covariate.md` section 6b has the numbers.
 *
 * **The stop-being-left defect above is fixed (2026-09-11).** The served
 * departure clock had not reset at the poll the belief saw the bus leave, so
 * the next visit was priced under a lap two laps long and the correction
 * switched OFF for the departure polls. `ownDeparture` (web/src/eta/arrival.ts) now seeds that stop's
 * departure from the belief's own rest identity; re-run on the same two
 * evenings the pair reads STRAND 0 / 0 and 0 / 8, jump >= 180 s 0 / 76 and
 * 34 / 60, reversal 38 / 101 and 22 / 75 (from 0 / 555, 24 / 556 unfixed),
 * with the first-sight columns byte-identical to #215's. The residual is one
 * unexplained episode an evening; `docs/stand-lap-covariate.md` section 6c.
 */
export const LAP_SERVED_ROUTE_IDS: ReadonlySet<number> = new Set([3]);

const median = (a: number[]): number => {
  if (!a.length) return NaN;
  const b = [...a].sort((x, y) => x - y);
  return (b[Math.floor((b.length - 1) / 2)]! + b[Math.ceil((b.length - 1) / 2)]!) / 2;
};
const mean = (a: number[]): number => a.reduce((s, x) => s + x, 0) / a.length;

interface Sample { lap: number; stand: number; day: string }

/**
 * The cluster-robust (by ET day) standard error of the slope. Stands within a
 * day share a fleet, a timetable and the weather, so the iid standard error
 * understates the sampling variance by an order of magnitude — and the whole
 * point of shrinkage here is to catch a cell whose fit is a few good days
 * rather than a pattern. Deterministic, and O(n): no bootstrap on the
 * calibrator's cadence.
 */
function slopeSE(rows: readonly Sample[], slope: number, intercept: number, mx: number): number {
  let sxx = 0;
  const byDay = new Map<string, number>();
  for (const r of rows) {
    const xt = r.lap - mx;
    sxx += xt * xt;
    byDay.set(r.day, (byDay.get(r.day) ?? 0) + xt * (r.stand - (intercept + slope * r.lap)));
  }
  if (!(sxx > 0) || byDay.size < 2) return Infinity;
  let meat = 0;
  for (const v of byDay.values()) meat += v * v;
  const g = byDay.size;
  return Math.sqrt((meat / (sxx * sxx)) * (g / Math.max(1, g - 1)));
}

/** mulberry32 — the gate's bootstrap must be deterministic; the calibrator reruns it every 6 h. */
function rng(seed: number): () => number {
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

export interface GateResult {
  /** Served? */
  pass: boolean;
  /** Held-out MAE of the pooled median it would replace, seconds. */
  pooled: number;
  /** Held-out MAE of the lap rule, as it would ship (band, shrinkage, clamp). */
  lap: number;
  /** Upper end of the one-sided day-clustered bootstrap interval on (lap - pooled). */
  upper: number;
  days: number;
  n: number;
}

/**
 * THE SERVING GATE, and it is a property of the CELL, not of the route.
 *
 * A fit is only served where it measurably beats the thing it replaces. This
 * is not a formality: two cells on the 90-day corpus fit a real slope and
 * still score WORSE held out than the pooled median (100 Church Street South
 * on Orange Night, 333 Cedar on Blue Day), and serving a correction that is
 * worse than what it replaces is exactly how the split stand tables burned
 * Pink — 11 hops cleared the client's sample gate and the line went 280 -> 431
 * strands (CLAUDE.md, "The stand/drive split is served"). A route allowlist is
 * the fragile version of this and the operator has ruled that style out.
 *
 * The rule: **day-blocked 5-fold cross-validation inside the cell**. Each fold
 * fits the slope and the pooled median on the other four folds' SERVICE DAYS
 * and scores this fold's stands with both, under the exact rule that ships —
 * the band, the shrinkage weight, the clamp. Then the per-visit paired
 * absolute-error difference is bootstrapped BY DAY (the cluster; stands within
 * a day share a fleet, a timetable and the weather), and the cell is served
 * only when the upper end of that interval is still below zero.
 *
 * Days, not rows, are the resampling unit for the same reason `slopeSE` uses
 * them: the iid interval understates the noise by an order of magnitude, which
 * is the whole failure this gate exists to avoid.
 */
export function gateCell(
  key: string,
  samples: readonly Sample[],
  w: number,
  medStand: number,
): GateResult {
  const byDay = new Map<string, Sample[]>();
  for (const s of samples) {
    let l = byDay.get(s.day);
    if (!l) byDay.set(s.day, (l = []));
    l.push(s);
  }
  const days = [...byDay.keys()].sort();
  const fail = (): GateResult => ({ pass: false, pooled: NaN, lap: NaN, upper: NaN, days: days.length, n: samples.length });
  if (days.length < GATE_MIN_DAYS) return fail();
  // Deterministic fold assignment: the sorted service days, dealt round-robin.
  const fold = new Map<string, number>();
  days.forEach((d, i) => fold.set(d, i % GATE_FOLDS));
  // Per visit: |lap prediction - stand| - |pooled prediction - stand|, on the
  // fold that did not fit it.
  const diffByDay = new Map<string, { sum: number; n: number }>();
  let lapErr = 0, poolErr = 0, scored = 0;
  for (let f = 0; f < GATE_FOLDS; f++) {
    const train: Sample[] = [], test: Sample[] = [];
    for (const s of samples) (fold.get(s.day) === f ? test : train).push(s);
    if (train.length < LAP_MIN_N || test.length === 0) continue;
    const tx = train.map((s) => s.lap), ty = train.map((s) => s.stand);
    const mx = mean(tx), my = mean(ty);
    let sxy = 0, sxx = 0;
    for (let i = 0; i < tx.length; i++) { sxy += (tx[i]! - mx) * (ty[i]! - my); sxx += (tx[i]! - mx) ** 2; }
    if (!(sxx > 0)) continue;
    const slope = sxy / sxx;
    const M = median(ty);
    const lm = median(tx);
    const b = slope / Math.max(1, M);
    for (const s of test) {
      // The band is applied by the caller in production; inside the cell every
      // sample is already in band, so the factor is always live here.
      const f2 = Math.min(LAP_F_MAX, Math.max(LAP_F_MIN, 1 + w * b * (s.lap - lm)));
      const dLap = Math.abs(M * f2 - s.stand);
      const dPool = Math.abs(M - s.stand);
      lapErr += dLap; poolErr += dPool; scored++;
      const acc = diffByDay.get(s.day) ?? { sum: 0, n: 0 };
      acc.sum += dLap - dPool; acc.n++;
      diffByDay.set(s.day, acc);
    }
  }
  if (scored === 0 || diffByDay.size < GATE_MIN_DAYS) return fail();
  const cells = [...diffByDay.values()];
  const r = rng(hashKey(key) ^ 0x1a9c);
  const boot: number[] = [];
  for (let b = 0; b < GATE_BOOTSTRAP; b++) {
    let sum = 0, n = 0;
    for (let i = 0; i < cells.length; i++) {
      const c = cells[Math.floor(r() * cells.length)]!;
      sum += c.sum; n += c.n;
    }
    if (n > 0) boot.push(sum / n);
  }
  boot.sort((a, b2) => a - b2);
  const upper = boot.length ? boot[Math.min(boot.length - 1, Math.floor(GATE_UPPER_Q * boot.length))]! : NaN;
  void medStand;
  return { pass: upper < 0, pooled: poolErr / scored, lap: lapErr / scored, upper, days: diffByDay.size, n: scored };
}

/**
 * The ET calendar day, and it is worth the two lines of cache.
 *
 * `new Date(ms).toLocaleDateString("en-CA", { timeZone })` builds a fresh
 * `Intl.DateTimeFormat` on every call: **166 us each**, measured on this Pi.
 * The fitter asks it once per in-band sample — ~130,000 of them over 90 days —
 * so the naive spelling put **21 seconds** on the collector's boot path and on
 * the six-hourly refresh, synchronous on the event loop that serves
 * `/api/buses`. One shared formatter and an hour-bucket memo take the same
 * work to under 200 ms.
 */
const ET_FORMAT = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
});
const etDayCache = new Map<number, string>();

export function etDay(ms: number): string {
  // Rows arrive in time order, so an hour bucket is hit thousands of times
  // before it is missed once.
  const bucket = Math.floor(ms / 3_600_000);
  const hit = etDayCache.get(bucket);
  if (hit !== undefined) return hit;
  if (etDayCache.size > 4096) etDayCache.clear();
  const day = ET_FORMAT.format(new Date(ms));
  etDayCache.set(bucket, day);
  return day;
}

/**
 * Fit every cell the corpus can support. Rows may be in any order and may span
 * any number of routes.
 */
export function computeLapFits(
  rows: readonly LapArrival[],
  /** Optional: every candidate cell's gate result, for the replay's report. */
  gates?: Map<string, GateResult>,
  /**
   * The rollout gate ({@link LAP_SERVED_ROUTE_IDS}). Overridden only by
   * `scripts/eta-replay/lap-fit.ts`, which has to be able to fit a route that
   * is not served yet — that is how a route earns its place.
   */
  servedRoutes: ReadonlySet<number> = LAP_SERVED_ROUTE_IDS,
): Map<string, LapFit> {
  // (route, stop) -> bus -> visits
  const cells = new Map<string, Map<string, LapArrival[]>>();
  for (const r of rows) {
    if (!(r.departedAt > r.arrivedAt)) continue;
    const k = `${r.routeId}:${r.stopId}`;
    let byBus = cells.get(k);
    if (!byBus) cells.set(k, (byBus = new Map()));
    let l = byBus.get(r.busName);
    if (!l) byBus.set(r.busName, (l = []));
    l.push(r);
  }
  interface Draft { key: string; slope: number; med: number; lapMed: number; n: number; se2: number; beta: number; samples: Sample[] }
  const drafts: Draft[] = [];
  for (const [key, byBus] of cells) {
    const periods: number[] = [];
    for (const l of byBus.values()) {
      l.sort((a, b) => a.arrivedAt - b.arrivedAt);
      for (let i = 1; i < l.length; i++) {
        const p = (l[i]!.departedAt - l[i - 1]!.departedAt) / 1000;
        if (p > PERIOD_MIN_SEC && p < PERIOD_MAX_SEC) periods.push(p);
      }
    }
    if (periods.length < MIN_PERIOD_SAMPLES) continue;
    const P = median(periods);
    if (!(P > 0)) continue;
    const samples: Sample[] = [];
    const allStands: number[] = [];
    for (const l of byBus.values()) {
      for (let i = 1; i < l.length; i++) {
        const v = l[i]!;
        const stand = (v.departedAt - v.arrivedAt) / 1000;
        if (!(stand >= 0 && stand <= MAX_STAND_SEC)) continue;
        allStands.push(stand);
        // A gap that is not a LAP — an overnight, a depot return, a bus off the
        // line for two hours — carries no slack and must not be fitted on. Five
        // such rows in ninety flip the sign of the whole correlation.
        const lap = (v.arrivedAt - l[i - 1]!.departedAt) / 1000;
        if (lap < LAP_BAND_LO * P || lap > LAP_BAND_HI * P) continue;
        samples.push({ lap, stand, day: etDay(v.arrivedAt) });
      }
    }
    if (samples.length < LAP_MIN_N) continue;
    const med = median(allStands);
    if (!(med >= LAP_MIN_MED_STAND_SEC)) continue;
    const xs = samples.map((s) => s.lap), ys = samples.map((s) => s.stand);
    const mx = mean(xs), my = mean(ys);
    let sxy = 0, sxx = 0;
    for (let i = 0; i < xs.length; i++) { sxy += (xs[i]! - mx) * (ys[i]! - my); sxx += (xs[i]! - mx) ** 2; }
    if (!(sxx > 0)) continue;
    const slope = sxy / sxx;
    const se = slopeSE(samples, slope, my - slope * mx, mx);
    if (!Number.isFinite(se)) continue;
    const sdx = Math.sqrt(sxx / xs.length);
    // The comparable, dimensionless slope: what one standard deviation of lap
    // does to the cell's median stand.
    const beta = (slope * sdx) / Math.max(1, med);
    const seBeta = (se * sdx) / Math.max(1, med);
    drafts.push({ key, slope, med, lapMed: median(xs), n: samples.length, se2: seBeta * seBeta, beta, samples });
  }
  if (!drafts.length) return new Map();
  // Empirical Bayes across cells: tau^2 is the spread of the true slopes, the
  // method-of-moments difference between the observed spread and the mean
  // sampling variance. Measured on 90 days it is ~0.08 against a mean
  // sampling variance of ~0.002, so at production sample sizes this weighs
  // essentially 1 — it is here so a thin or a fluky cell degrades to 1.0.
  const mb = mean(drafts.map((d) => d.beta));
  // With too few cells there is no cross-cell spread to estimate, and the
  // method-of-moments difference collapses to zero — which would shrink a
  // perfectly good fit to nothing. Then each cell is judged on its OWN
  // signal-to-noise instead: tau^2 is the mean squared slope, so
  // w = beta^2 / (beta^2 + se^2).
  const tau2 = drafts.length >= MIN_CELLS_FOR_POOLING
    ? Math.max(1e-6, mean(drafts.map((d) => (d.beta - mb) ** 2)) - mean(drafts.map((d) => d.se2)))
    : Math.max(1e-6, mean(drafts.map((d) => d.beta ** 2)));
  const out = new Map<string, LapFit>();
  for (const d of drafts) {
    const w = tau2 / (tau2 + d.se2);
    if (!(w > 0)) continue;
    // The serving gate, with the SHIPPED shrinkage weight (see gateCell). A
    // cell that does not beat the pooled median it would replace, by more than
    // its own day-to-day noise, is not served at all — and then the client
    // holds no fit for it and prices that stand exactly as before.
    const g = gateCell(d.key, d.samples, w, d.med);
    gates?.set(d.key, g);
    if (!g.pass) continue;
    // The rollout gate is applied AFTER the cell gate and never instead of it,
    // so `gates` records the full candidate table on every route — which is
    // what the next route's case is made from.
    if (!servedRoutes.has(Number(d.key.slice(0, d.key.indexOf(":"))))) continue;
    // Serve the weight as an EFFECTIVE n so the client's own n / (n + k), the
    // shape every other shrinkage in the estimator uses, reproduces it exactly.
    const nEff = Math.max(LAP_MIN_N, Math.round((LAP_SHRINK_K * w) / Math.max(1e-6, 1 - w)));
    out.set(d.key, { b: Number((d.slope / Math.max(1, d.med)).toFixed(7)), m: Math.round(d.lapMed), n: nEff });
  }
  return out;
}

// -- loading, and how often ---------------------------------------------------

/**
 * How far back the fit reads. `arrivals` is retained 90 days and every day of
 * it is usable: a cell's slope is stable per quarter (measured), so the window
 * is bounded by retention rather than by drift.
 *
 * IT WAS ALMOST SHORTENED TO 45, AND THE REASON IT WAS NOT IS THE POINT.
 * Measured on the Pi against a real snapshot, once `etDay` stopped costing
 * 166 us a call:
 *
 *     90 d   query 2,192 ms + fit 860 ms   187,499 rows   served {3:11, 3:121}
 *     45 d   query   674 ms + fit 321 ms    95,672 rows   served {3:11, 3:121}
 *     30 d   query   460 ms + fit 205 ms    64,810 rows   served {3:11, 3:121, 3:30}
 *
 * The served SET is the wrong invariant: what ships is the COEFFICIENTS, and
 * they move. Side by side, 90 d against 45 d:
 *
 *     3:11    lapB -9.285e-4 / -9.740e-4,  lapM 3030 / 3055 s,  lapN 3913 / 977
 *     3:121   lapB -10.011e-4 / -10.476e-4, lapM 2820 / 2827 s, lapN 41308 / 11937
 *
 * which over the laps those cells actually see is a **median 13.0 s of stand
 * at 344 Winchester (p95 19.1, max 29.4)** and 6.3 s at Union Station (N).
 * The paired rider-sim result the rollout gate rests on was measured with the
 * 90-day fit, so shortening the window would put a configuration in front of
 * riders that nothing had measured — the exact failure `predictions_log`
 * exists to end (a family of stability numbers scored against a client that
 * had not shipped since March). With `etDay` fixed the call is ~3.0 s against
 * 21.2 s, which is the defect gone; a third of three seconds does not buy an
 * unmeasured change to a coefficient a rider's countdown is built from.
 *
 * And read the 30-day row correctly: a THIRD Red cell appearing there is not
 * the shorter window finding more signal. It is the day-blocked gate
 * qualifying a cell on thinner evidence — the very failure the per-cell
 * bootstrap exists to refuse. "Shorter window, more cells served" is a warning,
 * not an improvement.
 */
export const LAP_FIT_WINDOW_DAYS = 90;
/**
 * How often it is recomputed. The fit is a property of the timetable, not of
 * the hour — nothing in it moves between two calibrator ticks — and it costs
 * about a second, so it does not belong on the 5-minute cadence.
 */
export const LAP_FIT_INTERVAL_MS = 6 * 60 * 60 * 1000;

interface Row { bus_name: string; route_id: number; stop_id: number; arrived_at: number; departed_at: number }
interface Queryable { prepare(sql: string): { all(...a: unknown[]): unknown[] } }

/**
 * Read the corpus and fit. Only cells whose MEAN closed visit already reaches
 * the layover floor are read at all — the `HAVING` cuts the row count by an
 * order of magnitude, and a cell under the floor could not have produced a fit
 * anyway ({@link LAP_MIN_MED_STAND_SEC}).
 */
export function loadLapFits(db: Queryable, nowMs: number = Date.now()): Map<string, LapFit> {
  const since = nowMs - LAP_FIT_WINDOW_DAYS * 86_400_000;
  const rows = db.prepare(`
    SELECT bus_name, route_id, stop_id, arrived_at, departed_at FROM arrivals
    WHERE departed_at IS NOT NULL AND arrived_at >= ?
      AND (route_id, stop_id) IN (
        SELECT route_id, stop_id FROM arrivals
        WHERE departed_at IS NOT NULL AND arrived_at >= ?
        GROUP BY route_id, stop_id
        HAVING count(*) >= ? AND avg((departed_at - arrived_at) / 1000.0) >= ?
      )
    ORDER BY arrived_at
  `).all(since, since, LAP_MIN_N, LAP_MIN_MED_STAND_SEC * 0.75) as Row[];
  return computeLapFits(rows.map((r) => ({
    busName: r.bus_name, routeId: r.route_id, stopId: r.stop_id,
    arrivedAt: r.arrived_at, departedAt: r.departed_at,
  })));
}

/** Refreshes at most every {@link LAP_FIT_INTERVAL_MS}; never throws. */
export class LapFitCache {
  private fits: Map<string, LapFit> = new Map();
  private at = 0;
  constructor(private readonly db: Queryable) {}
  get(nowMs: number = Date.now()): ReadonlyMap<string, LapFit> {
    if (this.at !== 0 && nowMs - this.at < LAP_FIT_INTERVAL_MS) return this.fits;
    try {
      this.fits = loadLapFits(this.db, nowMs);
    } catch {
      // A fit that cannot be read is a fit that is not served: every stand
      // prices exactly as it did before.
    }
    this.at = nowMs;
    return this.fits;
  }
}
