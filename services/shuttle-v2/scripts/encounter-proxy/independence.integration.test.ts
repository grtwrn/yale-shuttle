import { describe, expect, it } from 'vitest';
import { EncounterEngine } from './engine.js';
import { compileCatalog } from './catalog.js';
import { canonicalJSON } from './canonical.js';
import { pinkCandidateSpec, PINK_CANDIDATE_QUALIFICATION } from './pink-candidate.fixture.js';
import { stripRawExchange } from './raw-ingress.js';
import {
  loadPinkRawRecords, originalCurrentRecord, recordedPacket, recordedPacketInput,
  recordedTiming, replayPinkTrace, NORTH_110_FIRST_OBSERVED_AT,
} from './recorded-fixture.test-helper.js';
import type { RecordedRawRecord } from './recorded-fixture.test-helper.js';

/** Adversarial synthetic predictor values. Raw identity/GPS/proxy fields and
 * every observed/receipt/availability clock remain fixed. Audit-only heading,
 * speed and provider-last-stop also cannot choose independent outcome phase. */
function adversarialModelPayload(input: Record<string, unknown>, record: RecordedRawRecord): Record<string, unknown> {
  const copy = structuredClone(input);
  const feed = copy.feed as { buses: Record<string, unknown>[]; [key: string]: unknown };
  copy.modelAt = 0;
  copy.servedAt = record.receivedAt + 1000000;
  copy.model_params = { preferOppositePass: true, drive: 0, conformal: 1000000 };
  copy.modelContext = { lead: 999999, posterior: [1, 0], selectedPass: 'opposite', snapshot: 'not-a-raw-seed' };
  feed.server_eta = {
    v: 2, at: record.receivedAt + 1000000, servedAt: 0,
    buses: [['326', 'Pink', 99999, { stopId: 109, standingSec: 999999, approach: true }]],
    travel: [-999], rows: [[0, 109, 0, 0, 0, 0, 0, 0, 0], [0, 110, 999999, 0, 999999, 999, 0, 0, 0]],
    serviceStopsAhead: [0, 999], cdf: [[1, 0]],
  };
  feed.model_params = { dwell: 999999, drive: 0 };
  feed.beliefs = { north: 1, south: 0, posterior: [0, 1] };
  feed.forecasts = [{ stop: 109, eta: 0, selectedPass: 'opposite', hops: 999 }];
  feed.segments = { 8: [0, 999999] };
  feed.dwells = { 109: [999999] };
  feed.observationTopology = { repairedOrder: [109, 110, 109], index: 999 };
  for (const bus of feed.buses) {
    bus.heading = 999;
    bus.last_stop_id = 999999;
    bus.recent_speed = { mph: 999999, at: 0, expires_at: 9999999999999 };
    bus.model = { belief: 'wrong-side', eta: 0, travel: 999 };
    bus.forecast = { stop: 109, hops: 0, posterior: [0, 1] };
  }
  // Only the frame count is an outcome input; model-valued frame bodies are not.
  copy.frames = (copy.frames as unknown[]).map(() => ({ model: { travel: 999, seed: 'forbidden' } }));
  return copy;
}

describe('raw outcome independence across complete authenticated fixture prehistory', () => {
  it('separates external packet custody from the stripped raw receipt and remains sensitive to real raw fields', () => {
    const records = loadPinkRawRecords();
    const record = originalCurrentRecord(records, NORTH_110_FIRST_OBSERVED_AT);
    const original = recordedPacketInput(record), altered = adversarialModelPayload(original, record);
    const encode = (input: unknown) => new TextEncoder().encode(JSON.stringify(input));
    const before = stripRawExchange(encode(original), 200, recordedTiming(record));
    const after = stripRawExchange(encode(altered), 200, recordedTiming(record));
    expect(before.error).toBeNull();
    expect(after.error).toBeNull();
    expect(before.fullPacketHash).not.toBe(after.fullPacketHash);
    expect(after.packet).toEqual(before.packet);
    expect(after.packet?.receiptHash).toBe(before.packet?.receiptHash);
    expect(after.packet?.observations[0]).not.toHaveProperty('heading');
    expect(after.packet?.observations[0]).not.toHaveProperty('last_stop_id');
    expect(after.packet?.observations[0]).not.toHaveProperty('model');
    const rawChanged = structuredClone(original);
    const rawBus = (rawChanged.feed as { buses: Record<string, unknown>[] }).buses[0]!;
    rawBus.stationary = false;
    const changed = recordedPacket(record, rawChanged);
    expect(changed.observations[0]!.observationHash).not.toBe(before.packet!.observations[0]!.observationHash);
    expect(changed.receiptHash).not.toBe(before.packet!.receiptHash);
  });

  it('produces byte-identical events, exclusions and state after adversarial model changes at every original packet', () => {
    expect(PINK_CANDIDATE_QUALIFICATION.qualificationPending).toBe(true);
    const records = loadPinkRawRecords();
    const catalog = compileCatalog(pinkCandidateSpec(true));
    const create = () => new EncounterEngine({ namespaceId: 'fixture-model-invariance-r3',
      catalogs: [catalog], fixtureMode: true, prospectiveCutoff: null });
    const baselineEngine = create(), alteredEngine = create();
    const baseline = replayPinkTrace(baselineEngine, records);
    const altered = replayPinkTrace(alteredEngine, records, adversarialModelPayload);
    expect(baseline.packetsConsumed).toBe(4314);
    expect(altered.packetsConsumed).toBe(4314);
    // External full-packet/control custody hashes intentionally are not here:
    // changing forbidden model payloads changes those hashes by construction.
    expect(canonicalJSON(altered.encounterEvents)).toBe(canonicalJSON(baseline.encounterEvents));
    expect(canonicalJSON(altered.outcomes)).toBe(canonicalJSON(baseline.outcomes));
    expect(canonicalJSON(altered.snapshot)).toBe(canonicalJSON(baseline.snapshot));
    expect(alteredEngine.canonicalOutcomeState()).toBe(baselineEngine.canonicalOutcomeState());
    // Non-vacuous actual controls: an incorrect all-null matcher cannot pass.
    expect(baseline.snapshot.enrollments.records['recorded-109']).toMatchObject({
      status: 'missing', reason: 'passed-without-confirmed-proxy', det: null,
    });
    expect(baseline.snapshot.enrollments.records['recorded-110']).toMatchObject({
      status: 'matched', arrivedAt: NORTH_110_FIRST_OBSERVED_AT,
    });
  });
});
