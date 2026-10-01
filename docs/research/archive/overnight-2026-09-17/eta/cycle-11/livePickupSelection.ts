import type { UpcomingArrival } from './arrivals';
import type { LiveArrivalPick } from './planner';

/** Evidence within one live selection, not a durable physical visit ID. */
export type PickupEvidence =
  | { source: 'forecast'; busName: string; stopId: number; stopsAhead: number;
      etaSec: number; lowSec: number; highSec: number }
  | { source: 'raw-at-stop'; busName: string; stopId: number };

export type LivePickupSelection = {
  /** Client computation time; transport freshness is checked by the caller. */
  selectedAtMs: number;
  countdown: PickupEvidence;
  boarding: PickupEvidence;
  relation: 'same-visit' | 'different-bus' | 'same-bus-later-visit' | 'raw-current';
};

type PickupRow = Pick<UpcomingArrival, 'busName' | 'stopId' | 'stopsAhead' | 'eta' | 'low' | 'high'>;
const normalize = (name: string) => name.replace(/^#/, '');

function forecast(row: PickupRow): Extract<PickupEvidence, { source: 'forecast' }> {
  return { source: 'forecast', busName: normalize(row.busName), stopId: row.stopId,
    stopsAhead: row.stopsAhead, etaSec: row.eta, lowSec: row.low, highSec: row.high };
}

/** Project the exact current selector result. Never choose or re-price a bus.
 * Both rows belong to one boarding stop in the same route/forecast snapshot.
 * The selector orders a later same-bus pickup after the countdown occurrence.
 * Relative stopsAhead must not be persisted or compared across polls as an ID. */
export function forecastPickupSelection(
  picked: LiveArrivalPick<PickupRow> | null, selectedAtMs: number,
): LivePickupSelection | undefined {
  if (!picked || picked.departed) return undefined;
  const countdown = forecast(picked.match), boarding = forecast(picked.boardable);
  const relation = countdown.busName !== boarding.busName ? 'different-bus'
    : countdown.stopId === boarding.stopId && countdown.stopsAhead === boarding.stopsAhead
      ? 'same-visit' : 'same-bus-later-visit';
  return { selectedAtMs, countdown, boarding, relation };
}

/** Preserve the raw override's chosen vehicle without borrowing a next-lap row.
 * This is existing sensor/selection evidence, not a guarantee of catchability. */
export function rawPickupSelection(busName: string, stopId: number, selectedAtMs: number): LivePickupSelection {
  const raw: PickupEvidence = { source: 'raw-at-stop', busName: normalize(busName), stopId };
  return { selectedAtMs, countdown: raw, boarding: raw, relation: 'raw-current' };
}
