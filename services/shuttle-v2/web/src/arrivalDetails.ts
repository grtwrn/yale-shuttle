import { fmtMin, remainingSec } from './format';

/**
 * Shared by the card and the recorded rider replay. etaSec is already aged.
 *
 * `hold` names the stop the pinned bus is standing at (the priced stand —
 * liveAnchor.ts `resolveStandingStop`, with `near` for a hold short of the
 * marker). While it is set the headline is the hold, not the point: the point
 * is the median of a distribution whose leading term has already decayed —
 * under a long stand it collapses to the drive floor and reads "About 1 min"
 * minutes before the pickup can happen (2026-09-17 ride eval: "About 4 min"
 * → "About 1 min" in six seconds, six minutes before "At your stop"). The
 * window stays; it is the claim the distribution supports during a hold.
 */
export function arrivalSummary(etaSec: number, low?: number, high?: number, computedAt?: number, now = Date.now(), atPickup = false, hold?: { at: string; near?: boolean }) {
  const band = atPickup ? null : predictionWindow(low, high, computedAt, now);
  const point = atPickup ? 'At your stop'
    : hold ? `Waiting ${hold.near ? 'near' : 'at'} ${hold.at}`
    : `About ${etaSec < 60 ? '<1 min' : fmtMin(etaSec)}`;
  const sub = atPickup ? null
    : band ? (hold ? `Likely arrives ${band.text}` : `Likely ${band.text}`)
    : hold ? `About ${fmtMin(etaSec)} away`
    : null;
  return { point, band, sub, token: `${point}${sub ? `\n${sub}` : ''}` };
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
  // "<1–1 min" is the one adjacent pair that is not a range — the tokens
  // differ only by the "<", so it is two spellings of about a minute (the
  // departure chip's rule, standWait.ts `standLeftText`).
  const text = first === String(last) ? `${last} min`
    : first === '<1' && last === 1 ? '~1 min'
    : `${first}–${last} min`;
  return { lowSec, highSec, text };
}

/** The difference of two arrival estimates is an estimated gap, not a
 * confidence interval for the gap: the two buses' delays may be correlated.
 */
export function estimatedGap(leadSec: number, nextSec?: number | null): number | null {
  if (nextSec == null || !Number.isFinite(leadSec) || !Number.isFinite(nextSec) || nextSec < leadSec) return null;
  return nextSec - leadSec;
}
