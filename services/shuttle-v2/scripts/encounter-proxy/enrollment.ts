import { canonicalJSON, sha256 } from './canonical.js';
import { encounterKey, firstCurbKnown } from './encounters.js';
import type { EncounterLedger, EncounterLedgerEvent } from './encounters.js';
import { assertProtocol, DEFAULT_PROTOCOL } from './protocol.js';
import type { Protocol } from './protocol.js';
import type { EncounterRef, NextEncounter, VehicleKey } from './types.js';

export type Horizon = '0-2' | '2-5' | '5-10' | '10-30';
/** Forecast values stay outside the outcome matcher; only the sampling stratum enters. */
export interface ForecastOpportunity {
  id: string;
  vehicle: VehicleKey;
  stopId: number;
  horizon: Horizon;
  /** Actual evaluated-forecast consumer availability, never model generation. */
  forecastAt: number;
  availableAt: number;
  /** Stripped semantic input receipt, not the predictor-containing packet SHA. */
  receiptHash: string;
}
export interface EnrollmentRecord {
  id: string;
  opportunity: ForecastOpportunity;
  opportunityHash: string;
  encounter: EncounterRef | null;
  samplingIdentity: string | null;
  duplicateOf: string | null;
  /** Protocol enrollment clock is forecast creation, not delayed binding. */
  enrolledAt: number;
  boundAt: number;
  logicalCutoffAt: number;
  status: 'open' | 'matched' | 'missing';
  reason: string | null;
  arrivedAt: number | null;
  det: number | null;
  availableAt: number;
  outcomeEventId: string | null;
}
export interface EnrollmentLedger {
  v: 1;
  records: Readonly<Record<string, EnrollmentRecord>>;
  identities: Readonly<Record<string, string>>;
  lastAvailableAt: number;
}
export interface EnrollmentUpdate { ledger: EnrollmentLedger; events: EnrollmentRecord[] }
export interface OpportunityUpdate extends EnrollmentUpdate { enrollment: EnrollmentRecord }

export function emptyEnrollmentLedger(): EnrollmentLedger {
  return { v: 1, records: {}, identities: {}, lastAvailableAt: 0 };
}
const sameVehicle = (a: VehicleKey, b: VehicleKey): boolean => a.routeId === b.routeId && a.busId === b.busId && a.busName === b.busName;
function clock(previous: EnrollmentLedger, availableAt: number): void {
  if (!Number.isSafeInteger(availableAt) || availableAt < previous.lastAvailableAt)
    throw new Error('Regressing enrollment availability clock');
}
/** Settlement precedes every bind/event/tick, including a late confirming event. */
export function expireEnrollments(previous: EnrollmentLedger, availableAt: number,
  protocol: Readonly<Protocol> = DEFAULT_PROTOCOL): EnrollmentUpdate {
  assertProtocol(protocol); clock(previous, availableAt);
  const records = { ...previous.records }, events: EnrollmentRecord[] = [];
  for (const [id, record] of Object.entries(records)) {
    if (record.status !== 'open' || availableAt <= record.logicalCutoffAt) continue;
    const terminal: EnrollmentRecord = { ...record, status: 'missing', reason: 'settlement-deadline', availableAt };
    records[id] = terminal; events.push(terminal);
  }
  return { ledger: { ...previous, records, lastAvailableAt: availableAt }, events };
}

