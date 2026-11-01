/** Test DATA adapter only. Never imported by an actor or a prospective runner. */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { projectPublicPacket } from './raw-ingress.js';
import type { RawPacket, TransportTiming } from './raw-ingress.js';
import type { EncounterEngine } from './engine.js';

export const PINK_RAW_FIXTURE_SHA256 = '4ced7df2c040897ca70e5b28fec176b08e6e56973336b188984ffe50fa266236';
export const PINK_FIXTURE_VEHICLE = { routeId: 8, busId: 68430, busName: '#326' } as const;
export const ORIGINAL_FORECAST_AT = Date.parse('2026-10-30T13:56:02.218Z');
export const SOUTH_109_FIRST_OBSERVED_AT = 1793369458818;
export const SOUTH_109_SECOND_OBSERVED_AT = 1793369463853;
export const NORTH_110_FIRST_OBSERVED_AT = 1793370708942;
export const NORTH_110_CONFIRMATION_OBSERVED_AT = 1793370718996;
export const NORTH_109_FIRST_OBSERVED_AT = 1793370769168;
export const LATER_SOUTH_109_FIRST_OBSERVED_AT = 1793371944084;

type RawBusValue = Record<string, unknown>;
export interface RecordedRawRecord {
  type: 'record';
  seq: number;
  kind: 'public-feed' | 'exact-frame';
  receivedAt: number;
  packetFrameCount: number;
  packetMetadata: Record<string, unknown>;
  busObjectRefs: number[];
  buses: RawBusValue[];
  payloadPresent?: boolean;
  busesPresent?: boolean;
  exactTargetPresent?: boolean;
  frameIndex?: number;
  frameMetadata?: Record<string, unknown>;
}

/** Expand lossless storage references, preserving EVERY record, duplicate,
 * frame, bus occurrence, clock and source ordering. No observed-fix dedup. */
export function loadPinkRawRecords(): RecordedRawRecord[] {
  const bytes = readFileSync(new URL('./__fixtures__/pink-raw-source-2h.v1.jsonl', import.meta.url));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), PINK_RAW_FIXTURE_SHA256);
  const lines = bytes.toString('utf8').split('\n');
  assert.equal(lines.pop(), '', 'authenticated complete fixture ends in LF');
  const buses = new Map<number, RawBusValue>();
  const records: RecordedRawRecord[] = [];
  for (const [lineIndex, line] of lines.entries()) {
    const value = JSON.parse(line) as Record<string, unknown>;
    if (lineIndex === 0) {
      assert.equal(value.type, 'schema');
      assert.equal(value.frameAndPublicCopiesRetained, true);
      assert.equal(value.consumerClockInvented, false);
      continue;
    }
    if (value.type === 'bus') {
      const id = value.id as number;
      assert.equal(buses.has(id), false);
      assert.equal(id, buses.size);
      buses.set(id, value.value as RawBusValue);
      continue;
    }
    assert.equal(value.type, 'record');
    const record = value as unknown as Omit<RecordedRawRecord, 'buses'>;
    assert.equal(record.seq, records.length + 1);
    const expanded = record.busObjectRefs.map(id => {
      const bus = buses.get(id);
      assert(bus !== undefined, 'bus reference must already be retained');
      return structuredClone(bus);
    });
    records.push({ ...record, buses: expanded });
  }
  assert.equal(records.length, 4314);
  assert.equal(records.filter(record => record.kind === 'public-feed').length, 2874);
  assert.equal(records.filter(record => record.kind === 'exact-frame').length, 1440);
  assert.equal(buses.size, 1441);
  assert.equal(records.reduce((count, record) => count + record.buses.length, 0), 4314);
  return records;
}

/** Reconstruct only the source envelope that the raw projector accepts.
 * Placeholder frame bodies preserve original frame COUNT, not model context.
 * All original GPS/proxy/audit values remain unchanged in feed.buses. */
export function recordedPacketInput(record: RecordedRawRecord): Record<string, unknown> {
  return {
    ...record.packetMetadata,
    frames: Array.from({ length: record.packetFrameCount }, () => null),
    feed: { buses: structuredClone(record.buses) },
  };
}

/** Fixture replay clock only: original source receipt becomes the simulated
 * consumer clock in fixtureMode. This never claims a NEW prospective receipt. */
export function recordedTiming(record: RecordedRawRecord): TransportTiming {
  return {
    originalReceivedAt: record.receivedAt,
    availableAt: record.receivedAt,
    origin: record.kind === 'exact-frame' ? 'historical-frame' : 'public-current',
  };
}

export function recordedPacket(record: RecordedRawRecord,
  input: unknown = recordedPacketInput(record)): RawPacket {
  return projectPublicPacket(input, recordedTiming(record));
}

export function originalCurrentRecord(records: readonly RecordedRawRecord[], observedAt: number): RecordedRawRecord {
  const matching = records.filter(record => record.kind === 'public-feed' && record.packetFrameCount === 0
    && record.buses.some(bus => bus.observed_at === observedAt));
  assert.equal(matching.length, 1, 'pin one original caught-up receipt, not an observed-clock duplicate');
  return matching[0]!;
}

/** Public API integration only: consume the complete original sequence and
 * insert two fixture opportunities at their original visible receipt clock.
 * The constant horizon is a sampling label, never an outcome/phase input. */
export function replayPinkTrace(engine: EncounterEngine, records: readonly RecordedRawRecord[],
  transform: (input: Record<string, unknown>, record: RecordedRawRecord) => unknown = input => input) {
  type Batch = ReturnType<EncounterEngine['ingest']>;
  const encounterEvents: Array<Batch['encounterEvents'][number]> = [];
  const outcomes: Array<Batch['outcomes'][number]> = [];
  let lastPacket: RawPacket | null = null;
  let enrollmentSnapshot: ReturnType<EncounterEngine['snapshot']> | null = null;
  let packetsConsumed = 0;
  const enroll = () => {
    assert(lastPacket !== null);
    assert(lastPacket.availableAt <= ORIGINAL_FORECAST_AT);
    for (const stopId of [109, 110]) engine.enroll({
      id: `recorded-${stopId}`, vehicle: PINK_FIXTURE_VEHICLE, stopId, horizon: '5-10',
      forecastAt: ORIGINAL_FORECAST_AT, availableAt: ORIGINAL_FORECAST_AT,
      receiptHash: lastPacket.receiptHash,
    });
    return engine.snapshot();
  };
  for (const record of records) {
    if (enrollmentSnapshot === null && record.receivedAt > ORIGINAL_FORECAST_AT) enrollmentSnapshot = enroll();
    const input = transform(recordedPacketInput(record), record);
    const packet = recordedPacket(record, input);
    const batch = engine.ingest(packet);
    encounterEvents.push(...batch.encounterEvents);
    outcomes.push(...batch.outcomes);
    lastPacket = packet;
    packetsConsumed++;
  }
  assert(enrollmentSnapshot !== null, 'full fixture must include the original forecast opportunity');
  assert(lastPacket !== null);
  outcomes.push(...engine.tick(lastPacket.availableAt));
  return { encounterEvents, outcomes, enrollmentSnapshot, snapshot: engine.snapshot(), packetsConsumed };
}
