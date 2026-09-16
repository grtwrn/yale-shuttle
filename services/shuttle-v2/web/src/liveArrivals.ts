import { computeUpcomingArrivals as estimate } from './arrivals';
import { serverArrivals } from './etaSource';

/** Live UI reads the server. Offline planning/tests retain the pure estimator. */
export function computeUpcomingArrivals(...args: Parameters<typeof estimate>): ReturnType<typeof estimate> {
  const [targets, buses, , , , now = Date.now()] = args;
  return serverArrivals(buses, targets, now) ?? estimate(...args);
}
