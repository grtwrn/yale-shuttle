import { mergedRouteStops, ROUTE_LISTS } from './routes';
import type { TransferPath, TransferRidePath } from './transferPaths';
import type { LiveTransferJourney } from './transferTiming';
import type { ScheduledTransferJourney } from './transferSchedule';

export type TransferTiming = LiveTransferJourney | ScheduledTransferJourney;
export interface TransferChoice {
  key: string;
  path: TransferPath;
  timing?: TransferTiming;
  preferences: ('closest-pickup' | 'less-walking' | 'earlier-arrival')[];
}
export const transferWalkingSec = (path: TransferPath) => path.walkToSec + path.transferWalkSec + path.walkFromSec;
const risk = (t: TransferTiming) => 'connection' in t ? Number(t.connection.uncertain || t.firstPickupUncertain) : 0;
const compareTime = (a: TransferTiming, b: TransferTiming) => a.totalSec - b.totalSec || risk(a) - risk(b)
  || ('connection' in a && 'connection' in b ? b.connection.bufferSec - a.connection.bufferSec : 0);

/** Keep the walking/arrival tradeoffs of each route pair, including its
 * closest first pickup. Forecast-hop numbers are never a selection key. */
export function chooseTransferOptions(paths: readonly TransferPath[], timings: readonly TransferTiming[]): TransferChoice[] {
  const times = new Map<string, TransferTiming>();
  for (const timing of timings) {
    const previous = times.get(timing.path.key);
    if (!previous || compareTime(timing, previous) < 0) times.set(timing.path.key, timing);
  }
  const groups = new Map<string, TransferChoice[]>();
  for (const path of paths) {
    const choice: TransferChoice = { key: path.key, path, preferences: [] };
    const timing = times.get(path.key); if (timing) choice.timing = timing;
    const key = JSON.stringify([path.first.routeLabel, path.second.routeLabel]);
    const group = groups.get(key); if (group) group.push(choice); else groups.set(key, [choice]);
  }
  const result = new Map<string, TransferChoice>();
  const time = (c: TransferChoice) => c.timing?.totalSec ?? Infinity;
  for (const group of groups.values()) {
    const walking = [...group].sort((a, b) => transferWalkingSec(a.path) - transferWalkingSec(b.path) || time(a) - time(b));
    const closest = [...group].sort((a, b) => a.path.walkToSec - b.path.walkToSec
      || transferWalkingSec(a.path) - transferWalkingSec(b.path) || time(a) - time(b));
    const timed = group.filter(c => c.timing).sort((a, b) => time(a) - time(b) || transferWalkingSec(a.path) - transferWalkingSec(b.path));
    for (const [choice, preference] of [[closest[0], 'closest-pickup'], [walking[0], 'less-walking'], [timed[0], 'earlier-arrival']] as const) {
      if (!choice) continue;
      const previous = result.get(choice.key);
      if (previous) previous.preferences.push(preference);
      else result.set(choice.key, { ...choice, preferences: [preference] });
    }
  }
  return [...result.values()].sort((a, b) => Number(!a.timing) - Number(!b.timing) || time(a) - time(b)
    || transferWalkingSec(a.path) - transferWalkingSec(b.path) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/** A persisted connection cannot assume the route still serves those calls. */
export function transferRideStillServed(path: TransferRidePath, routeStops: Record<string, number[]>): boolean {
  const cfg = ROUTE_LISTS.find(c => c.label === path.routeLabel);
  if (!cfg) return false;
  const stops = mergedRouteStops(cfg, routeStops);
  return stops.some((stop, start) => stop === path.boardStopId
    && path.stops.every((id, offset) => stops[(start + offset) % stops.length] === id));
}

/** A change earns a place beside direct rides when it offers walking/time
 * value or a pickup-risk tradeoff. Other connections remain selectable. */
export function transferAddsChoice(choice: TransferChoice, direct: readonly import('./planner').TripOption[], future: boolean): boolean {
  if (!choice.timing) return !direct.some(o => o.mode === 'shuttle' && !o.etaUnavailable && !o.departed);
  const value = choice.timing;
  return !direct.some(o => o.mode === 'shuttle' && !o.etaUnavailable && !o.departed
    && (future || !!o.journeyArrival)
    && o.walkToSec + o.walkFromSec <= transferWalkingSec(choice.path)
    && o.totalSec <= value.totalSec
    && (!o.journeyArrival?.catchRisk || (value.timing === 'live' && (value.firstPickupUncertain || value.connection.uncertain))));
}
