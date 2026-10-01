import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import type { LatLon } from './geo';
import type { SegmentTimes, DwellTimes } from './arrivals';
import type { ServerEtaWire } from './etaSource';
const snapshot = JSON.parse(readFileSync(new URL('./__fixtures__/blue-pickup-2026-09-28.json', import.meta.url), 'utf8')) as {
  from: LatLon; to: LatLon; buses: BusData[]; routes: Record<string, number[]>;
  stop_coords: Record<number, LatLon>; segments: SegmentTimes; dwells: DwellTimes;
  server_eta: Omit<ServerEtaWire, 'rows'> & { rows: number[][] };
};
import { attachServerEta } from './etaSource';
import { computeUpcomingArrivals } from './liveArrivals';
import { journeyArrival } from './journeyArrival';
import type { BusData } from './map-data';
import { bestRoutePickup, pickupFallback, pickLiveArrival, planTrip, rideBoardArrivals, topVisibleOptions, worthwhileOverviewOption, type TripOption } from './planner';

const now = snapshot.server_eta.servedAt;
function feed(earlier = false) {
  const buses = structuredClone(snapshot.buses) as BusData[];
  const wire = structuredClone(snapshot.server_eta);
  // Construct an earlier catchable visit on the SAME route geometry. The
  // second snapshot is the captured feed; this is a transition regression,
  // not a claim to reconstruct the report's unavailable initial observation.
  if (earlier) {
    const index = wire.buses.findIndex(b => b[0] === '38');
    for (const row of wire.rows) if (row[0] === index) {
      for (const column of [2, 3, 4, 7, 8]) row[column]! += 600;
    }
  }
  expect(attachServerEta(buses, wire, now)).toBe(true);
  return buses;
}
const plan = (buses: BusData[]) => planTrip(snapshot.from, snapshot.to, buses, snapshot.routes, snapshot.stop_coords, snapshot.segments, snapshot.dwells, null, now);
const blue = (options: TripOption[]) => options.find(o => o.routeLabel === 'Blue Day')!;
function refreshFrozen(o: TripOption, buses: BusData[]) {
  const visits = computeUpcomingArrivals([o.boardStopId, o.alightStopId], buses, snapshot.routes, snapshot.stop_coords, snapshot.segments, now, snapshot.dwells).filter(a => a.routeLabel === o.routeLabel);
  const picked = pickLiveArrival(rideBoardArrivals(visits, o.boardStopId, o.alightStopId), o.busName, o.walkToSec)!;
  const destination = journeyArrival(picked.boardable, visits, o.alightStopId, o.walkToSec, o.walkFromSec, now);
  return { ...o, busName: picked.match.busName, departed: picked.departed, journeyArrival: destination, totalSec: destination ? (destination.pointMs - now) / 1000 : o.totalSec };
}

describe('live pickup fallback: 517 Prospect to Rosenkranz (#134)', () => {
  it('replaces a farther frozen pickup with catchable Prospect/Canner and restores overview eligibility', () => {
    const original = blue(plan(feed(true)));
    expect(original.boardStopId).toBe(129); // Whitney/Canner, 7-minute walk
    expect(worthwhileOverviewOption(original)).toBe(false);
    const buses = feed();
    const current = refreshFrozen(original, buses);
    const candidate = blue(plan(buses));
    expect(candidate.boardStopId).toBe(100); // Prospect/Canner, 2-minute walk
    expect(candidate.departed).toBe(false);
    expect(pickupFallback(current, candidate)).toBe(candidate);
    expect(topVisibleOptions([candidate])).toContain(candidate);
  });

  it('preserves the pickup while the rider follows its card or reminder', () => {
    const current = refreshFrozen(blue(plan(feed(true))), feed());
    const candidate = blue(plan(feed()));
    expect(pickupFallback(current, candidate, true)).toBeUndefined();
  });

  it('cannot prefer a cheap uncatchable pickup over a real boarding opportunity', () => {
    const candidate = blue(plan(feed()));
    const missed = { ...candidate, boardStopId: 129, departed: true, totalSec: 1 };
    expect(bestRoutePickup([missed, candidate])).toBe(candidate);
  });

  it('rejects an unreachable alternative and small ETA fluctuations', () => {
    const current = refreshFrozen(blue(plan(feed(true))), feed());
    const candidate = blue(plan(feed()));
    expect(pickupFallback(current, { ...candidate, departed: true })).toBeUndefined();
    expect(pickupFallback(current, { ...candidate, totalSec: current.totalSec + 240 })).toBeUndefined();
    expect(pickupFallback({ ...current, etaUnavailable: true }, candidate)).toBeUndefined();
  });
});
