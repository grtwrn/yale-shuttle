import { describe, expect, it } from 'vitest';
import { sha256 } from './canonical.js';
import { emptyEncounterLedger, encounterKey } from './encounters.js';
import type { CurbWitness, EncounterEvent, EncounterLedger, EncounterLedgerEvent } from './encounters.js';
import { advanceEnrollments, bindOpportunity, emptyEnrollmentLedger, expireEnrollments } from './enrollment.js';
import type { ForecastOpportunity, Horizon } from './enrollment.js';
import { DEFAULT_PROTOCOL } from './protocol.js';
import type { EncounterRef, NextEncounter } from './types.js';

const at = 1_800_000_000_000;
const vehicle = { routeId: 8, busId: 68430, busName: '#326' };
const encounter: EncounterRef = { generationId: sha256('raw phase generation'), occurrenceId: 'south109', ordinal: 0 };
const proof = (availableAt = at): NextEncounter => ({ kind: 'bound', encounter, stopId: 109,
  service: 'published-qualified', availableAt, evidenceChainHash: sha256('raw next-encounter proof') });
const opportunity = (id = 'forecast-1', horizon: Horizon = '5-10'): ForecastOpportunity => ({ id, vehicle,
  stopId: 109, horizon, forecastAt: at, availableAt: at, receiptHash: sha256('stripped forecast-input receipt') });
function ledgerPrefix(availableAt = at): EncounterLedger {
  return { ...emptyEncounterLedger(), vehicle, generationId: encounter.generationId, lastAvailableAt: availableAt };
}
function witness(observedAt: number): CurbWitness {
  return { phaseEvidenceChainHash: sha256(`current-service-${observedAt}`), availableAt: observedAt + 1000,
    evidence: { receiptHash: sha256(`live-stripped-receipt-${observedAt}`), observationHash: sha256(`raw-fix-${observedAt}`),
      observedAt, originalReceivedAt: observedAt + 1000, availableAt: observedAt + 1000,
      origin: 'public-current', frameCount: 0, hasMore: false, cursor: 1, latest: 1 } };
}
function confirmed(firstObservedAt = at + 600000, ref = encounter): EncounterEvent {
  const arrival = witness(firstObservedAt), confirmation = witness(firstObservedAt + 9000);
  return { kind: 'confirmed', eventId: sha256(`global-positive-${firstObservedAt}-${ref.occurrenceId}-${ref.ordinal}`),
    encounter: ref, stopId: 109, service: 'published-qualified', availableAt: confirmation.availableAt,
    evidenceChainHash: confirmation.phaseEvidenceChainHash, arrival, confirmation, reason: null };
}
function candidate(): EncounterEvent {
  const arrival = witness(at);
  return { kind: 'candidate', eventId: sha256('global-first-curb'), encounter, stopId: 109, service: 'published-qualified',
    availableAt: arrival.availableAt, evidenceChainHash: arrival.phaseEvidenceChainHash, arrival, confirmation: null, reason: null };
}

