import { fmtMin, remainingSec } from './format';

/** Shared by the card and the recorded rider replay. etaSec is already aged. */
export function arrivalSummary(etaSec: number, low?: number, high?: number, computedAt?: number, now = Date.now(), atPickup = false) {
  const point = atPickup ? 'At your stop' : `About ${etaSec < 60 ? '<1 min' : fmtMin(etaSec)}`;
  const band = atPickup ? null : predictionWindow(low, high, computedAt, now);
  return { point, band, token: `${point}${band ? `\nLikely ${band.text}` : ''}` };
}

/** Keep the full prediction window in the disclosure, even when it is wide.
 * Round outwards: rounding the upper endpoint down would overstate precision.
 */
export function predictionWindow(low?: number, high?: number, computedAt?: number, now = Date.now()) {
  if (low == null || high == null || !Number.isFinite(low) || !Number.isFinite(high) || high < low) return null;
  const lowSec = remainingSec(low, computedAt, now), highSec = remainingSec(high, computedAt, now);
  if (highSec <= 0) return null;
  const first = lowSec < 60 ? '<1' : String(Math.floor(lowSec / 60));
  const last = Math.max(1, Math.ceil(highSec / 60));
  return { lowSec, highSec, text: first === String(last) ? `${last} min` : `${first}–${last} min` };
}

/** The difference of two arrival estimates is an estimated gap, not a
 * confidence interval for the gap: the two buses' delays may be correlated.
 */
export function estimatedGap(leadSec: number, nextSec?: number | null): number | null {
  if (nextSec == null || !Number.isFinite(leadSec) || !Number.isFinite(nextSec) || nextSec < leadSec) return null;
  return nextSec - leadSec;
}
