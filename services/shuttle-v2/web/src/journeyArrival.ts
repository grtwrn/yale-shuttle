import type { UpcomingArrival } from './arrivals';

export interface JourneyArrival {
  busName: string;
  distributionMs?: number[] | undefined;
  pointMs: number;
  lowMs: number;
  highMs: number;
  catchRisk: boolean;
  estimated: boolean;
}

/** One bus, one forward visit. Use its full destination distribution: adding
 * pickup and ride quantiles would double-count shared delays and correlations.
 * Walking is a point estimate; these are conditional shuttle windows, not
 * calibrated probabilities for a rider's complete journey. */
export function journeyArrival(
  board: UpcomingArrival | undefined,
  visits: readonly UpcomingArrival[],
  alightStopId: number,
  walkToSec: number,
  walkFromSec: number,
  now: number,
): JourneyArrival | undefined {
  if (!board || ![walkToSec, walkFromSec, board.eta, board.low, now].every(Number.isFinite)
    || walkToSec < 0 || walkFromSec < 0) return undefined;
  const ahead = visits.filter(a => a.busName === board.busName && a.routeLabel === board.routeLabel
    && a.stopsAhead > board.stopsAhead).sort((a, b) => a.stopsAhead - b.stopsAhead);
  const destination = ahead.find(a => a.stopId === alightStopId);
  const nextPickup = ahead.find(a => a.stopId === board.stopId);
  if (!destination || (nextPickup && nextPickup.stopsAhead < destination.stopsAhead)
    || ![destination.eta, destination.low, destination.high].every(Number.isFinite)
    || destination.eta < Math.max(board.eta, walkToSec) || destination.low < 0 || destination.high < destination.low) return undefined;
  return {
    busName: board.busName,
    ...(destination.distribution ? { distributionMs: destination.distribution.map(s => now + (s + walkFromSec) * 1000) } : {}),
    pointMs: now + (destination.eta + walkFromSec) * 1000,
    lowMs: now + (destination.low + walkFromSec) * 1000,
    highMs: now + (Math.max(destination.eta, destination.high) + walkFromSec) * 1000,
    // Do not count on a driver waiting. A bus already at pickup is only a
    // confident connection when the rider is there too (walkToSec === 0).
    catchRisk: walkToSec > Math.max(0, board.low),
    estimated: destination.estimated || board.estimated,
  };
}

export type DeadlineStatus = 'fits' | 'buffer' | 'late' | 'unknown';
export function deadlineStatus(latestMs: number | undefined, classMs: number, bufferMin: number): DeadlineStatus {
  if (latestMs === undefined || ![latestMs, classMs, bufferMin].every(Number.isFinite)) return 'unknown';
  if (latestMs <= classMs - bufferMin * 60_000) return 'fits';
  return latestMs <= classMs ? 'buffer' : 'late';
}

export function deadlineError(value: string, now: number): string | null {
  const at = Date.parse(value);
  if (!value || !Number.isFinite(at)) return 'Choose a class date and time.';
  return at <= now ? 'That class time has passed. Choose a future date and time.' : null;
}

export function localDateTime(at: number): string {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Round the window outward, never make a deadline look easier by rounding. */
export function arrivalClock(at: number, rounding: 'low' | 'high' | 'point' = 'point'): string {
  const round = rounding === 'low' ? Math.floor : rounding === 'high' ? Math.ceil : Math.round;
  const d = new Date(round(at / 60_000) * 60_000);
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return d.toDateString() === new Date().toDateString() ? time
    : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${time}`;
}
