import { canonicalJSON, deepFreeze } from './canonical.js';
import { distanceMeters } from './catalog.js';
import { advanceEncounters, emptyEncounterLedger, invalidateEncounters } from './encounters.js';
import type { EncounterLedger, EncounterLedgerEvent } from './encounters.js';
import { advanceEnrollments, bindOpportunity, emptyEnrollmentLedger, expireEnrollments } from './enrollment.js';
import type { EnrollmentLedger, EnrollmentRecord, ForecastOpportunity, OpportunityUpdate } from './enrollment.js';
import { advanceProgress, invalidateProgress, queryCurrentEncounter, queryNextEncounter, refreshProgressReceipt } from './progress.js';
import { assertProtocol, DEFAULT_PROTOCOL, PROTOCOL_SHA256 } from './protocol.js';
import type { Protocol } from './protocol.js';
import { assertStrippedPacket, emptyIngressState, ingestRawPacket, isLivePacket, vehicleKey } from './raw-ingress.js';
import type { IngressState, ObservationDisposition, RawPacket } from './raw-ingress.js';
import type { CompiledCatalog, NextEncounter, PhaseReason, ProgressResult, ProgressState, RawObservation, VehicleKey } from './types.js';

export interface SourceQualification {
  qualificationHash: string;
  sourceInventoryHash: string;
  protocolHash: string;
  catalogHashes: Readonly<Record<number, string>>;
  createdAt: number;
  completedAt: number;
}
export interface EngineOptions {
  namespaceId: string;
  catalogs: readonly CompiledCatalog[];
  fixtureMode: boolean;
  prospectiveCutoff: number | null;
  qualification?: SourceQualification;
  protocol?: Readonly<Protocol>;
}
interface VehicleState {
  identity: VehicleKey;
  progress: ProgressState | null;
  encounters: EncounterLedger;
  lastObservation: RawObservation | null;
}
export interface ScopedEncounterEvent { vehicle: string; event: EncounterLedgerEvent }
export interface EngineDiagnostic { vehicle: string | null; reason: string; availableAt: number }
export interface EngineUpdate {
  encounterEvents: ScopedEncounterEvent[];
  outcomes: EnrollmentRecord[];
  dispositions: readonly ObservationDisposition[];
  diagnostics: EngineDiagnostic[];
}
export interface EngineSnapshot {
  namespaceId: string;
  fixtureMode: boolean;
  prospectiveCutoff: number | null;
  protocolHash: string;
  availableAt: number;
  ingress: IngressState;
  vehicles: Record<string, VehicleState>;
  enrollments: EnrollmentLedger;
}
const integerClock = (value: number) => Number.isSafeInteger(value) && value >= 0;
const hash = (value: string) => /^[a-f0-9]{64}$/.test(value);

/** Serial independent raw outcome engine. Forecasts are a separate enrollment
 * input, never an input to raw progress or global curb-event generation. This
 * class has no network, process, model, fitting or publication capability. */
export class EncounterEngine {
  private readonly options: Readonly<EngineOptions>;
  private readonly protocol: Readonly<Protocol>;
  private readonly catalogs = new Map<number, CompiledCatalog>();
  private ingress: IngressState = emptyIngressState();
  private vehicles: Record<string, VehicleState> = {};
  private enrollments: EnrollmentLedger = emptyEnrollmentLedger();
  private availableAt = 0;
  private currentPacket: RawPacket | null = null;