describe('prospective immutable encounter enrollment', () => {
  it('shares one global outcome across reference horizons while retaining duplicate opportunities', () => {
    const first = bindOpportunity(emptyEnrollmentLedger(), opportunity('h5'), proof(), ledgerPrefix(), at);
    const second = bindOpportunity(first.ledger, opportunity('h2', '2-5'), proof(), ledgerPrefix(), at);
    const duplicate = bindOpportunity(second.ledger, opportunity('duplicate-h5'), proof(), ledgerPrefix(), at);
    expect(duplicate.enrollment).toMatchObject({ status: 'missing', reason: 'duplicate-encounter-horizon', duplicateOf: 'h5' });
    expect(Object.keys(duplicate.ledger.records)).toHaveLength(3);
    const event = confirmed(), done = advanceEnrollments(duplicate.ledger, [event], event.availableAt);
    expect(done.ledger.records.h5).toMatchObject({ status: 'matched', det: 600, outcomeEventId: event.eventId });
    expect(done.ledger.records.h2).toMatchObject({ status: 'matched', det: 600, outcomeEventId: event.eventId });
    expect(done.ledger.records['duplicate-h5']!.status).toBe('missing');
  });

  it('retains an unknown start permanently instead of binding it when later phase becomes known', () => {
    const unknown: NextEncounter = { kind: 'unknown', reason: 'unseeded', possible: [], availableAt: at };
    const first = bindOpportunity(emptyEnrollmentLedger(), opportunity(), unknown, ledgerPrefix(), at);
    expect(first.enrollment).toMatchObject({ status: 'missing', encounter: null, reason: 'phase-unknown:unseeded', det: null });
    const retry = bindOpportunity(first.ledger, opportunity(), proof(), ledgerPrefix(), at + 1000);
    expect(retry.enrollment).toEqual(first.enrollment);
    expect(retry.events).toEqual([]);
    expect(advanceEnrollments(retry.ledger, [confirmed()], at + 610000).ledger.records['forecast-1']).toEqual(first.enrollment);
  });

  it('retains a before-cutoff opportunity forever while allowing a genuinely new post-cutoff forecast', () => {
    const refused = bindOpportunity(emptyEnrollmentLedger(), opportunity(), proof(), ledgerPrefix(), at,
      DEFAULT_PROTOCOL, 'before-prospective-cutoff');
    expect(refused.enrollment).toMatchObject({ status: 'missing', samplingIdentity: null, encounter: null,
      reason: 'before-prospective-cutoff' });
    const retry = bindOpportunity(refused.ledger, opportunity(), proof(), ledgerPrefix(), at + 2000);
    expect(retry.enrollment).toEqual(refused.enrollment);
    expect(retry.events).toEqual([]);
    const fresh = { ...opportunity('post-cutoff'), forecastAt: at + 2000, availableAt: at + 2000 };
    const allowed = bindOpportunity(retry.ledger, fresh, proof(), ledgerPrefix(), at + 2000);
    expect(allowed.enrollment.status).toBe('open');
    expect(Object.keys(allowed.ledger.records)).toHaveLength(2);
    const late = bindOpportunity(emptyEnrollmentLedger(), opportunity(), proof(), ledgerPrefix(), at + 2820001,
      DEFAULT_PROTOCOL, 'before-prospective-cutoff');
    expect(late.enrollment.reason).toBe('settlement-deadline');
  });

  it('rejects later proof or a later raw prefix for an earlier forecast, without resetting its clock', () => {
    const laterPhase = bindOpportunity(emptyEnrollmentLedger(), opportunity(), proof(at + 1), ledgerPrefix(), at + 1000);
    expect(laterPhase.enrollment).toMatchObject({ status: 'missing', reason: 'phase-not-available-at-forecast' });
    const laterRaw = bindOpportunity(emptyEnrollmentLedger(), opportunity(), proof(), ledgerPrefix(at + 1), at + 1000);
    expect(laterRaw.enrollment).toMatchObject({ status: 'missing', reason: 'raw-prefix-newer-than-forecast' });
    const delayed = bindOpportunity(emptyEnrollmentLedger(), opportunity(), proof(), ledgerPrefix(), at + 60000);
    expect(delayed.enrollment).toMatchObject({ status: 'open', enrolledAt: at, boundAt: at + 60000,
      logicalCutoffAt: at + 2820000 });
    const alreadyLate = bindOpportunity(emptyEnrollmentLedger(), opportunity(), proof(), ledgerPrefix(), at + 2820001);
    expect(alreadyLate.enrollment).toMatchObject({ status: 'missing', reason: 'settlement-deadline', enrolledAt: at,
      boundAt: at + 2820001, logicalCutoffAt: at + 2820000 });
  });

  it('never scores a curb reached before the forecast was first visible using an earlier model-generation clock', () => {
    // Generated at0, first available at10s; physical GPS proxy first observed
    // at5s but not received until12s. Using generation0 would invent a5s
    // forecast success even though the evaluated forecast was not yet visible.
    const generatedThenVisible = { ...opportunity(), forecastAt: at, availableAt: at + 10000 };
    const bound = bindOpportunity(emptyEnrollmentLedger(), generatedThenVisible, proof(), ledgerPrefix(), at + 10000);
    expect(bound.enrollment).toMatchObject({ status: 'missing', encounter: null, det: null,
      reason: 'forecast-clock-not-actual-availability' });
    const event = confirmed(at + 5000);
    event.arrival = { ...event.arrival!, availableAt: at + 12000, evidence: { ...event.arrival!.evidence,
      originalReceivedAt: at + 12000, availableAt: at + 12000 } };
    const afterArrival = advanceEnrollments(bound.ledger, [event], event.availableAt);
    expect(afterArrival.ledger.records['forecast-1']).toEqual(bound.enrollment);
    expect(afterArrival.events).toEqual([]);
    const retry = bindOpportunity(afterArrival.ledger, generatedThenVisible, proof(), ledgerPrefix(), at + 16000);
    expect(retry.enrollment).toEqual(bound.enrollment);
    expect(() => bindOpportunity(retry.ledger, { ...generatedThenVisible, forecastAt: at + 10000 },
      proof(), ledgerPrefix(), at + 16000)).toThrow('Conflicting forecast opportunity');
    const reversed = bindOpportunity(emptyEnrollmentLedger(), { ...opportunity(), forecastAt: at + 1 },
      proof(), ledgerPrefix(), at);
    expect(reversed.enrollment.reason).toBe('forecast-clock-not-actual-availability');
  });

  it('expires before a late confirmation even when no intermediate tick occurred; exact47min remains allowed', () => {
    const bound = bindOpportunity(emptyEnrollmentLedger(), opportunity(), proof(), ledgerPrefix(), at);
    expect(expireEnrollments(bound.ledger, at + 2820000).ledger.records['forecast-1']!.status).toBe('open');
    const event = confirmed(at + 2700000);
    const exact = advanceEnrollments(bound.ledger, [event], at + 2820000);
    expect(exact.ledger.records['forecast-1']).toMatchObject({ status: 'matched', det: 2700, availableAt: at + 2820000 });
    const late = advanceEnrollments(bound.ledger, [event], at + 2820001);
    expect(late.ledger.records['forecast-1']).toMatchObject({ status: 'missing', reason: 'settlement-deadline',
      availableAt: at + 2820001, logicalCutoffAt: at + 2820000, det: null });
    expect(late.events).toHaveLength(1);
  });

  it('keeps the inclusive45min first-observation match limit independent of confirmation availability', () => {
    const bound = bindOpportunity(emptyEnrollmentLedger(), opportunity(), proof(), ledgerPrefix(), at);
    const exact = confirmed(at + 2700000);
    expect(advanceEnrollments(bound.ledger, [exact], exact.availableAt).ledger.records['forecast-1']!.det).toBe(2700);
    const outside = confirmed(at + 2700001);
    expect(advanceEnrollments(bound.ledger, [outside], outside.availableAt).ledger.records['forecast-1']).toMatchObject({
      status: 'missing', reason: 'outside-match-window-or-nonprospective-evidence', det: null });
  });

  it('does not enroll a promise after the first curb witness, even before confirmation', () => {
    const event = candidate();
    const alreadyKnown = { ...ledgerPrefix(at + 1000), records: { [encounterKey(encounter)]: event } };
    const laterForecast = { ...opportunity(), forecastAt: at + 1000, availableAt: at + 1000 };
    const bound = bindOpportunity(emptyEnrollmentLedger(), laterForecast, proof(), alreadyKnown, at + 1000);
    expect(bound.enrollment).toMatchObject({ status: 'missing', reason: 'curb-evidence-already-known', encounter: null });
  });

  it('cannot let a North counterpass or later South lap rescue a missed South encounter', () => {
    const bound = bindOpportunity(emptyEnrollmentLedger(), opportunity(), proof(), ledgerPrefix(), at);
    const other = confirmed(at + 700000, { ...encounter, occurrenceId: 'north109', ordinal: 0 });
    const north = advanceEnrollments(bound.ledger, [other], other.availableAt);
    expect(north.ledger.records['forecast-1']!.status).toBe('open');
    const passed: EncounterEvent = { ...confirmed(at + 800000), kind: 'passed-unconfirmed', eventId: sha256('passed South109'),
      arrival: null, confirmation: null, reason: 'passed-without-confirmed-proxy' };
    const missed = advanceEnrollments(north.ledger, [passed], passed.availableAt);
    expect(missed.ledger.records['forecast-1']).toMatchObject({ status: 'missing', det: null });
    const future = confirmed(at + 900000, { ...encounter, ordinal: 1 });
    const later = advanceEnrollments(missed.ledger, [future, confirmed(at + 900000)], future.availableAt);
    expect(later.ledger.records['forecast-1']).toEqual(missed.ledger.records['forecast-1']);
    expect(later.events).toEqual([]);
  });

  it('censors pending targets without a curb candidate and keeps all unknown opportunities', () => {
    const bound = bindOpportunity(emptyEnrollmentLedger(), opportunity(), proof(), ledgerPrefix(), at);
    const unknown: NextEncounter = { kind: 'unknown', reason: 'unknown-service', possible: [], availableAt: at };
    const pending = bindOpportunity(bound.ledger, opportunity('unknown-SPUR', '2-5'), unknown, ledgerPrefix(), at);
    const boundary: EncounterLedgerEvent = { kind: 'continuity-censored', eventId: sha256('source gap'),
      generationId: encounter.generationId, vehicle, reason: 'receipt-gap', availableAt: at + 30001 };
    const done = advanceEnrollments(pending.ledger, [boundary], boundary.availableAt);
    expect(Object.values(done.ledger.records)).toHaveLength(2);
    expect(done.ledger.records['forecast-1']).toMatchObject({ status: 'missing', reason: 'receipt-gap' });
    expect(done.ledger.records['unknown-SPUR']).toMatchObject({ status: 'missing', reason: 'phase-unknown:unknown-service' });
  });

  it('retries identically without extra cohort rows and refuses conflicting opportunity identities', () => {
    const first = bindOpportunity(emptyEnrollmentLedger(), opportunity(), proof(), ledgerPrefix(), at);
    const same = bindOpportunity(first.ledger, opportunity(), proof(), ledgerPrefix(), at + 1);
    expect(same.enrollment).toEqual(first.enrollment);
    expect(Object.keys(same.ledger.records)).toHaveLength(1);
    expect(() => bindOpportunity(same.ledger, { ...opportunity(), horizon: '2-5' }, proof(), ledgerPrefix(), at + 1))
      .toThrow('Conflicting forecast opportunity');
  });
});
