/** Maximum silence while actively viewing the page; hidden time is excluded. */
export const LIVE_UPDATE_STALE_MS = 45_000;

/** Keep the last useful map, but stop presenting an interrupted feed as live. */
export function liveUpdateMessage(
  lastSuccessAt: number | null,
  startedAt: number,
  now: number,
  failed: boolean,
  hidden = false,
): string | null {
  if (!failed && (hidden || now - Math.max(lastSuccessAt ?? startedAt, startedAt) < LIVE_UPDATE_STALE_MS)) return null;
  return lastSuccessAt === null
    ? "Live bus updates unavailable. Reconnecting…"
    : "Live bus updates interrupted. Times and positions may be out of date. Reconnecting…";
}
