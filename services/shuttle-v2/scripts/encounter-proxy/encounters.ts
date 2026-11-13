import { canonicalJSON, sha256 } from './canonical.js';
import { distanceMeters } from './catalog.js';
import { queryCurrentEncounter } from './progress.js';
import { assertProtocol, DEFAULT_PROTOCOL } from './protocol.js';
import type { Protocol } from './protocol.js';
import type { CompiledCatalog, EncounterRef, EvidenceRef, PhaseReason, ProgressResult, RawObservation, VehicleKey } from './types.js';

type QualifiedService = 'published-qualified' | 'spur-qualified';
export interface CurbWitness {
  evidence: EvidenceRef;
  phaseEvidenceChainHash: string;
  availableAt: number;
}
export interface EncounterEvent {
  kind: 'candidate' | 'confirmed' | 'passed-unconfirmed' | 'censored';
  eventId: string;
  encounter: EncounterRef;
  stopId: number;
  service: QualifiedService;
  availableAt: number;
  evidenceChainHash: string;
  arrival: CurbWitness | null;
  confirmation: CurbWitness | null;
  reason: string | null;
}
export interface EncounterBoundaryEvent {
  kind: 'continuity-censored';
  eventId: string;
  generationId: string | null;
  vehicle: VehicleKey | null;
  reason: PhaseReason;
  availableAt: number;
}
export type EncounterLedgerEvent = EncounterEvent | EncounterBoundaryEvent;
export interface EncounterLedger {
  v: 1;
  vehicle: VehicleKey | null;
  generationId: string | null;
  records: Readonly<Record<string, EncounterEvent>>;
  lastAvailableAt: number;
  lastWitness: { generationId: string; observedAt: number; observationHash: string } | null;
}
export interface EncounterUpdate { ledger: EncounterLedger; events: EncounterLedgerEvent[] }

export function emptyEncounterLedger(): EncounterLedger {
  return { v: 1, vehicle: null, generationId: null, records: {}, lastAvailableAt: 0, lastWitness: null };
}
export const encounterKey = (ref: EncounterRef): string => canonicalJSON([ref.generationId, ref.occurrenceId, ref.ordinal]);
export function firstCurbKnown(ledger: EncounterLedger, ref: EncounterRef): boolean {
  return ledger.records[encounterKey(ref)]?.arrival !== undefined && ledger.records[encounterKey(ref)]?.arrival !== null;
}
function checkClock(ledger: EncounterLedger, at: number): void {
  if (!Number.isSafeInteger(at) || at < ledger.lastAvailableAt) throw new Error('Regressing encounter availability clock');
}
function semanticEvent(value: Omit<EncounterEvent, 'eventId'>): EncounterEvent {
  return { ...value, eventId: sha256(canonicalJSON({ v: 1, ...value })) };
}
function censor(ledger: EncounterLedger, reason: PhaseReason, at: number, generationId: string | null): EncounterUpdate {
  const records = { ...ledger.records }, events: EncounterLedgerEvent[] = [];
  for (const [key, record] of Object.entries(records)) {
    if (record.kind !== 'candidate' || (generationId !== null && record.encounter.generationId !== generationId)) continue;
    const { eventId: _previousEventId, ...body } = record;
    const terminal = semanticEvent({ ...body, kind: 'censored', availableAt: at, reason });
    records[key] = terminal; events.push(terminal);
  }
  const boundary = { kind: 'continuity-censored' as const, generationId, vehicle: ledger.vehicle, reason, availableAt: at };
  events.push({ ...boundary, eventId: sha256(canonicalJSON({ v: 1, ...boundary })) });
  return { ledger: { ...ledger, records, lastAvailableAt: at }, events };
}
/** A boundary also reaches enrollments whose target has not yet had a curb candidate. */
export function invalidateEncounters(ledger: EncounterLedger, reason: PhaseReason, availableAt: number,
  protocol: Readonly<Protocol> = DEFAULT_PROTOCOL): EncounterUpdate {
  assertProtocol(protocol); checkClock(ledger, availableAt);
  return censor(ledger, reason, availableAt, ledger.generationId);
}

function liveWitness(observation: RawObservation, availableAt: number, protocol: Readonly<Protocol>): boolean {
  const e = observation.evidence;
  return e.observationHash === observation.observationHash && e.observedAt === observation.observedAt
    && e.origin === 'public-current' && e.frameCount === 0 && e.hasMore === false && e.cursor === e.latest
    && [observation.observedAt, e.originalReceivedAt, e.availableAt, availableAt].every(Number.isSafeInteger)
    && observation.observedAt <= e.originalReceivedAt && e.originalReceivedAt <= e.availableAt && e.availableAt <= availableAt
    && e.originalReceivedAt - observation.observedAt <= protocol.maxAbsLiveObservedReceiptSkewMs
    && availableAt - observation.observedAt <= protocol.maxAbsLiveObservedReceiptSkewMs;
}

