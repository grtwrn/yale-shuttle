/** Conditional release hazard, fitted on completed pinned Red layovers.
 * Fifteen-second bins, nine features, L2 penalty4, bounded Newton solve.
 * Long waits contribute censored survival exposure through30minutes; they
 * are not discarded or converted into departures. Inference continues the
 * learned tail. The fit is cached on the server, never done in a browser.
 */
export interface Observation {
  a: number;
  ready: number;
  stop: number;
  lap: number | null;
  y: number;
  day: string;
}
export interface Fit {
  stopId: number;
  referenceLap: number;
  coefficients: number[];
  n: number;
  days: number;
}
const median = (a: number[]) => {
  a.sort((x, y) => x - y);
  return (
    (a[Math.floor((a.length - 1) / 2)]! + a[Math.ceil((a.length - 1) / 2)]!) / 2
  );
};
function solve(matrix: number[][], rhs: number[]): number[] {
  const a = matrix.map((r, i) => [...r, rhs[i]!]),
    n = rhs.length;
  for (let k = 0; k < n; k++) {
    let best = k;
    for (let i = k + 1; i < n; i++)
      if (Math.abs(a[i]![k]!) > Math.abs(a[best]![k]!)) best = i;
    [a[k], a[best]] = [a[best]!, a[k]!];
    const pivot = a[k]![k]!;
    if (Math.abs(pivot) < 1e-12) throw Error("singular hazard fit");
    for (let j = k; j <= n; j++) a[k]![j]! /= pivot;
    for (let i = 0; i < n; i++)
      if (i !== k) {
        const f = a[i]![k]!;
        for (let j = k; j <= n; j++) a[i]![j]! -= f * a[k]![j]!;
      }
  }
  return a.map((r) => r[n]!);
}
export function fitRelease(
  rows: Observation[],
  stopId: number,
  before: number,
): Fit | null {
  const tr = rows.filter(
    (r) =>
      r.stop === stopId && r.ready < before && Number.isFinite(r.y) && r.y >= 0,
  );
  const days = new Set(tr.map((r) => r.day)).size;
  const laps = tr.flatMap((r) =>
    r.lap !== null && r.lap > 900 && r.lap < 7200 ? [r.lap] : [],
  );
  if (tr.length < 60 || days < 3 || laps.length < 40) return null;
  const referenceLap = median(laps),
    xx: number[][] = [],
    yy: number[] = [];
  for (const r of tr) {
    const valid =
      r.lap !== null &&
      r.lap >= 0.65 * referenceLap &&
      r.lap <= 1.65 * referenceLap;
    const lap = valid ? (r.lap! - referenceLap) / 600 : 0,
      bins = Math.max(1, Math.ceil(Math.min(r.y, 1800) / 15));
    // Completed unusually long waits stay in the likelihood; no duration trim.
    for (let i = 0; i < bins; i++) {
      const t = (i + 0.5) * 15,
        angle = (2 * Math.PI * ((Math.floor(r.a / 1000) % 900) + t)) / 900;
      xx.push([
        1,
        Math.log1p(t / 60),
        t / 600,
        Math.max(t - 300, 0) / 600,
        Math.max(t - 600, 0) / 600,
        lap,
        valid ? 0 : 1,
        Math.sin(angle),
        Math.cos(angle),
      ]);
      yy.push(i === bins - 1 && r.y <= 1800 ? 1 : 0);
    }
  }
  const objective = (b: number[]) => {
    let out = 0;
    for (let k = 0; k < xx.length; k++) {
      const x = xx[k]!,
        z = x.reduce((s, v, i) => s + v * b[i]!, 0);
      out += Math.max(0, z) + Math.log1p(Math.exp(-Math.abs(z))) - yy[k]! * z;
    }
    for (let i = 1; i < 9; i++) out += 2 * b[i]! * b[i]!;
    return out;
  };
  let beta = Array(9).fill(0);
  const p = yy.reduce((a, b) => a + b, 0) / yy.length;
  if (!(p > 0 && p < 1)) return null;
  beta[0] = Math.log(p / (1 - p));
  let loss = objective(beta),
    converged = false;
  for (let iter = 0; iter < 50; iter++) {
    const g = Array(9).fill(0),
      h = Array.from({ length: 9 }, () => Array(9).fill(0));
    for (let k = 0; k < xx.length; k++) {
      const x = xx[k]!,
        z = x.reduce((s, v, i) => s + v * beta[i]!, 0),
        p = 1 / (1 + Math.exp(-z)),
        w = p * (1 - p),
        e = p - yy[k]!;
      for (let i = 0; i < 9; i++) {
        g[i] += e * x[i]!;
        for (let j = 0; j < 9; j++) h[i]![j] += w * x[i]! * x[j]!;
      }
    }
    for (let i = 1; i < 9; i++) {
      g[i] += 4 * beta[i]!;
      h[i]![i] += 4;
    }
    if (Math.max(...g.map(Math.abs)) < 1e-7) {
      converged = true;
      break;
    }
    const step = solve(h, g);
    let scale = 1,
      trial = beta,
      trialLoss = Infinity;
    for (let line = 0; line < 24; line++) {
      trial = beta.map((v, i) => v - scale * step[i]!);
      trialLoss = objective(trial);
      if (trialLoss <= loss) break;
      scale /= 2;
    }
    if (!Number.isFinite(trialLoss) || trialLoss > loss) return null;
    const change = Math.max(...trial.map((v, i) => Math.abs(v - beta[i]!)));
    beta = trial;
    loss = trialLoss;
    if (change < 1e-8) {
      converged = true;
      break;
    }
  }
  if (!converged || beta.some((v) => !Number.isFinite(v))) return null;
  return { stopId, referenceLap, coefficients: beta, n: tr.length, days };
}

