import type { BusData } from './map-data';
import type { DwellTimes } from './arrivals';
import type { TransferRidePath } from './transferPaths';
import { liveTransferRideForecasts } from './transferTiming';
import { atStopJourneyBoard, journeyArrival } from './journeyArrival';
import { dwellBoardWindowSec, pickLiveArrival, rawAtStopBoardable } from './planner';
import { forecastPickupSelection, rawPickupSelection } from './livePickupSelection';
import { serverTrack } from './etaSource';
import { ROUTE_LISTS } from './routes';

/** The current leg's pickup is independent of the previous leg and of a
 * temporarily missing destination/connection estimate. */
export function transferPickup(path: TransferRidePath, buses: readonly BusData[], walkToSec: number,
  now: number, available: boolean, pinnedBusName = '', dwellTimes: DwellTimes = {}) {
  const source = liveTransferRideForecasts(path, buses, now, available);
  const cfg = ROUTE_LISTS.find(c => c.label === path.routeLabel);
  const norm = (name: string) => name.replace(/^#/, '');
  const here = available && cfg ? buses.filter(b => cfg.busRouteIds.includes(b.route_id)
    && b.at_stop_id === path.boardStopId && serverTrack(b, cfg.label, now) != null
    && rawAtStopBoardable(b.bus_name, path.boardStopId, path.alightStopId, source.visits)) : [];
  const atStop = here.find(b => norm(b.bus_name) === norm(pinnedBusName)) ?? here[0];
  if (atStop && walkToSec <= dwellBoardWindowSec(atStop, path.routeId, path.boardStopId, dwellTimes, now)) {
    const selection = rawPickupSelection(atStop.bus_name, path.boardStopId, now);
    const board = atStopJourneyBoard(source.visits, path.routeLabel, atStop.bus_name, path.boardStopId, path.alightStopId);
    return { source, selection, busName: norm(atStop.bus_name), boardingBusName: norm(atStop.bus_name), departed: false,
      destination: journeyArrival(board, source.visits, path.alightStopId, walkToSec, 0, now, 'at-stop'),
      option: { mode: 'shuttle', routeLabel: path.routeLabel, boardStopId: path.boardStopId, alightStopId: path.alightStopId,
        walkToSec, busEtaSec: 0, computedAtMs: now, livePickupSelection: selection } };
  }
  const picked = pickLiveArrival(source.pickups, pinnedBusName, walkToSec);
  const selection = forecastPickupSelection(picked, now);
  if (!picked || !selection) return { source, selection: undefined, busName: pinnedBusName,
    boardingBusName: '', departed: picked?.departed ?? false, destination: undefined, option: undefined };
  return { source, selection, busName: norm(picked.match.busName), boardingBusName: norm(picked.boardable.busName), departed: false,
    destination: journeyArrival(picked.boardable, source.visits, path.alightStopId, walkToSec, 0, now),
    option: { mode: 'shuttle', routeLabel: path.routeLabel, boardStopId: path.boardStopId, alightStopId: path.alightStopId,
      walkToSec, busEtaSec: picked.match.eta, computedAtMs: now, livePickupSelection: selection } };
}
