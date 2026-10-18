import { describe, expect, it } from 'vitest';
import type { UpcomingArrival } from './arrivals';
import type { TransferPath } from './transferPaths';
import { planLiveTransfers, timeLiveTransfers } from './transferTiming';
import { attachServerEta, type ServerEtaWire } from './etaSource';
import type { BusData } from './map-data';

const now = Date.UTC(2026, 9, 19, 16);
function path(): TransferPath {
  return { key: 'A-to-B',
    first: { routeLabel: 'A', color: '#123456', routeId: '1', boardStopId: 1, alightStopId: 3, stops: [1, 2, 3], plannedRideSec: 200 },
    second: { routeLabel: 'B', color: '#654321', routeId: '2', boardStopId: 4, alightStopId: 6, stops: [4, 5, 6], plannedRideSec: 200 },
    walkToSec: 100, transferWalkSec: 60, walkFromSec: 120, directWalkSec: 1800 };
}
function visit(routeLabel: string, busName: string, stopId: number, stopsAhead: number, eta: number, low = eta - 50, high = eta + 50): UpcomingArrival {
  return { routeLabel, busName, stopId, stopsAhead, eta, low: Math.max(0, low), high, color: '#123456', estimated: false, departNow: eta, lowFloor: 0 };
}
function visits(): UpcomingArrival[] {
  return [visit('A', '#10', 1, 1, 200), visit('A', '#10', 2, 2, 300), visit('A', '#10', 3, 3, 400),
    visit('B', '#20', 4, 2, 650), visit('B', '#20', 5, 3, 750), visit('B', '#20', 6, 4, 850)];
}
const timed = (p = path(), v = visits()) => timeLiveTransfers([p], v, now);

describe('timing a transfer from the served visits', () => {
  it('uses the same second bus destination, without charging the first delay twice', () => {
    const [trip] = timed();
    expect(trip).toBeDefined();
    expect(trip!.first.busName).toBe('10'); expect(trip!.second.busName).toBe('20');
    expect(trip!.connection).toEqual({ readyAtMs: now + 460_000, pickupAtMs: now + 650_000, bufferSec: 190, uncertain: false });
    expect(trip!.arrivalAtMs).toBe(now + 970_000); expect(trip!.totalSec).toBe(970);
    expect(trip!.firstPickupUncertain).toBe(false);
    expect(trip!).not.toHaveProperty('confidenceLowSec');
    expect(trip!).not.toHaveProperty('confidenceHighSec');
  });
  it('retains a point-time connection whose source windows overlap, marking that uncertainty', () => {
    const v = visits(); v[2]!.high = 700;
    const [trip] = timed(path(), v);
    expect(trip?.connection.uncertain).toBe(true);
    expect(trip?.totalSec).toBe(970);
  });
  it('keeps a possible tight change visible instead of inventing a minimum wait', () => {
    const p = path(); p.transferWalkSec = 250;
    const [trip] = timed(p);
    expect(trip?.connection.bufferSec).toBe(0);
    expect(trip?.connection.uncertain).toBe(true);
  });
  it('cannot promise that the second bus waits when its pickup precedes the transfer walk', () => {
    const p = path(); p.transferWalkSec = 251;
    expect(timed(p)).toEqual([]);
  });
  it('can use a later actually served bus instead of an impossible earlier connection', () => {
    const v = visits(); v.splice(3, 3, visit('B', '20', 4, 2, 450), visit('B', '20', 5, 3, 550), visit('B', '20', 6, 4, 650),
      visit('B', '21', 4, 1, 700), visit('B', '21', 5, 2, 800), visit('B', '21', 6, 3, 900));
    const trips = timed(path(), v);
    expect(trips).toHaveLength(1); expect(trips[0]!.second.busName).toBe('21');
    expect(trips[0]!.totalSec).toBe(1020);
  });
  it('does not extend the first-pickup grace into a guarantee that a bus already at transfer will wait', () => {
    const v = visits(); v[3]!.eta = 0; v[3]!.low = 0; v[3]!.high = 0;
    expect(timed(path(), v)).toEqual([]);
  });
  it('uses a later lap only when that exact boarding and destination visit were supplied', () => {
    const v = visits(); v[3]!.eta = 0; v[3]!.low = 0; v[3]!.high = 0;
    v.push(visit('B', '20', 4, 12, 1800), visit('B', '20', 5, 13, 1900), visit('B', '20', 6, 14, 2000));
    const trips = timed(path(), v);
    expect(trips).toHaveLength(1); expect(trips[0]!.second.pickup.stopsAhead).toBe(12);
    expect(trips[0]!.arrivalAtMs).toBe(now + 2_120_000);
  });
  it.each([0, 2, 3, 5])('does not invent a missing pickup or destination row at index%s', index => {
    const v = visits(); v.splice(index, 1);
    expect(timed(path(), v)).toEqual([]);
  });
  it('uses the existing first-pickup grace with a warning and rejects an unreachable first bus', () => {
    const p = path(); p.walkToSec = 260;
    expect(timed(p)[0]?.firstPickupUncertain).toBe(true);
    p.walkToSec = 261; expect(timed(p)).toEqual([]);
  });
  it('matches the correct later call of a folded pickup rather than borrowing its first call', () => {
    const p = path(); p.first.stops = [2, 3]; p.first.boardStopId = 2;
    const v = [visit('A', '10', 2, 1, 100), visit('A', '10', 9, 2, 200),
      visit('A', '10', 2, 3, 300), visit('A', '10', 3, 4, 400), ...visits().slice(3)];
    const trips = timed(p, v);
    expect(trips).toHaveLength(1); expect(trips[0]!.first.pickup.stopsAhead).toBe(3);
    expect(trips[0]!.first.alightHops).toBe(4);
  });
  it('rejects a path contradicted by an actual intermediate visit', () => {
    const v = visits(); v[1]!.stopId = 99;
    expect(timed(path(), v)).toEqual([]);
  });
  it('can use endpoint forecasts with known hop counts when only an intermediate display row is absent', () => {
    const v = visits(); v.splice(1, 1);
    expect(timed(path(), v)).toHaveLength(1);
  });
  it('does not conflate equal bus names reporting on different routes', () => {
    const v = visits().map(a => ({ ...a, busName: '20' }));
    expect(timed(path(), v)[0]?.first.destination.pointMs).toBe(now + 400_000);
    expect(timed(path(), v)[0]?.second.destination.pointMs).toBe(now + 850_000);
  });
  it('leaves source forecasts and paths unchanged', () => {
    const p = path(), v = visits(), before = structuredClone({ p, v });
    timed(p, v); expect({ p, v }).toEqual(before);
  });
  it('isolates a conflicting source visit to its own bus', () => {
    const v = visits(); v.push({ ...v[0]!, eta: 210 });
    v.push(...visits().slice(0, 3).map(a => ({ ...a, busName: '11' })));
    const trips = timed(path(), v);
    expect(trips).toHaveLength(1); expect(trips[0]!.first.busName).toBe('11');
  });
  it('does not treat an exact duplicate source row as a second boarding opportunity', () => {
    const v = visits(); v.push({ ...v[0]! });
    expect(timed(path(), v)).toHaveLength(1);
  });
});

