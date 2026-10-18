import { describe, expect, it } from 'vitest';
import recorded from './__fixtures__/red-reporting-2026-10-14.json';
import { alightComparison, pickLiveArrival, planTrip, rideBoardArrivals } from './planner';
import { attachServerEta, ETA_MAX_AGE_MS, serverArrivals, type ServerEtaWire } from './etaSource';
import { forecastPickupSelection, rawPickupSelection } from './livePickupSelection';
import { registerRoutePaths } from './anchor';
import type { BusData } from './map-data';
import type { TripOption } from './planner';

function setup(extraHold = 600) {
  const feed = structuredClone(recorded.feed);
  const wire = feed.server_eta as unknown as ServerEtaWire;
  const bi = wire.buses.findIndex(b => b[0] === '126' && b[1] === 'Red');
  const hold = wire.rows.find(r => r[0] === bi && r[1] === 11)!;
  for (const [i, row] of wire.rows.entries()) if (row[0] === bi && row[5] > hold[5]) {
    for (const col of [2, 3, 4, 7, 8]) (row as unknown as number[])[col]! += extraHold;
    if (wire.distributions?.[i]) wire.distributions[i] = wire.distributions[i]!.map(s => s + extraHold);
  }
  const buses = feed.buses as unknown as BusData[], now = recorded.receivedAt;
  registerRoutePaths(Object.fromEntries(Object.entries(feed.route_paths)
    .map(([key, points]) => [key, points.map(([lat, lon]) => [lat!, lon!] as [number, number])])));
  expect(attachServerEta(buses, wire, now)).toBe(true);
  const stops = feed.routes['3'], destination = feed.stop_coords['100'];
  const visits = serverArrivals(buses, stops, now)!;
  const planned = planTrip(feed.stop_coords['120'], destination, buses, feed.routes, feed.stop_coords,
    feed.segments, feed.dwells, null, now).find(o => o.routeLabel === 'Red')!;
  const live = rideBoardArrivals(visits, planned.boardStopId, planned.alightStopId);
  const selection = forecastPickupSelection(pickLiveArrival(live, planned.busName, planned.walkToSec), now);
  const option: TripOption = { ...planned, livePickupSelection: selection };
  return { feed, now, stops, destination, visits, option,
    compare: (o = option, v = visits, at = now) => alightComparison(o, v, stops, feed.stop_coords, destination, at) };
}

describe('explain an earlier alighting stop with more walking', () => {
  it('compares complete destinations for the same boarding visit without changing the selected trip', () => {
    const f = setup(), before = structuredClone(f.option);
    expect(f.option.alightStopId).toBe(11);
    expect(f.compare()).toEqual({ stopId: 48, walkFromSec: expect.closeTo(75.8668, 3), arrivalGainSec: expect.closeTo(724.1284, 3) });
    expect(f.option).toEqual(before);
  });

  it('says nothing when the selected exit already minimizes walking', () => {
    const f = setup(0);
    expect(f.option.alightStopId).toBe(48);
    expect(f.compare()).toBeUndefined();
  });

  it('removes the comparison when current evidence no longer supports a material arrival gain', () => {
    const before = setup(), current = setup(0);
    // Winchester's own forecast and the pickup are unchanged by this declared
    // downstream delay. A watched trip can keep that exit as the delay clears.
    expect(current.compare(before.option)).toBeUndefined();
  });

  it('does not borrow another bus or route to explain the selected journey', () => {
    const f = setup();
    expect(f.compare({ ...f.option, livePickupSelection: { ...f.option.livePickupSelection!,
      boarding: { ...f.option.livePickupSelection!.boarding, busName: '317' } } })).toBeUndefined();
    expect(f.compare(f.option, f.visits.filter(a => a.routeLabel !== 'Red'))).toBeUndefined();
  });

  it('withholds the claim when either the boarding or selected destination visit is missing', () => {
    const f = setup();
    expect(f.compare(f.option, f.visits.filter(a => a.stopId !== f.option.boardStopId))).toBeUndefined();
    expect(f.compare(f.option, f.visits.filter(a => a.stopId !== f.option.alightStopId))).toBeUndefined();
    expect(f.compare(f.option, f.visits.filter(a => [f.option.boardStopId, f.option.alightStopId].includes(a.stopId)))).toBeUndefined();
  });

  it('does not use a closer curb on the next lap', () => {
    const f = setup(), board = f.option.livePickupSelection!.boarding;
    if (board.source !== 'forecast') throw new Error('Expected forecast boarding');
    const visits = f.visits.filter(a => a.busName === board.busName && [120, 11, 48].includes(a.stopId));
    const nextPickup = visits.filter(a => a.stopId === 120 && a.stopsAhead > board.stopsAhead)
      .sort((a, b) => a.stopsAhead - b.stopsAhead)[0]!;
    expect(nextPickup).toBeDefined();
    const changed = visits.map(a => a.stopId === 48 ? { ...a, stopsAhead: nextPickup.stopsAhead + 1, eta: nextPickup.eta + 300 } : a);
    expect(f.compare(f.option, changed)).toBeUndefined();
  });

  it('requires the exact current boarding occurrence', () => {
    const f = setup(), selection = f.option.livePickupSelection!, boarding = selection.boarding;
    if (boarding.source !== 'forecast') throw new Error('Expected forecast boarding');
    expect(f.compare({ ...f.option, livePickupSelection: { ...selection,
      boarding: { ...boarding, stopsAhead: boarding.stopsAhead + 100 } } })).toBeUndefined();
    expect(f.compare({ ...f.option, livePickupSelection: { ...selection,
      boarding: { ...boarding, stopId: 27 } } })).toBeUndefined();
  });

  it('refuses stale selections and mismatched cached journey times', () => {
    const f = setup();
    expect(f.compare(f.option, f.visits, f.now + ETA_MAX_AGE_MS)).toBeUndefined();
    expect(f.compare(f.option, f.visits, f.now - 1)).toBeUndefined();
    expect(f.compare({ ...f.option, journeyArrival: { ...f.option.journeyArrival!, pointMs: f.option.journeyArrival!.pointMs + 60_000 } })).toBeUndefined();
  });

  it.each(['departed', 'etaUnavailable'] as const)('withholds the comparison for %s trips', flag => {
    const f = setup(); expect(f.compare({ ...f.option, [flag]: true })).toBeUndefined();
  });

  it('does not turn raw boarding or absent journey evidence into a forecast comparison', () => {
    const f = setup();
    expect(f.compare({ ...f.option, livePickupSelection: rawPickupSelection(f.option.busName, 120, f.now) })).toBeUndefined();
    expect(f.compare({ ...f.option, livePickupSelection: undefined })).toBeUndefined();
    expect(f.compare({ ...f.option, journeyArrival: undefined })).toBeUndefined();
  });
});
