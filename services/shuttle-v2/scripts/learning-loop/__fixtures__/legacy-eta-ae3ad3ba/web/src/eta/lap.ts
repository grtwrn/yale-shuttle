/**
 * THE BUS'S OWN LAP TIME, as a correction to the stand it is about to take.
 *
 * At a regulated layover the pooled table is the dominant ETA defect: 344
 * Winchester's served vector is [14,116,140,180,267,334,387,450,554,701], an
 * unconditional median of 4:43 with a 687 s spread, and every downstream
 * number inherits it. One covariate splits it. `lap` is the seconds between
 * THIS bus's previous departure from THIS stop and its next arrival there —
 * how much of the scheduled cycle the bus has already spent — and a bus that
 * comes back early discharges the slack standing:
 *
 *     344 Winchester, 90 days of arrivals, 1,667 laps
 *     lap 0.7-0.9 x period   n=126   median stand 12:05
 *     lap 0.9-1.1 x period   n=1331               9:20
 *     lap 1.1-1.4 x period   n=209                4:05
 *
 * It is STATE, not identity — which is why it is safe where per-bus tables
 * were refused as a selection artefact — and the compensation is PARTIAL: the
 * fitted slope is about -0.5 s of stand per second of lap, not -1 (OLS -0.49
 * at 344 Winchester over 90 days, -0.44 at Union Station (N)). A rule that
 * hard-codes -1 (PR #184's `period - lap`) over-corrects.
 *
 * WHAT IS NOT HERE, and why. The gap to the bus in front — the other half of
 * the regulation story — was measured on the same 90 days. Conditioned on
 * lap it is real at the regulated cells (partial correlation -0.21 at 344
 * Winchester on n=1,635, -0.30 at Union Station (N) route 13, CIs excluding
 * zero at 14 of 27 cells) and it REVERSES SIGN at seven others, and adding it
 * to the fit moves the held-out stand MAE by 0.9 s of 111.8. It does not earn
 * a wire field.
 *
 * A LAP IS NOT ANY GAP. Five of ninety-five "laps" at 344 Winchester in the
 * archive were overnight or multi-day gaps — the longest 7,084 minutes — and
 * those five alone flip the linear correlation from -0.27 to +0.13. A bus
 * returning from the depot carries no slack, so the correction must be OFF
 * for it: outside [LAP_BAND_LO, LAP_BAND_HI] x the fitted reference lap the
 * factor is exactly 1.
 *
 * APPLIED CONTINUOUSLY, WHICH IS THE WHOLE POINT. PR #184 read its correction
 * once, for the stop the bus is standing at right now, so it arrived as a STEP
 * the size of the correction itself: on held-out Red it fixed 3 jumps >= 180 s
 * and introduced 43. The previous departure from a stop is known a mean of
 * 53-56 minutes before the stand it predicts, so the factor is applied to
 * EVERY stand in the chain, from the moment the bus is a lap away, and it
 * converges with the arrival estimate rather than landing on it.
 */

/** The fit a cell carries, as served in its dwell table. */
export interface LapFit {
  /** Slope, as a FRACTION of the cell's median stand per second of lap (negative). */
  b: number;
  /** Reference lap, seconds: the fitted median, and the centre the factor pivots on. */
  m: number;
  /** Stands the fit was taken over. */
  n: number;
}

/**
 * Shrinkage denominator, read off the data and not chosen: the relative slope
 * `b x sd(lap)` has a between-cell variance of 0.087 against a day-block
 * sampling variance of 0.0023 (39 cells, 90 days), i.e. sigma^2 per
 * observation 1.7 and k = sigma^2 / tau^2 = 19. At production sample sizes
 * (hundreds to thousands of stands per cell) this weighs essentially 1; it is
 * here so a THIN cell degrades to exactly 1.0 rather than to a slope fitted
 * on twenty stands.
 */
export const LAP_SHRINK_K = 19;

