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
