/**
 * The diurnal factor on a stand: how much longer or shorter a bus stands at a
 * given ET hour than it does at that stop on an average day.
 *
 * WHY THIS IS A FACTOR, ESTIMATED ABOVE THE STOP, AND SMALL.
 *
 * The split tables are pooled over the whole window rather than sliced by
 * (dow, hour) for a measured reason (calibrator.ts, SPLIT_WINDOW_DAYS): a
 * stop sees ~25 stopped visits on a good day and a (stop, hour) cell holds a
 * MEDIAN OF THREE positive stands (2,436 cells over the 2026-09-03..08
 * record; 504 reach six, 32 reach ten). Slicing thinner is not an option, so
 * the effect is estimated at the level that HAS data — the CLASS of stop,
 * layover or kerb, pooled over every stand in the fleet — and a stop's own
 * hourly deviation borrows strength from that, shrunk by its own count.
 *
 * The estimator is a ratio of GEOMETRIC MEANS, within cell:
 *
 *     F(class, h) = exp( mean over visits of that class at h of
 *                        log(stand / the cell's own all-hours geometric mean) )
 *
 * Within-cell, because the route and stop mix changes by the hour — night
 * lines run at night — so a raw hourly pooled median measures the mix, not
 * the clock. Geometric mean rather than a median of log ratios because the
 * stands are quantised by the 5 s poll: on this record a median of log ratios
 * lands on an exact tie and reads 1.000 at eleven hours out of twenty, while
 * the geometric mean is the maximum-likelihood multiplicative summary under
 * the lognormal shape these stands actually have.
 *
 * POSITIVE STANDS ONLY. A pass is a 0 s stand in `q` (that zero mass IS
 * P(stop)), and 0 has no logarithm. It is also a different question: whether
 * the bus stops at all is ridership, how long it stands once stopped is the
 * stand. Scaling a quantile vector multiplicatively leaves 0 at 0, so the
 * factor moves the stand and leaves P(stop) exactly where the calibrator
 * measured it — which is why a factor is the right shape and an additive
 * offset is not.
 *
 * HOW BIG IT IS, MEASURED (docs/eta-ring-posterior.md §2.1). On the record
 * the model prices stands from, the weekday factor sits within ±6% of 1 at
 * every hour of the service day, with 95% intervals of ±4–10%; the only hour
 * clearly off 1 is 08:00 (+5.5% overall, +9.3% at kerb stops). Against a
 * within-stop spread of p75/p25 = 1.89 that is small, and the honest reading
 * is that this term earns its place by being CORRECT and inert, not by moving
 * the median today. It grows into the data: with five days of `stop_visits`
 * almost every cell leans on its class; at thirty days the stops that have
 * their own hour will use it.
 *
 * SHRINKAGE. k = 12 is not a taste. The per-visit spread of log(stand) inside
 * a cell is σ ≈ 0.55; the spread of the true per-(stop, hour) deviation is
 * bounded by the class-level swing at τ ≲ 0.15. The variance-minimising
 * weight is k = σ²/τ² ≈ 13, so a cell of three keeps a fifth of its own
 * shape, a cell of twelve half, a cell of a hundred nearly all.
 */

/** Pseudo-samples the class profile is worth against a stop's own hour. */
export const STAND_HOUR_SHRINK_K = 12;

/**
 * A (stop, hour) cell is put ON THE WIRE only from this many positive stands.
 *
 * This is a payload budget, not a statistical one — `/api/buses` is ~134 KB
 * and polled every 5 s, and the whole hourly block has to stay in single-digit
 * kilobytes. Six is where the served cell count settles around 500 (~8 KB
 * raw, ~2 KB gzipped). A cell below it would have carried at most
 * 5 / (5 + 12) = 29% of its own weight anyway; without it the client uses the
 * class factor, which is where two thirds of the answer comes from either way.
 */
export const STAND_HOUR_MIN_CELL = 6;

/** A class-hour entry needs this many positive stands to be published at all. */
export const STAND_HOUR_MIN_CLASS = 30;

/**
 * The CLASS factor is itself shrunk toward 1 by its own precision — the same
 * empirical-Bayes move as `STAND_HOUR_SHRINK_K`, one level up, because a
 * class-hour is an estimate too and the two classes are not equally measured.
 *
 * k = sigma^2 / tau^2 again: the per-visit spread of log(stand) is
 * sigma ~ 0.55, and the spread of the TRUE hour effect across hours is what
 * the well-sampled class shows — tau ~ 0.06 on the kerb class, whose hours
 * carry 150-560 positive stands each. So k = 0.55^2 / 0.06^2 ~ 84.
 *
 * This is not decoration. On the 2026-09-04 tables the layover class has only
 * ~45 positive stands an hour (a 95% interval of x1.19 on the factor) and its
 * raw 15:00 factor read 1.375; the kerb class has 150-560 (x1.05-x1.09). Left
 * raw, that one loose layover hour moved the 15:00 gps-replay bucket from
 * 10.8% to 23.9% pessimistic while every well-sampled hour improved. Shrunk,
 * a 45-sample class-hour keeps a third of its excursion and a 400-sample one
 * keeps five sixths — which is exactly how confident each is.
 */
