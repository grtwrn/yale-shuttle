import { describe, expect, it } from 'vitest';
import { observationHash, sha256 } from './canonical.js';
import { compileCatalog } from './catalog.js';
import { advanceEncounters, emptyEncounterLedger, encounterKey, firstCurbKnown, invalidateEncounters } from './encounters.js';
import { advanceProgress, queryCurrentEncounter, queryNextEncounter } from './progress.js';
import { PROTOCOL_SHA256 } from './protocol.js';
import type { CompiledCatalog, ProgressResult, ProgressState, RawObservation } from './types.js';

const start = 1_800_000_000_000;
const hash = (name: string) => sha256(name);
function catalog(height = 0.01): CompiledCatalog {
  return compileCatalog({ v: 1, routeId: 8, sourceTopologyHash: hash('original published square'),
    pathProvenance: 'Synthetic straight raw segments; explicit service/nonservice review for this unit test only',
    path: [{ lat: 0, lon: 0 }, { lat: 0, lon: 0.01 }, { lat: height, lon: 0.01 },
      { lat: height, lon: 0 }, { lat: 0, lon: 0 }],
    publishedStops: [109], stopCoords: { 109: { lat: 0, lon: 0.005 } },
    calls: [{ id: 'south109', stopId: 109, publishedIndex: 0, service: 'published-qualified',
      masks: [{ segment: 0 }], evidenceHashes: [hash('reviewed original South slot')] },
    ...(height < 0.001 ? [{ id: 'north-counterpass109', stopId: 109, publishedIndex: null,
      service: 'traversal-only' as const, masks: [{ segment: 2 }], evidenceHashes: [hash('reviewed North nonservice')] }] : [])] });
}
function fix(delta: number, overrides: Partial<RawObservation> = {}): RawObservation {
  const base = { sourceEpoch: 'fixture-source', routeId: 8, busId: 68430, busName: '#326', observedAt: start + delta,
    lat: 0, lon: 0.005, stationary: true, atStopId: 109, ...overrides };
  const observation = { ...base, observationHash: observationHash(base), evidence: {
    receiptHash: hash(`stripped-receipt-${delta}`), observationHash: '', observedAt: base.observedAt,
    originalReceivedAt: base.observedAt, availableAt: base.observedAt, origin: 'public-current' as const,
    frameCount: 0, hasMore: false, cursor: 1, latest: 1 } };
  observation.evidence.observationHash = observation.observationHash;
  return observation;
}
const result = (state: ProgressState): ProgressResult => ({ state, status: 'seeded', events: [], availableAt: state.availableAt });

