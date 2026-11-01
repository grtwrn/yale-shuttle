import { describe, expect, it } from 'vitest';
import { EncounterEngine } from './engine.js';
import { compileCatalog } from './catalog.js';
import { canonicalJSON } from './canonical.js';
import { pinkCandidateSpec, PINK_CANDIDATE_QUALIFICATION } from './pink-candidate.fixture.js';
import { DEFAULT_PROTOCOL } from './protocol.js';
import { projectPublicPacket } from './raw-ingress.js';
import type { RouteCatalogSpec } from './types.js';
import type { EncounterEvent } from './encounters.js';
import {
  loadPinkRawRecords, originalCurrentRecord, replayPinkTrace,
  SOUTH_109_FIRST_OBSERVED_AT, SOUTH_109_SECOND_OBSERVED_AT,
  NORTH_110_FIRST_OBSERVED_AT, NORTH_110_CONFIRMATION_OBSERVED_AT,
  NORTH_109_FIRST_OBSERVED_AT, LATER_SOUTH_109_FIRST_OBSERVED_AT,
  ORIGINAL_FORECAST_AT,
} from './recorded-fixture.test-helper.js';

/** Fixed analytic toy loop, not a map of Yale or independent SPUR evidence.
 * The physical109 point appears on a service branch and a nonservice branch.
 * Coordinates/times are source literals; geometry runs only in authorized tests. */
function syntheticLoop(): RouteCatalogSpec {
  return {
    v: 1, routeId: 900, sourceTopologyHash: '1'.repeat(64),
    pathProvenance: 'Explicit synthetic two-pass loop; no real service qualification',
    path: [
      { lat: 0, lon: 0 }, { lat: 0, lon: 0.003 }, { lat: 0.003, lon: 0.003 },
      { lat: 0.003, lon: -0.003 }, { lat: 0, lon: -0.003 }, { lat: 0, lon: 0 },
      { lat: -0.003, lon: 0 }, { lat: -0.003, lon: 0.003 }, { lat: 0, lon: 0.003 },
      { lat: 0, lon: 0 },
    ],
    publishedStops: [109, 110],
    stopCoords: { 109: { lat: 0, lon: 0 }, 110: { lat: -0.003, lon: 0.003 } },
    calls: [
      { id: 'synthetic-south-109', stopId: 109, publishedIndex: 0,
        service: 'published-qualified', masks: [{ segment: 4 }, { segment: 5 }], evidenceHashes: ['2'.repeat(64)] },
      { id: 'synthetic-nonservice-north-109', stopId: 109, publishedIndex: null,
        service: 'traversal-only', masks: [{ segment: 8 }, { segment: 0 }], evidenceHashes: ['3'.repeat(64)] },
      { id: 'synthetic-published-110', stopId: 110, publishedIndex: 1,
        service: 'published-qualified', masks: [{ segment: 6 }, { segment: 7 }], evidenceHashes: ['4'.repeat(64)] },
    ],
  };
}

const syntheticVehicle = { routeId: 900, busId: 9001, busName: '#synthetic' };
const syntheticOrigin = Date.parse('2030-01-01T00:00:00.000Z');
function syntheticPacket(cursor: number, sec: number, lat: number, lon: number, atStop: number | null = null) {
  const observedAt = syntheticOrigin + sec * 1000, availableAt = observedAt + 1000;
  return projectPublicPacket({
    v: 1, epoch: 'synthetic-fixed-loop', build: 'raw-only-fixture', cursor, latest: cursor,
    hasMore: false, frames: [], feed: { buses: [{
      route_id: syntheticVehicle.routeId, bus_id: syntheticVehicle.busId, bus_name: syntheticVehicle.busName,
      observed_at: observedAt, lat, lon, stationary: atStop !== null, at_stop_id: atStop,
    }] },
  }, { originalReceivedAt: availableAt, availableAt });
}

