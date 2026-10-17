import { describe, expect, it } from 'vitest';
import { TransitNetwork } from '../network/TransitNetwork';
import { step, type BusObservation } from './detector';
import { stepManyWithVisits } from './departure';
import { distanceMeters } from '../network/geo';
import capture from './__fixtures__/blue-weekend-nearby-occurrences-2026-10-03.json';

const stops = Object.entries(capture.stopCoords).map(([id, coord]) => ({ id: Number(id), name: capture.stopNames[id as keyof typeof capture.stopNames], ...coord }));
const route = { id: capture.routeId, name: 'Blue Weekend', shortName: 'Blue Weekend', color: '#42A5F5', stops: capture.stops,
  path: capture.path as [number, number][] };
const network = () => TransitNetwork.build(stops, [route]);
const observations: BusObservation[] = capture.samples.map(([collectedAt, lat, lon, heading, lastStopId]) => ({
  busId: capture.busId, busName: capture.busName, routeId: capture.routeId,
  collectedAt: collectedAt!, lat: lat!, lon: lon!, heading: heading!, lastStopId: lastStopId!,
}));

describe('nearby stops separated by a real route detour', () => {
  it('records one Elm/York call after Stop & Shop, not another on the outbound near pass', () => {
    const net = network(), states = new Map(), visitStates = new Map();
    const visits = observations.flatMap(obs => stepManyWithVisits(net, states, visitStates, [obs]).visits)
      .filter(v => v.kind === 'visit');
    const shop = visits.filter(v => v.stopId === 116), elm = visits.filter(v => v.stopId === 53);
    expect(shop).toHaveLength(1);
    expect(elm).toHaveLength(1);
    expect(elm[0]!.anchoredAt).toBeGreaterThan(shop[0]!.anchoredAt);
    // The collector measures the first resting plateau within 75 m. The
    // separate 45 m curb oracle enters ten seconds later; they are different
    // clocks on the SAME return visit, not interchangeable ground truth.
    const returnRest = observations.find((obs, i) => obs.lastStopId === 116
      && distanceMeters(obs, net.stops.get(53)!) <= 75
      && observations[i + 1]?.lat === obs.lat && observations[i + 1]?.lon === obs.lon);
    expect(returnRest?.collectedAt).toBe(Date.parse('2026-10-03T13:04:03.483Z'));
    expect(elm[0]!.arrivedAt).toBe(returnRest!.collectedAt);
  });
  it('holds Broadway/York across a five-second move toward its nearby later-loop curb', () => {
    const net = network();
    // The full recorded replay above supplies the exact state. Use the
    // recorded 07:49 near-pass geometry for a focused continuity control.
    const first = { ...observations[0]!, lat: 41.309771, lon: -72.930701, collectedAt: 1_000_000 };
    const seed = step(net, null, { ...first, lat: 41.311002, lon: -72.930344 }).state!;
    const previous = { ...seed, lat: first.lat, lon: first.lon };
    expect(previous.nearestStopId).toBe(21);
    const next = step(net, previous, { ...first, lat: 41.310042, lon: -72.930508, collectedAt: first.collectedAt + 5000 });
    expect(next.state!.nearestStopId).toBe(21);
    expect(next.events).toEqual([]);
  });
  it('allows the same skip when an observation gap could contain the intervening journey', () => {
    const net = network(), first = { ...observations[0]!, lat: 41.311002, lon: -72.930344, collectedAt: 1_000_000 };
    const previous = step(net, null, first).state!;
    const next = step(net, previous, { ...first, lat: 41.310042, lon: -72.930508, collectedAt: first.collectedAt + 120_000 });
    expect(next.state!.nearestStopId).toBe(53);
  });
  it('still advances between nearby consecutive calls with no intervening detour', () => {
    const net = TransitNetwork.build(stops, [{ ...route, stops: [21, 53, 116], path: undefined }]);
    const first = { ...observations[0]!, lat: 41.311002, lon: -72.930344, collectedAt: 1_000_000 };
    const previous = step(net, null, first).state!;
    const next = step(net, previous, { ...first, lat: 41.31086, lon: -72.93054, collectedAt: first.collectedAt + 5000 });
    expect(next.state!.nearestStopId).toBe(53);
  });
  it('does not infer an impossible journey when the intervening stop has no coordinate', () => {
    const net = TransitNetwork.build(stops.filter(s => s.id !== 116), [{ ...route, path: undefined }]);
    const first = { ...observations[0]!, lat: 41.311002, lon: -72.930344, collectedAt: 1_000_000 };
    const previous = step(net, null, first).state!;
    const next = step(net, previous, { ...first, lat: 41.31086, lon: -72.93054, collectedAt: first.collectedAt + 5000 });
    expect(next.state!.nearestStopId).toBe(53);
  });
  it('allows a discontinuous fix to re-anchor instead of extending an obsolete nearby anchor', () => {
    const net = network();
    const first = { ...observations[0]!, lat: 41.311002, lon: -72.930344, collectedAt: 1_000_000 };
    const previous = { ...step(net, null, first).state!, lat: 41.306, lon: -72.935 };
    const next = step(net, previous, { ...first, lat: 41.31086, lon: -72.93054, collectedAt: first.collectedAt + 5000 });
    expect(next.state!.nearestStopId).toBe(53);
  });
});
