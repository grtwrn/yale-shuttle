/**
 * Pricing the FIRST hop from a stand/drive split instead of a credit.
 *
 * A calibrated segment is arrival-to-arrival: it contains every second the
 * bus stood at A (40% of hop seconds, 72% of within-hop variance) as well as
 * the drive to B. Two things went wrong when that one number was the only
 * thing on offer (docs/eta-estimator-design.md):
 *
 *  - The stall credit `segAvg - min(elapsed, med)` is right until the median
 *    layover and then OPTIMISTIC: -29 s at r = 240, -43 at 300, -71 at 420,
 *    -101 at 600. A bus that has sat past its median is promised at the floor
 *    while the data says it has two more minutes. That is the "steady but
 *    wrong" number on the Red canary.
 *  - The instant `at_stop_id` clears, the hop switches to distance proration,
 *    which spreads seconds that were piled at metre zero along the metres:
 *    344 Winchester -> Winchester/Division, 557 s over 112 m, bills 0.33 x 557
 *    = 184 s for <= 37 m of road. Over 569 clean layover departures the
 *    promise to the next stop goes +16 s at the departure instant, +115 s at
 *    +30 s, +151 s at +45-60 s. The number RISES as the bus leaves.
 *
 * The fix is arithmetic, not a filter:
 *
 *   at the stop, r seconds in:   median(stand - r | stand > r) + drive
 *   en route, fraction t done:   drive x (1 - t)          (stand is never prorated)
 *
 * Measured on 30 days of arrivals (fit 23 / eval 7), the conditional median
 * scores 127 s MAE / +7 s bias at layover stops against the credit's 135 / +6,
 * and its bias is flat in r (+7, +6, +5, +4, +11, +12, +7, -3, +2, +20) where
 * the credit's changes sign. Dropping the elapsed term altogether costs
 * 203 / +141, so the clock earns its keep; only its form was the defect.
 *
 * INPUTS. `q` is a small ascending vector of quantiles of the standing time at
 * this stop (seconds from `at_stop_since` to the last poll at the stop), and
 * `drive` the seconds from that poll to arrival at the next stop, both served
 * by the calibrator from the departure derivation. `r` is measured on the same
 * clock (`now - at_stop_since`). Thin stops are shrunk toward a pooled shape
 * before serving; this module only reads what it is given.
 */

/**
 * Median of (S - r | S > r) for a standing time S whose distribution is given
 * by ascending quantiles `q` at levels (i + 0.5) / n.
 *
 * The quantiles are read as knots of a piecewise-linear CDF, not as a point
 * sample: the conditional median of a point sample steps UP each time r
 * crosses a sample value (the survivors' median moves to the next point), so
 * a rider would watch the number climb while the bus sat still. Inverting the
 * interpolated CDF keeps it continuous in r.
 *
 * Past the last quantile the CDF is closed linearly one inter-quantile gap
 * later, so a bus that has out-sat every recorded layover is not promised
 * "leaving now" — the measured remaining past r = 600 s is still ~2 min — and
 * the promise decays to zero instead of stepping there.
 */
export function remainingStandSec(q: readonly number[], r: number): number {
  const n = q.length;
  if (n === 0) return 0;
  const rr = Math.max(0, r);
  const last = q[n - 1]!;
  const gap = Math.max(30, n >= 2 ? last - q[n - 2]! : last / 2);
  const xs: number[] = [], ps: number[] = [];
  if (q[0]! > 0) { xs.push(0); ps.push(0); }
  for (let i = 0; i < n; i++) { xs.push(q[i]!); ps.push((i + 0.5) / n); }
  xs.push(last + gap); ps.push(1);
  const F = (x: number): number => {
    if (x <= xs[0]!) return ps[0]!;
    for (let i = 1; i < xs.length; i++) {
      if (x <= xs[i]!) {
        const w = xs[i]! - xs[i - 1]!;
        return w <= 0 ? ps[i]! : ps[i - 1]! + (ps[i]! - ps[i - 1]!) * (x - xs[i - 1]!) / w;
      }
    }
    return 1;
  };
  const Finv = (p: number): number => {
    for (let i = 1; i < xs.length; i++) {
      if (p <= ps[i]!) {
        const w = ps[i]! - ps[i - 1]!;
        return w <= 0 ? xs[i]! : xs[i - 1]! + (xs[i]! - xs[i - 1]!) * (p - ps[i - 1]!) / w;
      }
    }
    return xs[xs.length - 1]!;
  };
  const Fr = F(rr);
  if (Fr >= 1) return 0;
  return Math.max(0, Finv((Fr + 1) / 2) - rr);
}

/** Seconds still to bill on the first hop. */
export function priceFirstHop(
  stand: { q: readonly number[] } | undefined,
  driveSec: number,
  /** Seconds standing at the from-stop, or null when the bus is en route. */
  standingForSec: number | null,
  /** Fraction of the A->B chord already covered when en route (0..1). */
  progress: number,
): number {
  const drive = Math.max(0, driveSec);
  if (standingForSec !== null) {
    const rest = stand ? remainingStandSec(stand.q, standingForSec) : 0;
    return rest + drive;
  }
  const t = Math.max(0, Math.min(1, progress));
  return drive * (1 - t);
}