describe('authenticated Pink source, conditional fixture catalog only', () => {
  it('retains the complete prehistory, short South episode, North positive clocks and delayed provider history', () => {
    const records = loadPinkRawRecords();
    expect(PINK_CANDIDATE_QUALIFICATION.qualificationPending).toBe(true);
    expect(PINK_CANDIDATE_QUALIFICATION.fixtureModeOnly).toBe(true);
    const southFirst = originalCurrentRecord(records, SOUTH_109_FIRST_OBSERVED_AT);
    const southSecond = originalCurrentRecord(records, SOUTH_109_SECOND_OBSERVED_AT);
    expect(southFirst.buses[0]?.at_stop_id).toBe(109);
    expect(southSecond.buses[0]?.at_stop_id).toBe(109);
    expect(SOUTH_109_SECOND_OBSERVED_AT - SOUTH_109_FIRST_OBSERVED_AT).toBe(5035);
    const northFirst = originalCurrentRecord(records, NORTH_110_FIRST_OBSERVED_AT);
    const northConfirm = originalCurrentRecord(records, NORTH_110_CONFIRMATION_OBSERVED_AT);
    expect(northFirst.receivedAt).toBe(1793370710877);
    expect(northConfirm.receivedAt).toBe(1793370722131);
    expect(northFirst.buses[0]?.last_stop_id).toBe(125);
    expect(northConfirm.buses[0]?.last_stop_id).toBe(125);
    expect(northFirst.buses[0]?.at_stop_id).toBe(110);
    expect(northConfirm.buses[0]?.at_stop_id).toBe(110);
    expect(NORTH_110_CONFIRMATION_OBSERVED_AT - NORTH_110_FIRST_OBSERVED_AT).toBe(10054);
    expect(records[0]!.receivedAt).toBeLessThan(ORIGINAL_FORECAST_AT);
    expect(records.at(-1)!.receivedAt).toBeGreaterThan(LATER_SOUTH_109_FIRST_OBSERVED_AT);
  });

  it('closes the short South109 encounter without borrowing North109 or the later South, and retains North110', () => {
    const catalog = compileCatalog(pinkCandidateSpec(true));
    const engine = new EncounterEngine({ namespaceId: 'fixture-recorded-pink-r3',
      catalogs: [catalog], fixtureMode: true, prospectiveCutoff: null });
    const result = replayPinkTrace(engine, loadPinkRawRecords());
    expect(result.packetsConsumed).toBe(4314);
    const initialSouth = result.enrollmentSnapshot.enrollments.records['recorded-109'];
    const initialNorth = result.enrollmentSnapshot.enrollments.records['recorded-110'];
    expect(initialSouth?.status).toBe('open');
    expect(initialSouth?.encounter?.occurrenceId).toBe('published:5:109');
    expect(initialNorth?.status).toBe('open');
    expect(initialNorth?.encounter?.occurrenceId).toBe('published:9:110');
    const events = result.encounterEvents.map(item => item.event)
      .filter((event): event is EncounterEvent => event.kind !== 'continuity-censored');
    const shortCandidate = events.find(event => event.kind === 'candidate' && event.stopId === 109
      && event.arrival?.evidence.observedAt === SOUTH_109_FIRST_OBSERVED_AT);
    expect(shortCandidate).toBeDefined();
    const closedShort = events.find(event => event.kind === 'passed-unconfirmed'
      && event.encounter.occurrenceId === shortCandidate!.encounter.occurrenceId
      && event.encounter.ordinal === shortCandidate!.encounter.ordinal
      && event.encounter.generationId === shortCandidate!.encounter.generationId);
    expect(closedShort).toBeDefined();
    expect(closedShort!.availableAt).toBeLessThan(NORTH_109_FIRST_OBSERVED_AT);
    const finalSouth = result.snapshot.enrollments.records['recorded-109'];
    expect(finalSouth).toMatchObject({ status: 'missing', det: null, arrivedAt: null,
      reason: 'passed-without-confirmed-proxy', outcomeEventId: closedShort!.eventId,
      availableAt: closedShort!.availableAt });
    expect(events.filter(event => event.kind === 'confirmed' && event.stopId === 109
      && event.arrival!.evidence.observedAt >= NORTH_109_FIRST_OBSERVED_AT
      && event.arrival!.evidence.observedAt < LATER_SOUTH_109_FIRST_OBSERVED_AT)).toEqual([]);
    const laterSouth = events.find(event => event.kind === 'candidate' && event.stopId === 109
      && event.arrival?.evidence.observedAt === LATER_SOUTH_109_FIRST_OBSERVED_AT);
    expect(laterSouth).toBeDefined();
    expect(laterSouth!.encounter.occurrenceId).toBe('published:5:109');
    expect(laterSouth!.encounter.generationId).toBe(shortCandidate!.encounter.generationId);
    expect(laterSouth!.encounter.ordinal).toBeGreaterThan(shortCandidate!.encounter.ordinal);
    expect(laterSouth!.eventId).not.toBe(shortCandidate!.eventId);
    const north = events.find(event => event.kind === 'confirmed' && event.stopId === 110
      && event.arrival?.evidence.observedAt === NORTH_110_FIRST_OBSERVED_AT);
    expect(north).toMatchObject({ encounter: { occurrenceId: 'published:9:110' },
      availableAt: 1793370722131,
      confirmation: { evidence: { observedAt: NORTH_110_CONFIRMATION_OBSERVED_AT } } });
    expect(events.filter(event => event.kind === 'confirmed' && event.stopId === 110
      && event.arrival!.evidence.observedAt >= ORIGINAL_FORECAST_AT
      && event.arrival!.evidence.observedAt < NORTH_110_FIRST_OBSERVED_AT)).toEqual([]);
    expect(result.snapshot.enrollments.records['recorded-110']).toMatchObject({
      status: 'matched', arrivedAt: NORTH_110_FIRST_OBSERVED_AT,
      det: (NORTH_110_FIRST_OBSERVED_AT - ORIGINAL_FORECAST_AT) / 1000,
      availableAt: 1793370722131, reason: null,
    });
    expect(DEFAULT_PROTOCOL.publicationCapability).toBe(false);
  });
});