describe('forecast-independent encounter events', () => {
  it('confirms a global event without any enrolled forecast, preserving both receipt clocks', () => {
    const c = catalog(), first = fix(0), p1 = advanceProgress(null, first, c);
    const a = advanceEncounters(emptyEncounterLedger(), first, p1, c);
    expect(a.events.map(e => e.kind)).toEqual(['candidate']);
    const almost = fix(8999), almostPhase = advanceProgress(p1.state, almost, c);
    const pending = advanceEncounters(a.ledger, almost, almostPhase, c);
    expect(pending.events).toEqual([]);
    const second = fix(9000), p2 = advanceProgress(almostPhase.state, second, c);
    const b = advanceEncounters(pending.ledger, second, p2, c);
    expect(b.events.map(e => e.kind)).toEqual(['confirmed']);
    const event = b.events[0]!;
    if (event.kind !== 'confirmed') throw new Error('Expected positive proxy');
    expect(event.arrival!.evidence.observedAt).toBe(start);
    expect(event.confirmation!.evidence.observedAt).toBe(start + 9000);
    expect(event.availableAt).toBe(start + 9000);
    const afterGap = invalidateEncounters(b.ledger, 'receipt-gap', start + 40000);
    expect(afterGap.ledger.records[encounterKey(event.encounter)]).toEqual(event);
    expect(afterGap.events.map(e => e.kind)).toEqual(['continuity-censored']);
  });

  it('upgrades a historical fix once at live receipt availability, never treating copies as two clocks', () => {
    const c = catalog(), historical = fix(0);
    historical.evidence = { ...historical.evidence, origin: 'historical-frame', frameCount: 1 };
    const p1 = advanceProgress(null, historical, c);
    const initial = advanceEncounters(emptyEncounterLedger(), historical, p1, c);
    expect(initial.events).toEqual([]);
    const live = fix(0);
    live.evidence = { ...live.evidence, originalReceivedAt: start + 1000, availableAt: start + 1000 };
    const livePhase = advanceProgress(p1.state, live, c);
    const upgraded = advanceEncounters(initial.ledger, live, livePhase, c);
    expect(upgraded.events.map(e => e.kind)).toEqual(['candidate']);
    const candidate = upgraded.events[0]!;
    if (candidate.kind !== 'candidate') throw new Error('Expected first live witness');
    expect(candidate.arrival!.availableAt).toBe(start + 1000);
    expect(candidate.arrival!.evidence.observedAt).toBe(start);
    const copy = { ...live, evidence: { ...live.evidence, availableAt: start + 10000, originalReceivedAt: start + 10000 } };
    const duplicate = advanceEncounters(upgraded.ledger, copy, advanceProgress(p1.state, copy, c), c);
    expect(duplicate.events).toEqual([]);
    const next = fix(9000);
    next.evidence = { ...next.evidence, originalReceivedAt: start + 10000, availableAt: start + 10000 };
    const confirmed = advanceEncounters(duplicate.ledger, next, advanceProgress(p1.state, next, c), c);
    expect(confirmed.events.map(e => e.kind)).toEqual(['confirmed']);
  });

  it('does not borrow newer phase for a delayed older live upgrade', () => {
    const c = catalog(), old = fix(0);
    old.evidence = { ...old.evidence, origin: 'historical-frame', frameCount: 1 };
    const p1 = advanceProgress(null, old, c), initial = advanceEncounters(emptyEncounterLedger(), old, p1, c);
    const fresh = fix(9000), p2 = advanceProgress(p1.state, fresh, c);
    const current = advanceEncounters(initial.ledger, fresh, p2, c);
    const delayed = fix(0);
    delayed.evidence = { ...delayed.evidence, originalReceivedAt: start + 10000, availableAt: start + 10000 };
    const rejected = advanceEncounters(current.ledger, delayed, { ...p2, events: [], availableAt: start + 10000 }, c);
    expect(rejected.events).toEqual([]);
    const event = Object.values(rejected.ledger.records)[0]!;
    expect(event.kind).toBe('candidate');
    expect(event.arrival!.evidence.observedAt).toBe(start + 9000);
  });

  it('censors the old vehicle identity before installing the changed identity', () => {
    const c = catalog(), first = fix(0), p1 = advanceProgress(null, first, c);
    const a = advanceEncounters(emptyEncounterLedger(), first, p1, c);
    const changed = fix(9000, { busName: '#327' });
    const b = advanceEncounters(a.ledger, changed, advanceProgress(p1.state, changed, c), c);
    expect(b.events.map(e => e.kind)).toEqual(['censored', 'continuity-censored']);
    const boundary = b.events[1]!;
    if (boundary.kind !== 'continuity-censored') throw new Error('Expected old-identity boundary');
    expect(boundary.vehicle!.busName).toBe('#326');
    expect(boundary.reason).toBe('identity-change');
    expect(b.ledger.vehicle!.busName).toBe('#327');
  });

  it('emits missed-passage events even when the bus never supplies a stationary curb witness', () => {
    const c = catalog(), first = fix(0, { stationary: false, atStopId: null });
    const p1 = advanceProgress(null, first, c), a = advanceEncounters(emptyEncounterLedger(), first, p1, c);
    expect(a.events).toEqual([]);
    const outside = fix(15000, { lon: 0.008, stationary: false, atStopId: null });
    const p2 = advanceProgress(p1.state, outside, c);
    const b = advanceEncounters(a.ledger, outside, p2, c);
    expect(b.events.map(e => e.kind)).toEqual(['passed-unconfirmed']);
    const event = b.events[0]!;
    if (event.kind !== 'passed-unconfirmed') throw new Error('Expected missed global encounter');
    expect(event.encounter.occurrenceId).toBe('south109');
    expect(event.arrival).toBeNull();
    expect(firstCurbKnown(b.ledger, event.encounter)).toBe(false);
  });

  it('uses CURRENT, never a future NEXT South109 proof, for a North nearest-curb witness', () => {
    // These literal, already-resolved phase intervals isolate the ledger's
    // current-vs-next contract; they do not qualify a cold-start phase algorithm.
    const c = catalog(0.0004), observation = fix(9000, { lat: 0.0004 });
    const south = c.calls.find(call => call.id === 'south109')!;
    const north = c.calls.find(call => call.id === 'north-counterpass109')!;
    const mid = (north.components[0]!.lo + north.components[0]!.hi) / 2;
    const state: ProgressState = { v: 1, protocolHash: PROTOCOL_SHA256, catalogHash: c.catalogHash,
      sourceEpoch: observation.sourceEpoch, vehicle: { routeId: 8, busId: 68430, busName: '#326' },
      generation: { id: hash('known raw route phase'), seedObservationHash: hash('raw prehistory'),
        seedAvailableAt: start, seedIntervals: [{ lo: 0, hi: 1 }] },
      intervals: [{ lo: mid - 1, hi: mid + 1 }], lastRawPoint: { lat: observation.lat, lon: observation.lon },
      lastObservedAt: observation.observedAt, lastAvailableAt: observation.evidence.availableAt,
      lastObservationHash: observation.observationHash, lastEvidence: observation.evidence,
      evidenceChainHash: hash('raw branch evidence'), availableAt: observation.evidence.availableAt,
      seedGateBaselines: { [south.id]: 0, [north.id]: 0 }, passedThrough: { [south.id]: 0 } };
    const next = queryNextEncounter(state, c, 109);
    expect(next.kind).toBe('bound');
    if (next.kind !== 'bound') throw new Error('Expected a future South service');
    expect(next.encounter).toMatchObject({ occurrenceId: 'south109', ordinal: 1 });
    expect(queryCurrentEncounter(state, c, 109).kind).toBe('unknown');
    expect(advanceEncounters(emptyEncounterLedger(), observation, result(state), c).events).toEqual([]);
  });

  it('keeps the actual75m and freshness gates after independent phase resolution', () => {
    const c = catalog(), current = fix(0), phase = advanceProgress(null, current, c);
    const outside = { ...current, lat: 0.0008 };
    // Same resolved phase supplied deliberately: the ledger still checks the
    // actual GPS curb distance rather than accepting phase compatibility alone.
    expect(advanceEncounters(emptyEncounterLedger(), outside, phase, c).events).toEqual([]);
    const oldReceipt = { ...current, evidence: { ...current.evidence, availableAt: start + 30001 } };
    expect(advanceEncounters(emptyEncounterLedger(), oldReceipt,
      { ...phase, availableAt: start + 30001 }, c).events).toEqual([]);
  });
});
