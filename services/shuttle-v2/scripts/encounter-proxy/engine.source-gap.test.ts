import { expect, it } from 'vitest';
import { compileCatalog } from './catalog.js';
import { EncounterEngine } from './engine.js';
import { projectPublicPacket, vehicleKey } from './raw-ingress.js';
import { squareSpec } from './test-fixtures.js';

const vehicle = { routeId: 100, busId: 7, busName: '#raw' };
function packet(observedAt: number, availableAt: number, cursor: number, historical = false) {
  return projectPublicPacket({ v: 1, epoch: 'source-gap-fixture', build: 'raw-only', cursor, latest: cursor,
    hasMore: false, frames: historical ? [null] : [], feed: { buses: [{ route_id: 100, bus_id: 7, bus_name: '#raw',
      observed_at: observedAt, lat: 41, lon: -73, stationary: false, at_stop_id: null }] } },
  { originalReceivedAt: availableAt, availableAt, origin: historical ? 'historical-frame' : 'public-current' });
}

it.each([false, true])('keeps real source continuity through spent duplicate receipts (historical=%s)', historical => {
  const engine = new EncounterEngine({ namespaceId: `fixture-copy-continuity-${historical}`,
    catalogs: [compileCatalog(squareSpec())], fixtureMode: true, prospectiveCutoff: null });
  const first = packet(0, 0, 1);
  engine.ingest(first);
  const enrolled = engine.enroll({ id: 'future-pickup', vehicle, stopId: 100, horizon: '5-10',
    forecastAt: 0, availableAt: 0, receiptHash: first.receiptHash }, 0).enrollment;
  expect(enrolled.status).toBe('open');
  const key = vehicleKey(vehicle), initial = engine.snapshot().vehicles[key]!;
  const generation = initial.progress!.generation!.id;
  // This observation already spent its one live provenance allowance. A
  // fresh public OR historical receipt keeps transport alive, not another GPS
  // observation, curb witness, seed, encounter or ordinal.
  const copyUpdate = engine.ingest(packet(0, 29000, 1, historical));
  const afterCopy = engine.snapshot();
  expect(copyUpdate.encounterEvents).toEqual([]);
  expect(copyUpdate.outcomes).toEqual([]);
  expect(copyUpdate.dispositions).toContainEqual(expect.objectContaining({ kind: 'copy' }));
  expect(copyUpdate.dispositions.some(d => d.kind === 'new' || d.kind === 'live-upgrade')).toBe(false);
  expect(afterCopy.vehicles[key]!.progress).toMatchObject({ lastObservedAt: 0, lastAvailableAt: 29000,
    generation: { id: generation } });
  expect(afterCopy.vehicles[key]!.progress!.intervals).toEqual(initial.progress!.intervals);
  expect(afterCopy.vehicles[key]!.progress!.passedThrough).toEqual(initial.progress!.passedThrough);
  expect(afterCopy.vehicles[key]!.encounters.records).toEqual({});
  expect(Object.keys(afterCopy.ingress.vehicles[key]!.fixes)).toHaveLength(1);
  // Distinct observed gap20s, actual receipt gap2s, cursor repeat then+1.
  // A canonical-fix-only clock would incorrectly report a31s receipt gap.
  const nextUpdate = engine.ingest(packet(20000, 31000, 2));
  const final = engine.snapshot();
  expect(nextUpdate.encounterEvents).toEqual([]);
  expect(nextUpdate.outcomes).toEqual([]);
  expect(final.enrollments.records['future-pickup']!.status).toBe('open');
  expect(final.vehicles[key]!.progress).toMatchObject({ lastObservedAt: 20000, lastAvailableAt: 31000,
    generation: { id: generation } });
  expect(final.vehicles[key]!.encounters.records).toEqual({});
  expect(Object.keys(final.ingress.vehicles[key]!.fixes)).toHaveLength(2);
});
