/** A presentation warning, not an adjustment to the ETA model. */
export function pickupUncertainty(lastMovedAt: string | null | undefined, now: number): string | null {
  if (!lastMovedAt || !Number.isFinite(now)) return null;
  // Collector timestamps are UTC without a suffix; also accept explicit offsets.
  const stamp = /(?:Z|[+-]\d{2}:\d{2})$/i.test(lastMovedAt) ? lastMovedAt : `${lastMovedAt}Z`;
  const elapsed = now - Date.parse(stamp);
  // Five minutes avoids announcing ordinary boarding pauses. This describes
  // the reported position, which cannot distinguish a hold from stale GPS.
  if (!Number.isFinite(elapsed) || elapsed < 5 * 60_000) return null;
  return `Bus position unchanged for ${Math.floor(elapsed / 60_000)} min. Pickup time is uncertain.`;
}