interface Queryable {
  prepare(sql: string): { all(...a: unknown[]): unknown[] };
}
interface DepartureRow {
  bus_name: string;
  stop_id: number;
  departed_at: number;
}
interface VisitRow {
  bus_name: string;
  stop_id: number;
  pinned_at: number;
  departed_at: number;
  first_moved_at: number | null;
  confirm_sec: number | null;
}
const DAY_MS = 86_400_000;
const dayFormat = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const serviceDay = (at: number): string => dayFormat.format(new Date(at));

/** Read-only feature extraction. The current visit's eventual departure never
 * enters its lap or clock features. The availability delay mirrors the replay.
 */
export function loadReleaseObservations(
  db: Queryable,
  before: number,
): Observation[] {
  const since = before - 30 * DAY_MS;
  const previous = new Map<string, number[]>();
  const departures = db
    .prepare(
      `
    SELECT bus_name, stop_id, departed_at FROM arrivals
    WHERE route_id = 3 AND stop_id IN (11, 121) AND departed_at IS NOT NULL
      AND departed_at >= ? AND departed_at < ? ORDER BY departed_at
  `,
    )
    .all(since - DAY_MS, before) as DepartureRow[];
  for (const d of departures) {
    const key = `${d.bus_name}|${d.stop_id}`;
    if (!previous.has(key)) previous.set(key, []);
    previous.get(key)!.push(d.departed_at);
  }
  const visits = db
    .prepare(
      `
    SELECT bus_name, stop_id, pinned_at, departed_at, first_moved_at, confirm_sec
    FROM stop_visits WHERE route_id = 3 AND stop_id IN (11, 121)
      AND outcome = 'stopped' AND how != 'gap' AND closest_m <= 75
      AND pinned_at IS NOT NULL AND departed_at IS NOT NULL
      AND departed_at >= pinned_at AND pinned_at >= ? AND departed_at < ?
    ORDER BY pinned_at
  `,
    )
    .all(since, before) as VisitRow[];
  const prior = (bus: string, stop: number, at: number): number | undefined => {
    const ds = previous.get(`${bus}|${stop}`) ?? [];
    let lo = 0,
      hi = ds.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (ds[mid]! <= at - 120_000) lo = mid + 1;
      else hi = mid;
    }
    return lo ? ds[lo - 1] : undefined;
  };
  const out: Observation[] = [];
  for (const v of visits) {
    // Audited restart truncation, not a short-trip/outlier threshold. Raw GPS
    // showed a continuous439s hold split by restart into this30s record.
    // PR279 prevents recurrence. Preserve the original record in the database.
    if (
      v.bus_name === "#316" &&
      v.stop_id === 11 &&
      v.pinned_at === 1789656325854
    )
      continue;
    const ready = Math.max(
      v.departed_at + 120_000,
      (v.first_moved_at ?? v.departed_at) + (v.confirm_sec ?? 0) * 1000,
    );
    if (ready >= before) continue;
    const day = serviceDay(v.pinned_at);
    const dep = prior(v.bus_name, v.stop_id, v.pinned_at);
    const other = prior(v.bus_name, v.stop_id === 11 ? 121 : 11, v.pinned_at);
    const validLoop =
      dep !== undefined &&
      other !== undefined &&
      dep < other &&
      other < v.pinned_at &&
      serviceDay(dep) === day;
    out.push({
      a: v.pinned_at,
      ready,
      stop: v.stop_id,
      day,
      lap: validLoop ? (v.pinned_at - dep!) / 1000 : null,
      y: (v.departed_at - v.pinned_at) / 1000,
    });
  }
  return out;
}

/** Warm historical fit, refreshed at most once per six hours. */
export class ReleaseFitCache {
  private fits: ReadonlyMap<string, Fit> = new Map();
  private at = 0;
  private succeededAt = 0;
  constructor(private readonly db: Queryable) {}
  get(now: number = Date.now()): ReadonlyMap<string, Fit> {
    if (this.at && now - this.at < 6 * 60 * 60 * 1000) return this.fits;
    try {
      const rows = loadReleaseObservations(this.db, now);
      const next = new Map<string, Fit>();
      for (const stop of [11]) {
        const fit = fitRelease(rows, stop, now);
        if (fit) next.set(`3:${stop}`, fit);
      }
      this.fits = next;
      this.succeededAt = now;
    } catch {
      // Keep a recent successful fit through a transient read error. A stale
      // model eventually falls back to the existing marginal tables.
      if (now - this.succeededAt > DAY_MS) this.fits = new Map();
    }
    this.at = now;
    return this.fits;
  }
}
