import { describe, expect, it } from 'vitest';
import { compileCatalog } from './catalog.js';
import { canonicalJSON, sha256 } from './canonical.js';
import { EncounterEngine } from './engine.js';
import { PROTOCOL_SHA256 } from './protocol.js';
import { projectPublicPacket } from './raw-ingress.js';
import { squareSpec } from './test-fixtures.js';

const vehicle = { routeId: 100, busId: 7, busName: '#raw' };
function packet(at: number, cursor: number, historical = false) {
  return projectPublicPacket({ v: 1, epoch: 'controlled-engine-epoch', build: 'controlled', cursor, latest: cursor,
    hasMore: false, frames: historical ? [null] : [], feed: { buses: [{ route_id: 100, bus_id: 7, bus_name: '#raw',
      observed_at: at, lat: 41, lon: -73, stationary: false, at_stop_id: null }] } },
  { originalReceivedAt: at + 100, availableAt: at + 100 });
}
const opportunity = (id: string, p: ReturnType<typeof packet>) => ({ id, vehicle, stopId: 100,
  horizon: '5-10' as const, forecastAt: p.availableAt, availableAt: p.availableAt, receiptHash: p.receiptHash });

describe('serial independent enrollment boundary', () => {
  it('retains historical-only refusal forever and can bind a genuinely new live opportunity', () => {
    const engine = new EncounterEngine({ namespaceId: 'fixture-caught-up', catalogs: [compileCatalog(squareSpec())],
      fixtureMode: true, prospectiveCutoff: null });
    const history = packet(1000, 1, true); engine.ingest(history);
    engine.enroll(opportunity('history', history));
    const rejected = engine.snapshot().enrollments.records['history'];
    expect(rejected).toMatchObject({ status: 'missing', reason: 'current-live-receipt-unavailable' });
    const live = packet(1000, 1); engine.ingest(live);
    engine.enroll(opportunity('new-live', live));
    expect(engine.snapshot().enrollments.records['new-live']?.status).toBe('open');
    engine.enroll(opportunity('history', history));
    expect(canonicalJSON(engine.snapshot().enrollments.records['history'])).toBe(canonicalJSON(rejected));
  });

  it('requires qualification metadata and enforces the prospective cutoff as a permanent refusal', () => {
    const catalog = compileCatalog(squareSpec());
    expect(() => new EncounterEngine({ namespaceId: 'bad-pilot', catalogs: [catalog],
      fixtureMode: false, prospectiveCutoff: 2000 })).toThrow();
    expect(() => new EncounterEngine({ namespaceId: 'fake-fixture-dates', catalogs: [catalog],
      fixtureMode: true, prospectiveCutoff: 2000 })).toThrow();
    const engine = new EncounterEngine({ namespaceId: 'controlled-cutoff-test', catalogs: [catalog],
      fixtureMode: false, prospectiveCutoff: 2000, qualification: { qualificationHash: sha256('controlled qualification'),
        sourceInventoryHash: sha256('controlled source inventory'), protocolHash: PROTOCOL_SHA256,
        catalogHashes: { 100: catalog.catalogHash }, createdAt: 10, completedAt: 100 } });
    const before = packet(1000, 1); engine.ingest(before);
    engine.enroll(opportunity('before-cutoff', before), before.availableAt);
    const rejected = engine.snapshot().enrollments.records['before-cutoff'];
    expect(rejected).toMatchObject({ status: 'missing', reason: 'before-prospective-cutoff' });
    const after = packet(3000, 2); engine.ingest(after);
    engine.enroll(opportunity('after-cutoff', after), after.availableAt);
    expect(engine.snapshot().enrollments.records['after-cutoff']?.status).toBe('open');
    engine.enroll(opportunity('before-cutoff', before), after.availableAt);
    expect(canonicalJSON(engine.snapshot().enrollments.records['before-cutoff'])).toBe(canonicalJSON(rejected));
  });

  it('does not change the raw state when receipt/provenance validation rejects an input', () => {
    const engine = new EncounterEngine({ namespaceId: 'fixture-input-integrity', catalogs: [compileCatalog(squareSpec())],
      fixtureMode: true, prospectiveCutoff: null });
    engine.ingest(packet(1000, 1)); const before = canonicalJSON(engine.snapshot());
    const altered = packet(2000, 2); altered.observations[0]!.evidence.availableAt--;
    expect(() => engine.ingest(altered)).toThrow();
    expect(canonicalJSON(engine.snapshot())).toBe(before);
  });

  it('refuses a delayed bind across an actual receipt gap without letting forecasts change raw event truth', () => {
    const create = () => new EncounterEngine({ namespaceId: 'fixture-late-bind-gap', catalogs: [compileCatalog(squareSpec())],
      fixtureMode: true, prospectiveCutoff: null });
    const withForecast = create(), rawOnly = create(), first = packet(1000, 1);
    withForecast.ingest(first); rawOnly.ingest(first);
    const before = withForecast.canonicalOutcomeState();
    const result = withForecast.enroll(opportunity('late-binding', first), first.availableAt + 31000);
    expect(result.enrollment).toMatchObject({ status: 'missing', reason: 'actual-receipt-gap-before-binding' });
    expect(withForecast.canonicalOutcomeState()).toBe(before);
    const next = packet(33000, 2);
    expect(canonicalJSON(withForecast.ingest(next).encounterEvents)).toBe(canonicalJSON(rawOnly.ingest(next).encounterEvents));
    expect(withForecast.canonicalOutcomeState()).toBe(rawOnly.canonicalOutcomeState());
  });
});
