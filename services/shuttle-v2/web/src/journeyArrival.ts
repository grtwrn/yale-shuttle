import type { UpcomingArrival } from './arrivals';
import { ETA_MAX_AGE_MS, serverTrack } from './etaSource';
import type { RawAtStopContext } from './planner';

/** Join a raw at-stop observation to an existing forecast visit. GPS can report
 * the curb while the estimator still has an approaching pickup. Only accept a
 * pickup before this bus's FIRST destination; a later lap cannot price the
 * board-now journey. The caller retains its raw boarding/dwell gate and pickup
 * countdown, and journeyArrival still checks folded-route visit order. */
export function atStopJourneyBoard(
  visits: readonly UpcomingArrival[],
  routeLabel: string,
  busName: string,
  boardStopId: number,
  alightStopId: number,
  current?: RawAtStopContext,
): UpcomingArrival | undefined {
  const norm = (name: string) => name.replace(/^#/, '');
  const sameBus = visits.filter(a => a.routeLabel === routeLabel && norm(a.busName) === norm(busName))
    .sort((a, b) => a.stopsAhead - b.stopsAhead);
  const arrived = sameBus.find(a => a.stopId === boardStopId && a.stopsAhead === 0 && a.eta === 0);
  if (arrived) return arrived;
  const firstDestination = sameBus.find(a => a.stopId === alightStopId);
  const forecastBoard = firstDestination && sameBus.find(a => a.stopId === boardStopId && a.stopsAhead < firstDestination.stopsAhead);
  if (forecastBoard) return forecastBoard;

  // Only callers that already accepted raw boarding and the walk/dwell gate
  // supply this context. Their visits come from the same published payload.
  // A missing current pickup row need not hide an existing onward forecast,
  // but a raw flag alone cannot establish which pass of a folded curb it is.
  if (!current || !firstDestination || current.routeLabel !== routeLabel
    || norm(current.bus.bus_name) !== norm(busName) || !Number.isFinite(current.now)
    || !Number.isFinite(current.bus.observed_at)
    || current.now - current.bus.observed_at! < 0
    || current.now - current.bus.observed_at! >= ETA_MAX_AGE_MS
    || current.bus.stationary !== true || current.bus.at_stop_id !== boardStopId) return undefined;
  const track = serverTrack(current.bus, routeLabel, current.now);
  const cycleLength = current.stops.length;
  if (!track || !track.standing || track.standing.stopId !== boardStopId || track.standing.approach
    || !Number.isInteger(track.index) || track.index < 0 || track.index >= cycleLength
    || track.index !== track.travel || current.stops[track.index] !== boardStopId
    || current.stops.filter(id => id === boardStopId).length !== 1
    || !Number.isInteger(firstDestination.stopsAhead) || firstDestination.stopsAhead <= 0
    || firstDestination.stopsAhead >= cycleLength
    // Without an explicit pickup visit, do not infer across the published
    // sequence wrap. This is an inference limit, not a service/day boundary.
    || track.index + firstDestination.stopsAhead >= cycleLength
    || current.stops[track.index + firstDestination.stopsAhead] !== alightStopId) return undefined;
  const firstReturn = sameBus.find(a => a.stopId === boardStopId && a.stopsAhead > 0);
  if (firstReturn && firstReturn.stopsAhead <= firstDestination.stopsAhead) return undefined;
  // This is a UI join for an accepted current pickup, not an extra server forecast.
  // In particular it carries no destination distribution or estimated wait.
  return { busName: firstDestination.busName, routeLabel, color: firstDestination.color,
    stopId: boardStopId, stopsAhead: 0, eta: 0, low: 0, high: 0,
    departNow: 0, lowFloor: 0, estimated: false };
}

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
  pickupState: 'forecast' | 'at-stop' = 'forecast',
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
    // Raw GPS may already place the bus at pickup while its forecast is still
    // approaching. That forecast does not establish that the driver will wait.
    catchRisk: walkToSec > (pickupState === 'at-stop' ? 0 : Math.max(0, board.low)),
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
