import { haversineMeters, type LatLon } from './geo';
import type { TripOption } from './planner';

/** The countdown may precede the pickup used for the trip. Destination
 * availability must not erase that selected vehicle or occurrence. */
export function tripBusIdentity(option: Pick<TripOption, 'busName' | 'journeyArrival' | 'livePickupSelection' | 'etaUnavailable' | 'departed'>) {
  const normalize = (name: string) => name.replace(/^#/, '');
  const pickup = normalize(option.busName);
  const usable = !option.etaUnavailable && !option.departed;
  const selection = usable ? option.livePickupSelection : undefined;
  const ride = normalize(selection?.boarding.busName
    || (usable ? option.journeyArrival?.busName : undefined) || pickup);
  const different = !!pickup && !!ride && pickup !== ride;
  const laterVisit = selection?.relation === 'same-bus-later-visit';
  return { pickup, ride, different, laterVisit, separateWait: different || laterVisit };
}

/** Within this of the rider a bus of the line is the one they are on — the
 * radius the aboard offer in TransitMap already uses for "moving with it". */
export const BOARDING_BUS_M = 100;

/** The unnamed "I'm on it" is tapped as the bus pulls in or away, and that is
 * the poll in which the card hands its row on: the bus at the curb passes the
 * pickup, is re-priced a lap out, and the next vehicle takes the row
 * (wrongbusboard20261002: #122 at Orange / Avon, the card had just switched to
 * #331 46 min away, and the ride tracked #331). So the tap means the line's bus
 * with the rider — the card's own when it is one of them, else the nearest —
 * and the card's bus when none is, so a ride can still start before it comes. */
export function boardingBusName(cardBus: string, lineBuses: readonly { bus_name: string; lat: number; lon: number }[], at: LatLon | null | undefined): string {
  const normalize = (name: string) => name.replace(/^#/, '');
  const card = normalize(cardBus);
  if (!at) return card;
  const near = lineBuses
    .map(b => ({ name: normalize(b.bus_name), m: haversineMeters(at, b) }))
    .filter(b => b.m <= BOARDING_BUS_M)
    .sort((a, b) => a.m - b.m);
  return near.length && !near.some(b => b.name === card) ? near[0]!.name : card;
}