  constructor(options: EngineOptions) {
    this.protocol = options.protocol ?? DEFAULT_PROTOCOL; assertProtocol(this.protocol);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(options.namespaceId)) throw new Error('Invalid independent namespace ID');
    if (options.namespaceId.startsWith('cycle-')) throw new Error('Existing trial IDs are forbidden');
    if (options.fixtureMode) {
      if (options.prospectiveCutoff !== null) throw new Error('Fixture namespace cannot declare prospective support');
    } else {
      const q = options.qualification, cutoff = options.prospectiveCutoff;
      if (!q || cutoff === null || !integerClock(cutoff) || !integerClock(q.createdAt) || !integerClock(q.completedAt)
        || q.createdAt > q.completedAt || q.completedAt > cutoff || !hash(q.qualificationHash)
        || !hash(q.sourceInventoryHash) || q.protocolHash !== PROTOCOL_SHA256)
        throw new Error('Prospective namespace needs prior independent source/protocol qualification');
    }
    for (const catalog of options.catalogs) {
      if (this.catalogs.has(catalog.routeId) || !hash(catalog.catalogHash)) throw new Error('Duplicate or malformed catalog');
      if (!options.fixtureMode && options.qualification!.catalogHashes[catalog.routeId] !== catalog.catalogHash)
        throw new Error('Catalog is not covered by this independent qualification');
      this.catalogs.set(catalog.routeId, deepFreeze(structuredClone(catalog)));
    }
    this.options = deepFreeze(structuredClone({ ...options, protocol: this.protocol }));
  }

  private clock(at: number): void {
    if (!integerClock(at) || at < this.availableAt) throw new Error('Regressing independent consumer clock');
    this.availableAt = at;
  }
  private expire(at: number): EnrollmentRecord[] {
    const update = expireEnrollments(this.enrollments, at, this.protocol);
    this.enrollments = update.ledger; return update.events;
  }
  private acceptEvents(events: readonly EncounterLedgerEvent[], at: number): EnrollmentRecord[] {
    const update = advanceEnrollments(this.enrollments, events, at, this.protocol);
    this.enrollments = update.ledger; return update.events;
  }
  private invalidate(key: string, reason: PhaseReason, at: number): ScopedEncounterEvent[] {
    const vehicle = this.vehicles[key]; if (!vehicle) return [];
    const update = invalidateEncounters(vehicle.encounters, reason, at, this.protocol);
    vehicle.encounters = update.ledger;
    vehicle.progress = invalidateProgress(vehicle.progress, reason, at).state;
    vehicle.lastObservation = null;
    return update.events.map(event => ({ vehicle: key, event }));
  }

  ingest(packet: RawPacket): EngineUpdate {
    assertStrippedPacket(packet, this.protocol);
    this.clock(packet.availableAt);
    const outcomes = this.expire(packet.availableAt), encounterEvents: ScopedEncounterEvent[] = [];
    const diagnostics: EngineDiagnostic[] = [];
    const ingress = ingestRawPacket(this.ingress, packet, this.protocol); this.ingress = ingress.state;
    this.currentPacket = structuredClone(packet);
    for (const boundary of ingress.boundaries) {
      const keys = boundary.vehicle === null ? Object.keys(this.vehicles) : [boundary.vehicle];
      for (const key of keys) {
        const events = this.invalidate(key, boundary.reason, packet.availableAt);
        encounterEvents.push(...events);
        outcomes.push(...this.acceptEvents(events.map(value => value.event), packet.availableAt));
      }
      diagnostics.push({ vehicle: boundary.vehicle, reason: boundary.reason, availableAt: packet.availableAt });
    }
    // Raw phase and passage happen before any curb witness or forecast. Every
    // catalog call is tracked even if nobody enrolled a forecast for that stop.
    for (const observation of ingress.canonicalObservations) {
      const key = vehicleKey(observation), identity = { routeId: observation.routeId, busId: observation.busId, busName: observation.busName };
      const vehicle = this.vehicles[key] ??= { identity, progress: null,
        encounters: { ...emptyEncounterLedger(), vehicle: identity }, lastObservation: null };
      const catalog = this.catalogs.get(observation.routeId);
      if (!catalog) { diagnostics.push({ vehicle: key, reason: 'catalog-unavailable', availableAt: packet.availableAt }); continue; }
      const progress = advanceProgress(vehicle.progress, observation, catalog, this.protocol);
      vehicle.progress = progress.state;
      if (progress.state?.lastObservationHash === observation.observationHash) vehicle.lastObservation = observation;
      const update = advanceEncounters(vehicle.encounters, null, progress, catalog, this.protocol);
      vehicle.encounters = update.ledger;
      encounterEvents.push(...update.events.map(event => ({ vehicle: key, event })));
      outcomes.push(...this.acceptEvents(update.events, packet.availableAt));
    }
    // Identical raw copies are not new GPS fixes or curb witnesses. They still
    // prove actual receipt continuity for the SAME latest canonical fix.
    for (const observation of packet.observations) {
      const vehicle = this.vehicles[vehicleKey(observation)], state = vehicle?.progress;
      if (!vehicle || !state || state.lastEvidence.receiptHash === observation.evidence.receiptHash) continue;
      const refreshed = refreshProgressReceipt(state, observation, this.protocol);
      if (refreshed !== state) { vehicle.progress = refreshed; vehicle.lastObservation = observation; }
    }
    for (const observation of ingress.liveWitnesses) {
      const key = vehicleKey(observation), vehicle = this.vehicles[key], catalog = this.catalogs.get(observation.routeId);
      if (!vehicle?.progress || !catalog) continue;
      // Pre-cutoff history can initialize raw phase, never prospective outcomes.
      if (this.options.prospectiveCutoff !== null && (observation.observedAt < this.options.prospectiveCutoff
        || observation.evidence.originalReceivedAt < this.options.prospectiveCutoff)) continue;
      const progress: ProgressResult = { state: vehicle.progress,
        status: vehicle.progress.generation ? 'seeded' : 'unseeded', events: [], availableAt: packet.availableAt };
      const update = advanceEncounters(vehicle.encounters, observation, progress, catalog, this.protocol);
      vehicle.encounters = update.ledger;
      encounterEvents.push(...update.events.map(event => ({ vehicle: key, event })));
      outcomes.push(...this.acceptEvents(update.events, packet.availableAt));
    }
    return { encounterEvents, outcomes, dispositions: ingress.dispositions, diagnostics };
  }

  enroll(opportunity: ForecastOpportunity, actualBoundAt?: number): OpportunityUpdate {
    if (!this.options.fixtureMode && actualBoundAt === undefined) throw new Error('Actual durable bind availability is required');
    const at = actualBoundAt ?? Math.max(this.availableAt, opportunity.availableAt);
    this.clock(at);
    const key = vehicleKey(opportunity.vehicle), vehicle = this.vehicles[key], catalog = this.catalogs.get(opportunity.vehicle.routeId);
    const proof: NextEncounter = catalog && vehicle
      ? queryNextEncounter(vehicle.progress, catalog, opportunity.stopId, this.protocol)
      : { kind: 'unknown', reason: 'unmapped-call', possible: [], availableAt: this.ingress.lastAvailableAt ?? 0 };
    let refusal: string | null = null;
    if (this.options.prospectiveCutoff !== null && opportunity.forecastAt < this.options.prospectiveCutoff)
      refusal = 'before-prospective-cutoff';
    else if ((this.ingress.lastAvailableAt ?? 0) > opportunity.forecastAt) refusal = 'raw-prefix-newer-than-forecast';
    else if (this.ingress.lastAvailableAt === null
      || at - this.ingress.lastAvailableAt > this.protocol.maxActualReceiptGapMs) refusal = 'actual-receipt-gap-before-binding';
    else if (!this.currentPacket || !isLivePacket(this.currentPacket)) refusal = 'current-live-receipt-unavailable';
    else if (opportunity.receiptHash !== this.currentPacket.receiptHash) refusal = 'forecast-source-receipt-mismatch';
    else if (!vehicle?.lastObservation || opportunity.forecastAt - vehicle.lastObservation.observedAt
      > this.protocol.maxAbsLiveObservedReceiptSkewMs || at - vehicle.lastObservation.observedAt
      > this.protocol.maxAbsLiveObservedReceiptSkewMs || vehicle.lastObservation.observedAt > opportunity.forecastAt)
      refusal = 'fresh-current-observation-unavailable';
    // Historical raw curb evidence is not a positive live proxy, but cannot be
    // ignored to enroll a new promise after the bus was already seen there.
    const raw = vehicle?.lastObservation;
    if (!refusal && raw && catalog && raw.stationary && raw.atStopId === opportunity.stopId) {
      const current = queryCurrentEncounter(vehicle.progress, catalog, opportunity.stopId, this.protocol);
      const call = current.kind === 'current' ? catalog.calls.find(value => value.id === current.encounter.occurrenceId) : undefined;
      if (call && distanceMeters(raw, call.coord) <= this.protocol.curbProxyRadiusM)
        refusal = 'curb-evidence-already-known';
    }
    const update = bindOpportunity(this.enrollments, opportunity, proof,
      vehicle?.encounters ?? emptyEncounterLedger(), at, this.protocol, refusal);
    this.enrollments = update.ledger; return update;
  }

  /** An absent input cannot keep a promise alive indefinitely. Expiry happens
   * first, even when no intermediate timer call was made before a late input. */
  tickDetailed(availableAt: number): EngineUpdate {
    this.clock(availableAt); const outcomes = this.expire(availableAt);
    const encounterEvents: ScopedEncounterEvent[] = [], diagnostics: EngineDiagnostic[] = [];
    for (const [key, vehicle] of Object.entries(this.vehicles)) {
      const last = vehicle.progress;
      if (!last) continue;
      const reason = this.ingress.lastAvailableAt !== null
        && availableAt - this.ingress.lastAvailableAt > this.protocol.maxActualReceiptGapMs ? 'receipt-gap'
        : availableAt - last.lastObservedAt > this.protocol.maxDistinctObservationGapMs ? 'observation-gap' : null;
      if (reason) {
        const events = this.invalidate(key, reason, availableAt); encounterEvents.push(...events);
        outcomes.push(...this.acceptEvents(events.map(value => value.event), availableAt));
        diagnostics.push({ vehicle: key, reason, availableAt });
      }
    }
    return { encounterEvents, outcomes, dispositions: [], diagnostics };
  }
  tick(availableAt: number): EnrollmentRecord[] {
    return this.tickDetailed(availableAt).outcomes;
  }

  /** An independently observed transport/input failure closes this continuity
   * without inventing a fleet, position or curb event. A durable runner then
   * seals the refused namespace instead of continuing its old promises. */
  refuseInput(availableAt: number, reason: PhaseReason = 'source-gap'): EngineUpdate {
    this.clock(availableAt); const outcomes = this.expire(availableAt);
    const encounterEvents: ScopedEncounterEvent[] = [];
    for (const key of Object.keys(this.vehicles)) {
      const events = this.invalidate(key, reason, availableAt); encounterEvents.push(...events);
      outcomes.push(...this.acceptEvents(events.map(value => value.event), availableAt));
    }
    this.currentPacket = null;
    return { encounterEvents, outcomes, dispositions: [], diagnostics: [{ vehicle: null, reason, availableAt }] };
  }

  snapshot(): EngineSnapshot {
    return structuredClone({ namespaceId: this.options.namespaceId, fixtureMode: this.options.fixtureMode,
      prospectiveCutoff: this.options.prospectiveCutoff, protocolHash: PROTOCOL_SHA256, availableAt: this.availableAt,
      ingress: this.ingress, vehicles: this.vehicles, enrollments: this.enrollments });
  }
  /** No model-dependent fields are needed to reconcile outcome identity. */
  canonicalOutcomeState(): string {
    return canonicalJSON({ ingress: this.ingress, vehicles: this.vehicles });
  }
}
