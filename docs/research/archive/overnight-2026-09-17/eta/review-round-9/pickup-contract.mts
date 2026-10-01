/** Research-only metadata projection. Never selects a new bus or changes times. */
export const norm = (s: string) => s.replace(/^#/, '');
export function forecastVisit(row: any, at: number) {
  return { source: 'forecast', selectedAtMs: at, routeLabel: row.routeLabel,
    busName: norm(row.busName), stopId: row.stopId, stopsAhead: row.stopsAhead,
    etaSec: row.eta, lowSec: row.low, highSec: row.high };
}
export function pickupContract(option: any, trace: any[]) {
  if (option.etaUnavailable || option.departed) return { status: 'unavailable', reason: option.etaUnavailable ? 'stale-or-missing' : 'departed' };
  const picked = trace.find(t => t.kind === 'pick')?.p;
  if (picked && !picked.departed) {
    const countdown = forecastVisit(picked.match, option.computedAtMs);
    const boarding = forecastVisit(picked.boardable, option.computedAtMs);
    const relation = countdown.busName !== boarding.busName ? 'different-bus'
      : countdown.stopId === boarding.stopId && countdown.stopsAhead === boarding.stopsAhead ? 'same-visit'
      : 'same-bus-later-visit';
    return { status: 'selected', countdown, boarding, relation,
      destinationAvailable: !!option.journeyArrival };
  }
  const joined = trace.find(t => t.kind === 'journey');
  if (joined && option.busEtaSec === 0) {
    // The existing raw override selected this vehicle. An absent forecast row
    // is NOT evidence that a later forecast occurrence is its current visit.
    const raw = { source: 'raw-at-stop', selectedAtMs: option.computedAtMs,
      routeLabel: option.routeLabel, busName: norm(option.busName), stopId: option.boardStopId };
    return { status: 'selected', countdown: raw, boarding: raw, relation: 'raw-current',
      forecastLink: joined.board ? forecastVisit(joined.board, option.computedAtMs) : null,
      destinationAvailable: !!option.journeyArrival };
  }
  return { status: 'unavailable', reason: 'no-live-selection' };
}
