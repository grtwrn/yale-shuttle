import { etDayAndMinutes } from './schedule';

export const PICKUP_SERVICE_SOURCE = 'https://your.yale.edu/campus-essentials/getting-around-campus/using-the-shuttle/west-campus-shuttle';
export const DISPATCH_SOURCE = 'https://your.yale.edu/campus-essentials/getting-around-campus/using-the-shuttle/contact-us';

export interface PickupRequest {
  kind: 'call-dispatch';
  stopName: string;
  message: string;
}

/** Published stop service, independent of a bus's modeled pass by the pole.
 * Yale's current West Campus page requires a requested Union Station stop on
 * Purple beginning at noon. A nearby bus or a recent served pass is not
 * evidence that this rider's request has been made or accepted.
 * Verified against the official page on 2026-10-23; other lines/stops retain
 * their existing rules. This does not model physical service probabilities. */
export function pickupRequestFor(routeLabel: string, stopId: number, at: Date): PickupRequest | undefined {
  if (routeLabel !== 'Purple' || ![121, 122].includes(stopId) || !Number.isFinite(at.getTime())
    || etDayAndMinutes(at).mins < 12 * 60) return undefined;
  return {
    kind: 'call-dispatch', stopName: 'Union Station',
    message: 'Purple service at Union Station is on request after noon. Call Dispatch to request your stop before waiting here.',
  };
}