describe('live transfer source availability', () => {
  function live() {
    const p = path(); p.first.routeLabel = 'Red'; p.second.routeLabel = 'Orange Day';
    const buses: BusData[] = [{ bus_id: 1, bus_name: '#10', route_id: 3, lat: 41.3, lon: -72.9, heading: 0, last_stop_id: 1 },
      { bus_id: 2, bus_name: '#20', route_id: 2, lat: 41.3, lon: -72.9, heading: 0, last_stop_id: 4 }];
    const v = visits();
    const wire: ServerEtaWire = { v: 2, at: now, servedAt: now, buses: [['10', 'Red', 0, null], ['20', 'Orange Day', 0, null]],
      rows: v.map(a => [a.routeLabel === 'A' ? 0 : 1, a.stopId, a.eta, a.low, a.high, a.stopsAhead, 0, a.departNow, a.lowFloor]) };
    return { p, buses, wire };
  }
  it('uses only a registered fresh server snapshot and expires at its existing45second boundary', () => {
    const { p, buses, wire } = live();
    expect(planLiveTransfers([p], buses, now, true)).toEqual([]);
    expect(attachServerEta(buses, wire, now)).toBe(true);
    expect(planLiveTransfers([p], buses, now, true)).toHaveLength(1);
    expect(planLiveTransfers([p], buses, now + 44_999, true)).toHaveLength(1);
    expect(planLiveTransfers([p], buses, now + 45_000, true)).toEqual([]);
  });
  it('withholds timed transfers during a failed poll even if a cached snapshot is still fresh', () => {
    const { p, buses, wire } = live(); attachServerEta(buses, wire, now);
    expect(planLiveTransfers([p], buses, now, false)).toEqual([]);
    expect(planLiveTransfers([p], buses, now, true)).toHaveLength(1);
  });
  it('retains no timed connection when the new server snapshot has no usable rows', () => {
    const { p, buses, wire } = live(); attachServerEta(buses, wire, now);
    expect(attachServerEta(buses, { ...wire, rows: [] }, now)).toBe(true);
    expect(planLiveTransfers([p], buses, now, true)).toEqual([]);
  });
});
