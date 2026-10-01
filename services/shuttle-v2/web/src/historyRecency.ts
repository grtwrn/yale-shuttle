/** Descriptive history only. Never used to price a live arrival. */
export const HISTORY_HALF_LIFE_DAYS = 2;
const HALF_LIFE_MS = HISTORY_HALF_LIFE_DAYS * 86_400_000;

export function historyRecency(trips: readonly { arrivedAt: number; actualSec: number }[], asOf: number) {
  const weights = trips.map(t => Number.isFinite(asOf) && Number.isFinite(t.arrivedAt)
    && Number.isFinite(t.actualSec) && t.actualSec > 0 && t.arrivedAt <= asOf
    ? 2 ** (-(asOf - t.arrivedAt) / HALF_LIFE_MS) : 0);
  const total = weights.reduce((sum, w) => sum + w, 0);
  const squares = weights.reduce((sum, w) => sum + w * w, 0);
  const effectiveTrips = squares > 0 ? total * total / squares : 0;
  let median: number | null = null;
  // Apply the existing five-trip summary threshold to the weighted evidence:
  // many almost-weightless old trips must not disguise one dominant trip.
  if (effectiveTrips + 1e-9 >= 5) {
    const ordered = trips.map((t, i) => ({ value: t.actualSec, weight: weights[i]! }))
      .filter(t => t.weight > 0).sort((a, b) => a.value - b.value);
    let cumulative = 0;
    for (let i = 0; i < ordered.length; i++) {
      cumulative += ordered[i]!.weight;
      if (cumulative < total / 2 - total * 1e-12) continue;
      // Equal-weight even samples retain the usual midpoint convention.
      median = Math.abs(cumulative - total / 2) <= total * 1e-12 && i + 1 < ordered.length
        ? (ordered[i]!.value + ordered[i + 1]!.value) / 2 : ordered[i]!.value;
      break;
    }
  }
  return { weights, median, effectiveTrips };
}
