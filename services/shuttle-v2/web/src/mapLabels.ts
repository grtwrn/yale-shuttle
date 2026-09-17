import { arrivalSummary } from './arrivalDetails';
import { shownStandSec, type DwellStat, type DwellTimes } from './arrivals';

type Rect = { left: number; top: number; right: number; bottom: number };
/** Keep waiting labels above their bus, inside the map and clear of ETA chips.
 * Prefer the smallest displacement; no marker coordinates change. */
export function placeWaitLabel(rect: Rect, bounds: Rect, obstacles: Rect[]) {
  const w = rect.right - rect.left, h = rect.bottom - rect.top, gap = 6;
  const minX = bounds.left + gap, maxX = bounds.right - gap - w;
  const xs = [rect.left, minX, maxX, ...obstacles.flatMap(o => [o.left - gap - w, o.right + gap])]
    .map(x => Math.max(minX, Math.min(maxX, x)));
  const ys = [rect.top, ...obstacles.map(o => o.top - gap - h)]
    .filter(y => y >= bounds.top + gap && y <= rect.top);
  const choices = xs.flatMap(x => ys.map(y => ({ x, y }))).filter(({ x, y }) =>
    obstacles.every(o => x + w + gap <= o.left || x >= o.right + gap || y + h + gap <= o.top || y >= o.bottom + gap));
  choices.sort((a, b) => (a.x - rect.left) ** 2 + (a.y - rect.top) ** 2 - ((b.x - rect.left) ** 2 + (b.y - rect.top) ** 2));
  const best = choices[0];
  return best ? { x: best.x - rect.left, y: best.y - rect.top } : { x: 0, y: 0 };
}

/** Stable roles for the same forecast: the point never replaces its window.
 * Reports 113/114 crossed the old rounded-width cutoffs on ordinary ticks. */
export function mapArrivalLabel(arrival: { eta: number; low?: number; high?: number; computedAtMs?: number }, now = Date.now(), atPickup = false) {
  if (!Number.isFinite(arrival.eta) || arrival.eta < 0) return null;
  const { point, band } = arrivalSummary(arrival.eta, arrival.low, arrival.high, arrival.computedAtMs, now, atPickup);
  return { point, window: band ? `Likely ${band.text}` : null };
}

/** Observed elapsed time and typical TOTAL stand, never typical minus elapsed.
 * Only label wait stops (the same >=3-minute typical hold used in stop lists). */
export function mapWaitLabel(standing: { stopId: number; standingSec: number; approach?: boolean } | null,
  routeDwells: Record<string, DwellStat>, dwells: DwellTimes | undefined) {
  if (!standing || !Number.isFinite(standing.standingSec) || standing.standingSec < 0) return null;
  const stat = routeDwells[String(standing.stopId)];
  const typical = stat && stat.n >= 3 ? shownStandSec(stat, null, routeDwells, dwells)?.sec : undefined;
  if (typical === undefined || !Number.isFinite(typical) || typical < 180) return null;
  const elapsed = Math.floor(standing.standingSec);
  return {
    elapsed: `Waiting${standing.approach ? ' nearby' : ''} ${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')}`,
    typical: `Usually ~${Math.round(typical / 60)} min total`,
    overdue: standing.standingSec >= typical,
  };
}