/** Every opportunity is retained, including unknown phase and duplicate strata. */
export function bindOpportunity(previous: EnrollmentLedger, opportunity: ForecastOpportunity, next: NextEncounter,
  encounters: EncounterLedger, availableAt: number, protocol: Readonly<Protocol> = DEFAULT_PROTOCOL,
  eligibilityRefusal: string | null = null): OpportunityUpdate {
  const expired = expireEnrollments(previous, availableAt, protocol), ledger = expired.ledger;
  if (!opportunity.id || !Number.isSafeInteger(opportunity.forecastAt) || opportunity.forecastAt < 0
    || !Number.isSafeInteger(opportunity.availableAt) || opportunity.availableAt < 0
    || opportunity.availableAt > availableAt || !['0-2', '2-5', '5-10', '10-30'].includes(opportunity.horizon)
    || !Number.isSafeInteger(opportunity.stopId) || !Number.isSafeInteger(opportunity.vehicle.routeId)
    || !Number.isSafeInteger(opportunity.vehicle.busId) || !opportunity.vehicle.busName
    || !/^[a-f0-9]{64}$/.test(opportunity.receiptHash)) throw new Error('Malformed forecast opportunity');
  const opportunityHash = sha256(canonicalJSON(opportunity)), existing = ledger.records[opportunity.id];
  if (existing) {
    if (existing.opportunityHash !== opportunityHash) throw new Error('Conflicting forecast opportunity identity');
    return { ...expired, enrollment: existing };
  }
  const base: EnrollmentRecord = { id: opportunity.id,
    opportunity: { ...opportunity, vehicle: { ...opportunity.vehicle } }, opportunityHash,
    encounter: null, samplingIdentity: null, duplicateOf: null, enrolledAt: opportunity.forecastAt, boundAt: availableAt,
    logicalCutoffAt: opportunity.forecastAt + protocol.settlementWindowMs,
    status: 'missing', reason: null, arrivedAt: null, det: null, availableAt, outcomeEventId: null };
  let record: EnrollmentRecord = base;
  if (!Number.isSafeInteger(base.logicalCutoffAt)) throw new Error('Invalid settlement deadline');
  if (availableAt > base.logicalCutoffAt) record = { ...base, reason: 'settlement-deadline' };
  else if (opportunity.availableAt !== opportunity.forecastAt)
    record = { ...base, reason: 'forecast-clock-not-actual-availability' };
  else if (eligibilityRefusal !== null) {
    if (typeof eligibilityRefusal !== 'string' || !eligibilityRefusal.trim()) throw new Error('Invalid opportunity eligibility refusal');
    record = { ...base, reason: eligibilityRefusal };
  }
  else if (!Number.isSafeInteger(next.availableAt) || next.availableAt > opportunity.forecastAt)
    record = { ...base, reason: 'phase-not-available-at-forecast' };
  else if (encounters.lastAvailableAt > opportunity.forecastAt)
    record = { ...base, reason: 'raw-prefix-newer-than-forecast' };
  else if (next.kind === 'unknown') record = { ...base, reason: `phase-unknown:${next.reason}` };
  else if (next.stopId !== opportunity.stopId || (encounters.vehicle && !sameVehicle(encounters.vehicle, opportunity.vehicle)))
    record = { ...base, reason: 'target-or-vehicle-mismatch' };
  else if (firstCurbKnown(encounters, next.encounter)) record = { ...base, reason: 'curb-evidence-already-known' };
  else {
    const known = encounters.records[encounterKey(next.encounter)];
    if (known && known.kind !== 'candidate') record = { ...base, reason: 'encounter-already-terminal' };
    else {
      const samplingIdentity = canonicalJSON([opportunity.vehicle, next.encounter, opportunity.horizon]);
      const duplicateOf = ledger.identities[samplingIdentity] ?? null;
      record = { ...base, encounter: { ...next.encounter }, samplingIdentity,
        status: duplicateOf ? 'missing' : 'open', reason: duplicateOf ? 'duplicate-encounter-horizon' : null, duplicateOf };
    }
  }
  const identities = { ...ledger.identities };
  if (record.samplingIdentity !== null && record.duplicateOf === null) identities[record.samplingIdentity] = record.id;
  return { ledger: { ...ledger, records: { ...ledger.records, [record.id]: record }, identities },
    events: [...expired.events, record], enrollment: record };
}

/** Only immutable events for the originally bound encounter can resolve a promise. */
export function advanceEnrollments(previous: EnrollmentLedger, encounterEvents: readonly EncounterLedgerEvent[],
  availableAt: number, protocol: Readonly<Protocol> = DEFAULT_PROTOCOL): EnrollmentUpdate {
  const expired = expireEnrollments(previous, availableAt, protocol);
  const records = { ...expired.ledger.records }, events = [...expired.events];
  for (const event of encounterEvents) {
    if (event.availableAt > availableAt) throw new Error('Outcome event is not yet available');
    for (const [id, record] of Object.entries(records)) {
      if (record.status !== 'open' || !record.encounter) continue;
      if (event.kind === 'continuity-censored') {
        if (event.vehicle && !sameVehicle(event.vehicle, record.opportunity.vehicle)) continue;
        if (event.generationId !== null && event.generationId !== record.encounter.generationId) continue;
      } else {
        if (event.kind === 'candidate' || encounterKey(event.encounter) !== encounterKey(record.encounter)) continue;
      }
      let terminal: EnrollmentRecord = { ...record, status: 'missing', reason: event.kind === 'continuity-censored'
        ? event.reason : event.reason ?? event.kind, availableAt, outcomeEventId: event.eventId };
      if (event.kind === 'confirmed') {
        const arrival = event.arrival, confirmation = event.confirmation;
        const wait = arrival ? arrival.evidence.observedAt - record.opportunity.forecastAt : -1;
        const valid = arrival !== null && confirmation !== null
          && arrival.evidence.observedAt !== confirmation.evidence.observedAt
          && confirmation.evidence.observedAt - arrival.evidence.observedAt >= protocol.minimumDistinctWitnessSeparationMs
          && arrival.evidence.originalReceivedAt >= record.enrolledAt
          && arrival.availableAt >= record.enrolledAt && confirmation.availableAt <= availableAt
          && wait >= 0 && wait <= protocol.matchWindowMs;
        terminal = valid ? { ...terminal, status: 'matched', reason: null,
          arrivedAt: arrival.evidence.observedAt, det: wait / 1000 }
          : { ...terminal, reason: 'outside-match-window-or-nonprospective-evidence' };
      }
      records[id] = terminal; events.push(terminal);
    }
  }
  return { ledger: { ...expired.ledger, records }, events };
}
