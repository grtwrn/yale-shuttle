/**
 * THE UNNAMED "I'M ON IT" TRACKS THE BUS THE RIDER IS BOARDING.
 *
 * Green, 2026-10-02 (wrongbusboard20261002), replayed off the watcher's own
 * recorded rows (`__fixtures__/green-wrong-bus-board.json`). A rider at
 * Orange / Avon read "#122 · 1 stop away" and tapped the single "I'm on it" as
 * #122 pulled in; the ride tracked #331, which had just left Orange / Bradley
 * (S) 3 km south, and ended "away from the shuttle" twenty seconds later.
 *
 * The planner did what it is meant to: once #122 passes the pickup it is
 * re-priced a lap out and the next vehicle takes the row. The tap is what
 * lands on that poll, because riders tap as their bus pulls in or away.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { isBusOnRoute, registerRoutePaths } from './anchor';
import { computeUpcomingArrivals, type DwellTimes, type SegmentTimes } from './arrivals';
import type { AnchorStore } from './eta';
import { haversineMeters, type LatLon } from './geo';
import type { BusData } from './map-data';
import { pickLiveArrival, rideBoardArrivals } from './planner';
import { BOARDING_BUS_M, boardingBusName, tripBusIdentity } from './tripBusIdentity';
import fixture from './__fixtures__/green-wrong-bus-board.json';

const FX = fixture as unknown as {
  routeId: string; routeLabel: string; busRouteId: number;
  boardStopId: number; alightStopId: number; origin: LatLon;
  plannedBus: string; pickupSampleAt: string;
  stopNames: Record<string, string>;
  routeStops: Record<string, number[]>;
  stopCoords: Record<string, LatLon>;
  routePath: Record<string, [number, number][]>;
  segments: SegmentTimes; dwells: DwellTimes;
  polls: { at: string; buses: BusData[] }[];
};
const stopCoords: Record<number, LatLon> = {};
for (const [k, v] of Object.entries(FX.stopCoords)) stopCoords[Number(k)] = v;
const allStops = [...new Set(FX.routeStops[FX.routeId]!)];

/** Every poll: the bus the card follows, and the line's buses on the route. */
function replay() {
  const store: AnchorStore = new Map();
  return FX.polls.map(({ at, buses }) => {
    const now = Date.parse(at);
    const visits = computeUpcomingArrivals([FX.boardStopId, FX.alightStopId], buses, FX.routeStops, stopCoords,
      FX.segments, now, FX.dwells, store).filter(a => a.routeLabel === FX.routeLabel);
    // The rider stands at the pickup: walk 0, as the card prices it.
    const picked = pickLiveArrival(rideBoardArrivals(visits, FX.boardStopId, FX.alightStopId), FX.plannedBus, 0)!;
    const card = tripBusIdentity({ busName: picked.match.busName });
    const line = buses.filter(b => b.route_id === FX.busRouteId && isBusOnRoute(b, allStops, stopCoords));
    return { at, card, line };
  });
}
const at122 = (line: BusData[]) => haversineMeters(FX.origin, line.find(b => b.bus_name === '#122')!);

describe('the unnamed "I\'m on it" (Green #122, 2026-10-02)', () => {
  beforeEach(() => registerRoutePaths(FX.routePath));

  it('is the recorded trip: a rider at Orange / Avon bound for Orange / Bradley (S)', () => {
    expect(FX.stopNames[String(FX.boardStopId)]).toBe('Orange / Avon');
    expect(FX.stopNames[String(FX.alightStopId)]).toBe('Orange / Bradley (S)');
    expect(haversineMeters(FX.origin, stopCoords[FX.boardStopId]!)).toBeLessThan(5);
  });

  it('the card hands its row from #122 to #331 in the poll after the pickup', () => {
    const polls = replay();
    const i = polls.findIndex(p => p.at === FX.pickupSampleAt);
    // The pickup screenshot: "#122 · 1 stop away", the single "I'm on it".
    expect(polls[i]!.card).toMatchObject({ pickup: '122', different: false });
    expect(at122(polls[i]!.line)).toBeLessThan(40);
    // Ten seconds on #122 is past the stop with the rider aboard, and the row,
    // and with it the button, belongs to #331 three kilometres away.
    expect(polls[i + 1]!.card).toMatchObject({ pickup: '331', different: false });
    expect(at122(polls[i + 1]!.line)).toBeLessThan(85);
    expect(haversineMeters(FX.origin, polls[i + 1]!.line.find(b => b.bus_name === '#331')!)).toBeGreaterThan(2500);
  });

  it('stores #122 whichever of those two polls the tap lands on', () => {
    const polls = replay();
    const i = polls.findIndex(p => p.at === FX.pickupSampleAt);
    for (const p of [polls[i]!, polls[i + 1]!]) {
      expect(boardingBusName(p.card.pickup, p.line, FX.origin), p.at).toBe('122');
    }
  });

  it('changes nothing while the card already names the bus or no bus is with the rider', () => {
    for (const p of replay().filter(p => p.at < FX.pickupSampleAt)) {
      expect(boardingBusName(p.card.pickup, p.line, FX.origin), p.at).toBe(p.card.pickup);
    }
  });
});

describe('boardingBusName', () => {
  const stop = { lat: 41.320428, lon: -72.912916 };
  const bus = (bus_name: string, metresNorth: number) => ({ bus_name, lat: stop.lat + metresNorth / 111_195, lon: stop.lon });

  it('keeps the card\'s bus when it is one of the buses with the rider', () => {
    expect(boardingBusName('#307', [bus('#309', 5), bus('#307', 60)], stop)).toBe('307');
  });
  it('keeps the card\'s bus when no bus is with the rider, so a ride can start before it comes', () => {
    expect(boardingBusName('307', [bus('#307', 900), bus('#309', BOARDING_BUS_M + 20)], stop)).toBe('307');
  });
  it('takes the nearest bus with the rider when the card names another', () => {
    expect(boardingBusName('331', [bus('#331', 3000), bus('#122', 80), bus('#124', 30)], stop)).toBe('124');
  });
  it('keeps the card\'s bus without a position to judge by', () => {
    expect(boardingBusName('#331', [bus('#122', 10)], null)).toBe('331');
    expect(boardingBusName('#331', [bus('#122', 10)], undefined)).toBe('331');
  });
});