export const STAND_HOUR_CLASS_K = 84;

/** A cell needs this many positive stands before it can anchor its own baseline. */
export const STAND_HOUR_MIN_BASE = 8;

/**
 * The factor is clamped to this band on BOTH sides of the wire. A stand table
 * cannot plausibly double or halve with the clock, and a corrupt cell must not
 * be able to move a countdown by more than the tables themselves can.
 */
export const STAND_HOUR_MIN_FACTOR = 0.5;
export const STAND_HOUR_MAX_FACTOR = 2;

export const HOURS = 24;

/** Positive stands at one (route, stop, ET hour), already logged. */
export interface HourCell {
  key: string;
  hour: number;
  n: number;
  /** Σ log(stand_sec) over those n visits. */
  logSum: number;
}

/**
 * The two class profiles, by ET hour. `layover[h]` / `ordinary[h]` are
 * multiplicative factors (1 = no effect, and 1 wherever the hour has too few
 * samples to publish); `layoverN[h]` / `ordinaryN[h]` are the positive stands
 * behind them, so a client can gate on evidence rather than on our word.
 */
export interface StandHourProfile {
  layover: number[];
  ordinary: number[];
  layoverN: number[];
  ordinaryN: number[];
}

export function clampFactor(f: number): number {
  if (!Number.isFinite(f) || f <= 0) return 1;
  return Math.min(STAND_HOUR_MAX_FACTOR, Math.max(STAND_HOUR_MIN_FACTOR, f));
}

export function emptyProfile(): StandHourProfile {
  return {
    layover: new Array(HOURS).fill(1),
    ordinary: new Array(HOURS).fill(1),
    layoverN: new Array(HOURS).fill(0),
    ordinaryN: new Array(HOURS).fill(0),
  };
}

/** The cell's own all-hours geometric mean, or null when it has too few. */
export function cellBaseline(cells: readonly HourCell[]): number | null {
  let n = 0, s = 0;
  for (const c of cells) { n += c.n; s += c.logSum; }
  return n >= STAND_HOUR_MIN_BASE ? s / n : null;
}

/**
 * The class profiles, from every cell's hours normalised by its own baseline.
 * `classOf` returns "layover" | "ordinary" | null (a cell with no table).
 */
export function buildProfile(
  byCell: ReadonlyMap<string, readonly HourCell[]>,
  classOf: (key: string) => "layover" | "ordinary" | null,
): StandHourProfile {
  const acc = {
    layover: { n: new Array(HOURS).fill(0), s: new Array(HOURS).fill(0) },
    ordinary: { n: new Array(HOURS).fill(0), s: new Array(HOURS).fill(0) },
  };
  for (const [key, cells] of byCell) {
    const cls = classOf(key);
    if (!cls) continue;
    const base = cellBaseline(cells);
    if (base === null) continue;
    const a = acc[cls];
    for (const c of cells) {
      if (c.hour < 0 || c.hour >= HOURS) continue;
      a.n[c.hour] += c.n;
      a.s[c.hour] += c.logSum - c.n * base;
    }
  }
  const out = emptyProfile();
  for (let h = 0; h < HOURS; h++) {
    out.layoverN[h] = acc.layover.n[h]!;
    out.ordinaryN[h] = acc.ordinary.n[h]!;
    for (const cls of ["layover", "ordinary"] as const) {
      const n = acc[cls].n[h]!;
      if (n < STAND_HOUR_MIN_CLASS) continue;
      // The raw within-cell log ratio, damped by how well this class-hour is
      // measured: n / (n + STAND_HOUR_CLASS_K).
      out[cls][h] = clampFactor(Math.exp((acc[cls].s[h]! / n) * (n / (n + STAND_HOUR_CLASS_K))));
    }
  }
  return out;
}

/**
 * A stop's OWN hourly factors, raw (unshrunk) and only where the wire budget
 * allows — the client does the shrinking, exactly as it does for `q`, so the
 * two gates cannot drift apart. Returns null when the cell has nothing to say.
 */
export function stopHourFactors(cells: readonly HourCell[]): { hq: number[]; hqn: number[] } | null {
  const base = cellBaseline(cells);
  if (base === null) return null;
  const hq = new Array(HOURS).fill(0);
  const hqn = new Array(HOURS).fill(0);
  let any = false;
  for (const c of cells) {
    if (c.hour < 0 || c.hour >= HOURS || c.n < STAND_HOUR_MIN_CELL) continue;
    hq[c.hour] = Math.round(100 * clampFactor(Math.exp(c.logSum / c.n - base)));
    hqn[c.hour] = c.n;
    any = true;
  }
  return any ? { hq, hqn } : null;
}