/**
 * Outside this band of the reference lap there is no lap, and no correction.
 *
 * SWEPT, not chosen (90 days, 39 cells, held out on the last 40% of service
 * days, scoring EVERY visit in the test period so a band that corrects fewer
 * of them pays for it):
 *
 *     band x loop   held-out stand MAE
 *     none                128.7 s     <- the overnight gaps poison the fit
 *     0.50 - 2.00         117.9
 *     0.60 - 1.80         116.6
 *     0.65 - 1.65         116.1       <- here
 *     0.70 - 1.50         116.3
 *     0.80 - 1.30         117.5
 *     0.90 - 1.15         121.6       <- only 48% of visits still corrected
 *
 * The surface is flat to half a second from 0.60-1.80 to 0.75-1.40, so this is
 * not a knife edge. The correlation inside the band keeps STRENGTHENING as it
 * narrows (344 Winchester -0.638 -> -0.683) because a tighter band keeps a
 * more linear subset; that is not the same thing as a better estimate, and
 * MAE over every visit is what settles it.
 *
 * It is a MULTIPLE OF THE CELL'S OWN LOOP, never a window in minutes. Loops
 * differ by a factor of two across the network, and an absolute [40, 80] min
 * window — which fits Red's 59.8 min loop — keeps 74 of York / Cedar's 2,376
 * gaps (loop 40.3 min) and flips its correlation to +0.478, because all it
 * has left is double laps.
 */
export const LAP_BAND_LO = 0.65;
export const LAP_BAND_HI = 1.65;

/**
 * The factor is clamped to the 1st-99th percentile of its own fitted range
 * over 60,712 cell-visits (p1 0.02, p99 2.08): the linear form has heavy
 * tails, and a stand cannot be a quarter of its table because one lap ran
 * long.
 */
export const LAP_F_MIN = 0.35;
export const LAP_F_MAX = 2.0;

/** A fit is used only where the cell has enough stands to have one. */
export const LAP_MIN_N = 60;

export function lapFitOf(d: { lapB?: number | undefined; lapM?: number | undefined; lapN?: number | undefined } | undefined): LapFit | null {
  if (!d) return null;
  const { lapB: b, lapM: m, lapN: n } = d;
  if (b === undefined || m === undefined || n === undefined) return null;
  if (!Number.isFinite(b) || !Number.isFinite(m) || !Number.isFinite(n)) return null;
  if (!(m > 0) || !(n >= LAP_MIN_N)) return null;
  return { b, m, n };
}

/**
 * The multiplicative factor for a stand at a cell, given the lap the bus will
 * have run when it gets there. 1 exactly with no fit, no lap, or a gap that
 * is not a lap — so a payload without the fields, and every stop of every
 * route that has none, prices bit-identically to before.
 *
 * Multiplicative on the QUANTILE VECTOR (`dist.scaled`), following PR #164:
 * `S_scaled(x) = S(x / f)` keeps the residual of a stand given the time
 * already stood coherent, and leaves the mass at zero — P(stop) — untouched,
 * because 0 x f is 0.
 */
export function lapFactor(fit: LapFit | null, lapSec: number | null | undefined): number {
  if (!fit || lapSec === null || lapSec === undefined || !Number.isFinite(lapSec)) return 1;
  if (lapSec < LAP_BAND_LO * fit.m || lapSec > LAP_BAND_HI * fit.m) return 1;
  const w = fit.n / (fit.n + LAP_SHRINK_K);
  const f = 1 + w * fit.b * (lapSec - fit.m);
  return Math.min(LAP_F_MAX, Math.max(LAP_F_MIN, f));
}

/**
 * The seconds a bus's lap will have run by the time it REACHES a stop:
 * however long ago it left that stop, plus however long it is from getting
 * back. `ageSec` is the served number (`buses[].lap`, the server's
 * `stop_visits` — the client cannot compute it, it sees only live positions);
 * `etaSec` is this poll's own nominal time to the stop. Both move smoothly,
 * so the factor does too.
 */
export function lapAt(ageSec: number | null | undefined, etaSec: number): number | null {
  if (ageSec === null || ageSec === undefined || !Number.isFinite(ageSec) || ageSec < 0) return null;
  return ageSec + Math.max(0, etaSec);
}