/** Global per-vehicle proxy events; no forecast/enrollment input enters this reducer. */
export function advanceEncounters(previous: EncounterLedger, observation: RawObservation | null,
  progress: ProgressResult, catalog: CompiledCatalog, protocol: Readonly<Protocol> = DEFAULT_PROTOCOL): EncounterUpdate {
  assertProtocol(protocol);
  const availableAt = Math.max(progress.availableAt, observation?.evidence.availableAt ?? 0);
  checkClock(previous, availableAt);
  let ledger: EncounterLedger = { ...previous, lastAvailableAt: availableAt };
  const events: EncounterLedgerEvent[] = [];
  for (const event of progress.events) {
    if (event.availableAt > availableAt) throw new Error('Future phase evidence');
    if (event.kind === 'invalidate') {
      const update = censor(ledger, event.reason, availableAt, event.generationId);
      ledger = update.ledger; events.push(...update.events);
      continue;
    }
    if (event.service !== 'published-qualified' && event.service !== 'spur-qualified') continue;
    const key = encounterKey(event.encounter), existing = ledger.records[key];
    if (existing && existing.kind !== 'candidate') continue;
    const terminal = semanticEvent({ kind: 'passed-unconfirmed', encounter: { ...event.encounter }, stopId: event.stopId,
      service: event.service, availableAt, evidenceChainHash: event.evidenceChainHash,
      arrival: existing?.arrival ?? null, confirmation: null, reason: 'passed-without-confirmed-proxy' });
    ledger = { ...ledger, records: { ...ledger.records, [key]: terminal } }; events.push(terminal);
  }
  // Boundaries describe the OLD identity/generation. Install a new identity
  // only after those events have censored its open promises.
  ledger = { ...ledger,
    vehicle: observation ? { routeId: observation.routeId, busId: observation.busId, busName: observation.busName }
      : progress.state?.vehicle ?? previous.vehicle,
    generationId: progress.state?.generation?.id ?? previous.generationId };
  // An identical historical fix may acquire live provenance once. An older fix
  // cannot borrow the current phase after a newer observation has advanced it.
  const current = progress.state;
  if (!observation || progress.status === 'invalid' || !current || !current.generation
    || observation.observationHash !== current.lastObservationHash || observation.observedAt !== current.lastObservedAt
    || observation.sourceEpoch !== current.sourceEpoch || observation.routeId !== current.vehicle.routeId
    || observation.busId !== current.vehicle.busId || observation.busName !== current.vehicle.busName
    || !liveWitness(observation, availableAt, protocol) || observation.stationary !== true || observation.atStopId === null)
    return { ledger, events };
  const proof = queryCurrentEncounter(current, catalog, observation.atStopId, protocol);
  if (proof.kind !== 'current' || proof.availableAt > availableAt) return { ledger, events };
  const call = catalog.calls.find(c => c.id === proof.encounter.occurrenceId);
  if (!call || call.stopId !== observation.atStopId || !(distanceMeters(observation, call.coord) <= protocol.curbProxyRadiusM))
    return { ledger, events };
  const spent = ledger.lastWitness;
  if (spent?.generationId === proof.encounter.generationId && observation.observedAt <= spent.observedAt)
    return { ledger, events };
  const key = encounterKey(proof.encounter), existing = ledger.records[key];
  if (existing && existing.kind !== 'candidate') return { ledger, events };
  const witness: CurbWitness = { evidence: { ...observation.evidence }, phaseEvidenceChainHash: proof.evidenceChainHash,
    availableAt: Math.max(observation.evidence.availableAt, proof.availableAt) };
  ledger = { ...ledger, lastWitness: { generationId: proof.encounter.generationId,
    observedAt: observation.observedAt, observationHash: observation.observationHash } };
  if (!existing) {
    const candidate = semanticEvent({ kind: 'candidate', encounter: { ...proof.encounter }, stopId: proof.stopId,
      service: proof.service, availableAt, evidenceChainHash: proof.evidenceChainHash,
      arrival: witness, confirmation: null, reason: null });
    return { ledger: { ...ledger, records: { ...ledger.records, [key]: candidate } }, events: [...events, candidate] };
  }
  const arrival = existing.arrival;
  if (!arrival || observation.observedAt - arrival.evidence.observedAt < protocol.minimumDistinctWitnessSeparationMs)
    return { ledger, events };
  const confirmed = semanticEvent({ kind: 'confirmed', encounter: { ...proof.encounter }, stopId: proof.stopId,
    service: proof.service, availableAt: Math.max(availableAt, arrival.availableAt, witness.availableAt),
    evidenceChainHash: proof.evidenceChainHash, arrival, confirmation: witness, reason: null });
  return { ledger: { ...ledger, records: { ...ledger.records, [key]: confirmed } }, events: [...events, confirmed] };
}