describe('explicit synthetic controls separate ordinal closure from timeout', () => {
  it('never rescues a missed service encounter, while a NEW binding confirms the later service lap within45min', () => {
    const engine = new EncounterEngine({ namespaceId: 'fixture-synthetic-later-lap-r3',
      catalogs: [compileCatalog(syntheticLoop())], fixtureMode: true, prospectiveCutoff: null });
    let cursor = 0;
    const ingest = (sec: number, lat: number, lon: number, stop: number | null = null) =>
      engine.ingest(syntheticPacket(++cursor, sec, lat, lon, stop));
    ingest(0, 0.003, -0.003);
    const beforeOld = syntheticPacket(++cursor, 10, 0, -0.003);
    engine.ingest(beforeOld);
    engine.enroll({ id: 'old-south', vehicle: syntheticVehicle, stopId: 109, horizon: '5-10',
      forecastAt: beforeOld.availableAt, availableAt: beforeOld.availableAt, receiptHash: beforeOld.receiptHash });
    expect(engine.snapshot().enrollments.records['old-south']?.status).toBe('open');
    ingest(20, 0, 0, 109);
    ingest(25, 0, 0, 109); // five-second short stop: never fabricate a nine-second witness.
    ingest(35, -0.003, 0);
    ingest(45, -0.003, 0.003);
    ingest(55, 0, 0.003);
    ingest(65, 0, 0, 109); // opposite nonservice branch cannot rescue the original.
    ingest(75, 0, 0, 109);
    const oldTerminal = engine.snapshot().enrollments.records['old-south'];
    expect(oldTerminal).toMatchObject({ status: 'missing', det: null, reason: 'passed-without-confirmed-proxy' });
    const originalTerminalBytes = canonicalJSON(oldTerminal);
    ingest(85, 0, 0.003);
    ingest(95, 0.003, 0.003);
    ingest(115, 0.003, -0.003);
    const beforeNew = syntheticPacket(++cursor, 125, 0, -0.003);
    engine.ingest(beforeNew);
    engine.enroll({ id: 'new-south', vehicle: syntheticVehicle, stopId: 109, horizon: '5-10',
      forecastAt: beforeNew.availableAt, availableAt: beforeNew.availableAt, receiptHash: beforeNew.receiptHash });
    expect(engine.snapshot().enrollments.records['new-south']?.status).toBe('open');
    ingest(135, 0, 0, 109);
    ingest(145, 0, 0, 109);
    const final = engine.snapshot().enrollments.records;
    expect(canonicalJSON(final['old-south'])).toBe(originalTerminalBytes);
    expect(final['new-south']).toMatchObject({ status: 'matched', reason: null,
      arrivedAt: syntheticOrigin + 135000, det: 9 });
    expect(final['new-south']!.encounter!.ordinal).toBeGreaterThan(oldTerminal!.encounter!.ordinal);
    expect(final['new-south']!.availableAt - beforeOld.availableAt).toBeLessThan(DEFAULT_PROTOCOL.matchWindowMs);
  });

  it('cannot score an arrival between opaque model generation and actual forecast visibility', () => {
    const engine = new EncounterEngine({ namespaceId: 'fixture-visible-after-arrival-r3',
      catalogs: [compileCatalog(syntheticLoop())], fixtureMode: true, prospectiveCutoff: null });
    engine.ingest(syntheticPacket(1, 0, 0.003, -0.003));
    const earlier = syntheticPacket(2, 10, 0, -0.003);
    engine.ingest(earlier);
    engine.ingest(syntheticPacket(3, 20, 0, 0, 109));
    const visible = syntheticPacket(4, 25, 0, 0, 109);
    engine.ingest(visible);
    const opportunity = { id: 'late-visible', vehicle: syntheticVehicle, stopId: 109, horizon: '5-10' as const,
      forecastAt: earlier.availableAt, availableAt: visible.availableAt, receiptHash: visible.receiptHash };
    engine.enroll(opportunity);
    expect(engine.snapshot().enrollments.records['late-visible']).toMatchObject({
      status: 'missing', det: null, reason: 'forecast-clock-not-actual-availability',
    });
    const refusedBytes = canonicalJSON(engine.snapshot().enrollments.records['late-visible']);
    engine.ingest(syntheticPacket(5, 30, 0, 0, 109));
    engine.enroll(opportunity);
    expect(canonicalJSON(engine.snapshot().enrollments.records['late-visible'])).toBe(refusedBytes);
    expect(() => engine.enroll({ ...opportunity, forecastAt: visible.availableAt })).toThrow();
  });
});
