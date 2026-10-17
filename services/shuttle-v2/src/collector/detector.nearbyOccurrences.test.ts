import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { describe, expect, it, vi } from 'vitest';
import { TransitNetwork } from '../network/TransitNetwork';
import { step, type BusObservation } from './detector';
import { stepManyWithVisits } from './departure';
import { distanceMeters } from '../network/geo';
import capture from './__fixtures__/blue-weekend-nearby-occurrences-2026-10-03.json';
import { Collector } from './collector';
import { UpstreamClient, type RawBus } from './upstream';
import { openDb } from '../db/client';

const stops = Object.entries(capture.stopCoords).map(([id, coord]) => ({ id: Number(id), name: capture.stopNames[id as keyof typeof capture.stopNames], ...coord }));
const route = { id: capture.routeId, name: 'Blue Weekend', shortName: 'Blue Weekend', color: '#42A5F5', stops: capture.stops,
  path: capture.path as [number, number][] };
const network = () => TransitNetwork.build(stops, [route]);
const observations: BusObservation[] = capture.samples.map(([collectedAt, lat, lon, heading, lastStopId]) => ({
  busId: capture.busId, busName: capture.busName, routeId: capture.routeId,
  collectedAt: collectedAt!, lat: lat!, lon: lon!, heading: heading!, lastStopId: lastStopId!,
}));

async function replayCollector(restartAt: number | null) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'shuttle-nearby-occurrences-'));
  const bundle = openDb(path.join(dir, 'test.db'));
  migrate(bundle.db, { migrationsFolder: './drizzle' });
  let latest = observations[0]!, collector: Collector | undefined;
  class Stub extends UpstreamClient {
    constructor() { super({ baseUrl: 'http://invalid.test' }); }
    override async stops() { return stops; }
    override async routes() { return [route]; }
    override async buses(): Promise<RawBus[]> {
      return [{ id: latest.busId, name: latest.busName, route: latest.routeId, lat: latest.lat,
        lon: latest.lon, heading: latest.heading, lastStop: latest.lastStopId } as RawBus];
    }
  }
  type Inner = { runPoll(): Promise<void>; refreshStaticIfNeeded(force: boolean): Promise<void> };
  const positions: Array<{ at: number; buses: ReturnType<Collector['getLiveBuses']> }> = [];
  const errors: unknown[] = [];
  const options = { upstream: new Stub(), upstreamEta: false, etaSampler: false,
    logger: { info() {}, warn() {}, error(message: string, meta?: unknown) { errors.push({ message, meta }); } } };
  vi.useFakeTimers();
  try {
    vi.setSystemTime(latest.collectedAt);
    collector = await Collector.create(bundle, options);
    await (collector as unknown as Inner).refreshStaticIfNeeded(true);
    for (const obs of observations) {
      latest = obs; vi.setSystemTime(obs.collectedAt);
      if (obs.collectedAt === restartAt) {
        collector.stop();
        collector = await Collector.create(bundle, options);
      }
      await (collector as unknown as Inner).runPoll();
      positions.push({ at: obs.collectedAt, buses: collector.getLiveBuses() });
    }
    return { errors, positions,
      arrivals: bundle.sqlite.prepare('SELECT * FROM arrivals ORDER BY id').all(),
      segments: bundle.sqlite.prepare('SELECT * FROM segments ORDER BY id').all(),
      visits: bundle.sqlite.prepare('SELECT * FROM stop_visits ORDER BY id').all() as Array<{ stop_id: number; arrived_at: number; stand_sec: number }>,
      legs: bundle.sqlite.prepare('SELECT * FROM legs ORDER BY id').all(),
    };
  } finally {
    collector?.stop(); vi.useRealTimers(); bundle.sqlite.close(); rmSync(dir, { recursive: true, force: true });
  }
}

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
  it.each([
    '2026-10-03T12:55:23.365Z', // outbound approach: outside the current stop's pin
    '2026-10-03T12:55:48.321Z', // outbound stand: pin reached, approaching rest
    '2026-10-03T13:04:23.394Z', // genuine later return: already standing
  ])('persists the correct calls through the real collector and a restart at %s', async (restartTime) => {
    const restartAt = Date.parse(restartTime);
    expect(observations.some(o => o.collectedAt === restartAt)).toBe(true);
    const reference = await replayCollector(null), restarted = await replayCollector(restartAt);
    // Exact database rows and every live position/clock must survive, not just
    // the final visit count. Historical reducer events must not be inserted again.
    expect(restarted).toEqual(reference);
    expect(restarted.errors).toEqual([]);
    expect(restarted.positions.filter(p => p.at < Date.parse('2026-10-03T13:00:00Z')
      && p.buses.some(b => b.atStopId === 53))).toEqual([]);
    expect(restarted.visits.filter(v => [116, 53].includes(v.stop_id))).toEqual([
      expect.objectContaining({ stop_id: 116 }),
      expect.objectContaining({ stop_id: 53, arrived_at: Date.parse('2026-10-03T13:04:03.483Z'), stand_sec: 29.878 }),
    ]);
  });
});
