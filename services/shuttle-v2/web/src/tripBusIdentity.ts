import type { TripOption } from './planner';

/** The pickup countdown can follow a bus the walk model cannot catch.
 * Attribute the ride to the existing destination forecast without changing
 * either selection. Keep both identities available for manual boarding. */
export function tripBusIdentity(option: Pick<TripOption, 'busName' | 'journeyArrival' | 'etaUnavailable' | 'departed'>) {
  const normalize = (name: string) => name.replace(/^#/, '');
  const pickup = normalize(option.busName);
  const ride = !option.etaUnavailable && !option.departed && option.journeyArrival?.busName
    ? normalize(option.journeyArrival.busName) : pickup;
  return { pickup, ride, different: !!pickup && !!ride && pickup !== ride };
}
