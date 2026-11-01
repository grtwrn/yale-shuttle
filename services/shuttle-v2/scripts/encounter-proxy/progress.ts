import { canonicalJSON, observationHash, sha256 } from './canonical.js';
import { circularComponents, compatibleIntervals, distanceMeters, isHash, isPoint, mergeIntervals } from './catalog.js';
import { assertProtocol, DEFAULT_PROTOCOL, PROTOCOL_SHA256, type Protocol } from './protocol.js';
import type {
  ArcInterval, CompiledCall, CompiledCatalog, CurrentEncounter, EncounterRef, NextEncounter,
  PassedEncounter, PhaseReason, ProgressResult, ProgressState, RawObservation,
} from './types.js';

function evidenceCore(o: RawObservation) {
  const e = o.evidence;
  return { receiptHash: e.receiptHash, observationHash: e.observationHash, observedAt: e.observedAt,
    originalReceivedAt: e.originalReceivedAt, availableAt: e.availableAt, origin: e.origin,
    frameCount: e.frameCount, hasMore: e.hasMore, cursor: e.cursor, latest: e.latest };
}

function validObservation(o: RawObservation): boolean {
  const e = o?.evidence;
  return !!o && isPoint(o) && typeof o.sourceEpoch === 'string' && o.sourceEpoch.length > 0
    && Number.isSafeInteger(o.routeId) && Number.isSafeInteger(o.busId) && typeof o.busName === 'string' && o.busName.length > 0
    && Number.isSafeInteger(o.observedAt) && typeof o.stationary === 'boolean'
    && (o.atStopId === null || Number.isSafeInteger(o.atStopId)) && isHash(o.observationHash)
    && !!e && isHash(e.receiptHash) && e.observationHash === o.observationHash && e.observedAt === o.observedAt
    && Number.isSafeInteger(e.originalReceivedAt) && Number.isSafeInteger(e.availableAt)
    && o.observedAt <= e.originalReceivedAt && e.originalReceivedAt <= e.availableAt
    && ['historical-frame', 'public-current'].includes(e.origin) && Number.isSafeInteger(e.frameCount) && e.frameCount >= 0
    && typeof e.hasMore === 'boolean' && Number.isSafeInteger(e.cursor) && Number.isSafeInteger(e.latest)
    && e.cursor >= 0 && e.latest >= e.cursor && observationHash(o) === o.observationHash;
}

/** A fresh receipt of the SAME latest canonical observation proves transport
 * continuity only. It cannot move GPS, seed another phase or spend a witness.
 * Ingress owns censoring rejected receipts; an ineligible refresh is a no-op. */
export function refreshProgressReceipt(
  state: ProgressState | null, observation: RawObservation, protocol: Readonly<Protocol> = DEFAULT_PROTOCOL,
): ProgressState | null {
  assertProtocol(protocol);
  if (!state || state.protocolHash !== PROTOCOL_SHA256 || !validObservation(observation)) return state;
  const e = observation.evidence, old = state.lastEvidence;
  if (observation.sourceEpoch !== state.sourceEpoch || observation.routeId !== state.vehicle.routeId
    || observation.busId !== state.vehicle.busId || observation.busName !== state.vehicle.busName
    || observation.observedAt !== state.lastObservedAt || observation.observationHash !== state.lastObservationHash
    || e.availableAt < state.lastAvailableAt || e.originalReceivedAt < old.originalReceivedAt
    || e.cursor < old.cursor || e.cursor > old.cursor + 1
    || e.originalReceivedAt - observation.observedAt > protocol.maxAbsLiveObservedReceiptSkewMs
    || e.availableAt - observation.observedAt > protocol.maxAbsLiveObservedReceiptSkewMs) return state;
  if (e.receiptHash === old.receiptHash && e.availableAt === state.lastAvailableAt) return state;
  const evidence = evidenceCore(observation);
  return { ...state, lastAvailableAt: e.availableAt, lastEvidence: evidence, availableAt: e.availableAt,
    evidenceChainHash: sha256(canonicalJSON({ kind: 'receipt-refresh', previous: state.evidenceChainHash, evidence })) };
}

export function invalidateProgress(
  state: ProgressState | null, reason: PhaseReason, availableAt: number,
): ProgressResult {
  if (!Number.isSafeInteger(availableAt)) throw new Error('Invalid phase availability clock');
  return { state: null, status: 'invalid', availableAt, events: [{ kind: 'invalidate', reason, availableAt,
    generationId: state?.generation?.id ?? null, evidenceChainHash: state?.evidenceChainHash ?? '' }] };
}

/** Every integer-loop lift compatible with forward travel; no preferred arc. */
function reachable(
  previous: readonly ArcInterval[], current: readonly ArcInterval[], advance: number, loopM: number, cap: number,
): ArcInterval[] | null {
  let result: ArcInterval[] = [];
  for (const old of previous) for (const region of current) {
    const first = Math.ceil((old.lo - region.hi) / loopM);
    const last = Math.floor((old.hi + advance - region.lo) / loopM);
    if (last - first + 1 > cap) return null;
    for (let k = first; k <= last; k++) {
      const lo = Math.max(old.lo, region.lo + k * loopM), hi = Math.min(old.hi + advance, region.hi + k * loopM);
      if (lo <= hi) result.push({ lo, hi });
      if (result.length > cap) {
        result = mergeIntervals(result);
        if (result.length > cap) return null;
      }
    }
  }
  const merged = mergeIntervals(result);
  if (merged.some(i => Math.ceil((i.hi - i.lo) / loopM) > cap)) return null;
  return merged;
}

function moduloIntervals(intervals: readonly ArcInterval[], loopM: number): ArcInterval[] {
  const out: ArcInterval[] = [];
  for (const interval of intervals) {
    if (interval.hi - interval.lo >= loopM) return [{ lo: 0, hi: loopM }];
    const cycle = Math.floor(interval.lo / loopM), lo = interval.lo - cycle * loopM, hi = interval.hi - cycle * loopM;
    if (hi <= loopM) out.push({ lo, hi });
    else out.push({ lo, hi: loopM }, { lo: 0, hi: hi - loopM });
  }
  return mergeIntervals(out);
}

function proofReference(state: ProgressState, call: CompiledCall, cycle: number): EncounterRef {
  return { generationId: state.generation!.id, occurrenceId: call.id,
    ordinal: cycle - state.seedGateBaselines[call.id]! };
}

function finishPassages(state: ProgressState, catalog: CompiledCatalog, protocol: Readonly<Protocol>): PassedEncounter[] | null {
  const passed = { ...state.passedThrough }, events: PassedEncounter[] = [];
  if (state.availableAt - state.lastObservedAt > protocol.maxAbsLiveObservedReceiptSkewMs
    || state.lastEvidence.originalReceivedAt - state.lastObservedAt > protocol.maxAbsLiveObservedReceiptSkewMs) return events;
  const min = Math.min(...state.intervals.map(i => i.lo));
  for (const call of catalog.calls) {
    if (call.components.length !== 1) continue;
    const component = call.components[0]!, base = state.seedGateBaselines[call.id];
    if (base === undefined || distanceMeters(state.lastRawPoint, call.coord) <= protocol.departureRearmM) continue;
    // Strictly beyond the region exit; equality has not proved passage.
    const lastCycle = Math.ceil((min - component.hi) / catalog.loopM) - 1;
    const lastOrdinal = lastCycle - base, previous = passed[call.id] ?? -1;
    if (lastOrdinal - previous > protocol.maxProgressIntervals) return null;
    for (let ordinal = previous + 1; ordinal <= lastOrdinal; ordinal++) {
      events.push({ kind: 'passed', encounter: { generationId: state.generation!.id, occurrenceId: call.id, ordinal },
        service: call.service, stopId: call.stopId, availableAt: state.availableAt, evidenceChainHash: state.evidenceChainHash });
    }
    if (lastOrdinal > previous) passed[call.id] = lastOrdinal;
  }
  state.passedThrough = passed;
  return events;
}

export function advanceProgress(
  previous: ProgressState | null, observation: RawObservation, catalog: CompiledCatalog,
  protocol: Readonly<Protocol> = DEFAULT_PROTOCOL,
): ProgressResult {
  assertProtocol(protocol);
  const availableAt = observation?.evidence?.availableAt;
  if (!Number.isSafeInteger(availableAt)) throw new Error('Missing actual phase consumer clock');
  if (!validObservation(observation) || observation.routeId !== catalog.routeId)
    return invalidateProgress(previous, 'malformed-observation', availableAt);
  if (previous) {
    let reason: PhaseReason | null = null;
    if (previous.protocolHash !== PROTOCOL_SHA256) reason = 'protocol-change';
    else if (previous.catalogHash !== catalog.catalogHash) reason = 'catalog-change';
    else if (previous.sourceEpoch !== observation.sourceEpoch) reason = 'epoch-change';
    else if (previous.vehicle.routeId !== observation.routeId || previous.vehicle.busId !== observation.busId
      || previous.vehicle.busName !== observation.busName) reason = 'identity-change';
    else if (availableAt < previous.lastAvailableAt || observation.observedAt < previous.lastObservedAt) reason = 'regressing-observation';
    else if (observation.observedAt === previous.lastObservedAt && observation.observationHash !== previous.lastObservationHash) reason = 'same-clock-conflict';
    else if (availableAt - previous.lastAvailableAt > protocol.maxActualReceiptGapMs) reason = 'receipt-gap';
    else if (observation.observedAt - previous.lastObservedAt > protocol.maxDistinctObservationGapMs) reason = 'observation-gap';
    if (reason) return invalidateProgress(previous, reason, availableAt);
    // Live provenance upgrades are consumed by encounters, not another GPS
    // movement or a second witness. Ingress retains the actual new receipt.
    if (observation.observedAt === previous.lastObservedAt) {
      const state = refreshProgressReceipt(previous, observation, protocol);
      return { state, status: state?.generation ? 'seeded' : 'unseeded', events: [], availableAt };
    }
  }
  const compatible = compatibleIntervals(catalog, observation, protocol.gpsCompatibilityM);
  if (!compatible.length) return invalidateProgress(previous, 'off-path', availableAt);
  let intervals = previous ? reachable(previous.intervals, compatible,
    protocol.maxForwardSpeedMps * (observation.observedAt - previous.lastObservedAt) / 1000,
    catalog.loopM, protocol.maxProgressIntervals) : compatible;
  if (intervals === null || intervals.length > protocol.maxProgressIntervals)
    return invalidateProgress(previous, 'phase-capacity', availableAt);
  if (!intervals.length) return invalidateProgress(previous, 'unreachable', availableAt);
  let generation = previous?.generation ?? null;
  let baselines: Record<string, number> = { ...previous?.seedGateBaselines };
  if (!generation) {
    intervals = moduloIntervals(intervals, catalog.loopM);
    const components = circularComponents(intervals, catalog.loopM);
    if (components.length === 1 && components[0]!.hi - components[0]!.lo < catalog.loopM) {
      intervals = components;
      const id = sha256(canonicalJSON({ protocolHash: PROTOCOL_SHA256, catalogHash: catalog.catalogHash,
        sourceEpoch: observation.sourceEpoch, vehicle: { routeId: observation.routeId, busId: observation.busId, busName: observation.busName },
        seedObservationHash: observation.observationHash, availableAt, intervals }));
      generation = { id, seedObservationHash: observation.observationHash, seedAvailableAt: availableAt,
        seedIntervals: intervals.map(i => ({ ...i })) };
      baselines = {};
      for (const call of catalog.calls) if (call.components.length === 1)
        baselines[call.id] = Math.ceil((intervals[0]!.lo - call.components[0]!.hi) / catalog.loopM);
    }
  }
  const evidenceChainHash = sha256(canonicalJSON({ previous: previous?.evidenceChainHash ?? null,
    observationHash: observation.observationHash, evidence: evidenceCore(observation), catalogHash: catalog.catalogHash, intervals }));
  const state: ProgressState = { v: 1, protocolHash: PROTOCOL_SHA256, catalogHash: catalog.catalogHash,
    sourceEpoch: observation.sourceEpoch,
    vehicle: { routeId: observation.routeId, busId: observation.busId, busName: observation.busName },
    generation, intervals, lastRawPoint: { lat: observation.lat, lon: observation.lon },
    lastObservedAt: observation.observedAt, lastAvailableAt: availableAt,
    lastObservationHash: observation.observationHash, lastEvidence: evidenceCore(observation),
    evidenceChainHash, availableAt, seedGateBaselines: baselines, passedThrough: { ...previous?.passedThrough } };
  const events = generation ? finishPassages(state, catalog, protocol) : [];
  if (events === null) return invalidateProgress(previous, 'phase-capacity', availableAt);
  return { state, status: generation ? 'seeded' : 'unseeded', events, availableAt };
}

function unknown(state: ProgressState | null, reason: PhaseReason, possible: EncounterRef[] = []) {
  return { kind: 'unknown' as const, reason, possible, availableAt: state?.availableAt ?? 0 };
}
function usable(state: ProgressState | null, catalog: CompiledCatalog): state is ProgressState {
  return !!state?.generation && state.catalogHash === catalog.catalogHash && state.protocolHash === PROTOCOL_SHA256
    && state.intervals.length > 0;
}
const eligible = (call: CompiledCall) => call.service === 'published-qualified' || call.service === 'spur-qualified';
const sameEncounter = (a: EncounterRef, b: EncounterRef) => a.generationId === b.generationId
  && a.occurrenceId === b.occurrenceId && a.ordinal === b.ordinal;

/** Current proof is deliberately separate from next-target enrollment proof. */
export function queryCurrentEncounter(
  state: ProgressState | null, catalog: CompiledCatalog, targetStopId: number,
  protocol: Readonly<Protocol> = DEFAULT_PROTOCOL,
): CurrentEncounter {
  assertProtocol(protocol);
  if (!usable(state, catalog)) return unknown(state, 'unseeded');
  const calls = catalog.calls.filter(c => c.stopId === targetStopId);
  if (!calls.length || calls.some(c => c.components.length !== 1)) return unknown(state, 'unmapped-call');
  let selected: { call: CompiledCall; encounter: EncounterRef } | null = null;
  const possible: EncounterRef[] = [];
  for (const interval of state.intervals) {
    const matches: { call: CompiledCall; encounter: EncounterRef }[] = [];
    const overlaps: EncounterRef[] = [];
    for (const call of calls) {
      const region = call.components[0]!;
      const first = Math.ceil((interval.lo - region.hi) / catalog.loopM);
      const last = Math.floor((interval.hi - region.lo) / catalog.loopM);
      if (last - first + 1 > protocol.maxProgressIntervals) return unknown(state, 'phase-capacity');
      for (let cycle = first; cycle <= last; cycle++) {
        const encounter = proofReference(state, call, cycle);
        if (encounter.ordinal < 0 || encounter.ordinal <= (state.passedThrough[call.id] ?? -1)) continue;
        overlaps.push(encounter);
        if (encounter.ordinal !== (state.passedThrough[call.id] ?? -1) + 1)
          return unknown(state, 'ordinal-ambiguity', overlaps);
        if (interval.lo >= region.lo + cycle * catalog.loopM && interval.hi <= region.hi + cycle * catalog.loopM)
          matches.push({ call, encounter });
      }
    }
    possible.push(...matches.map(m => m.encounter));
    if (matches.length !== 1 || overlaps.length !== 1)
      return unknown(state, overlaps.length > 1 ? 'fold-ambiguity' : 'not-current', possible);
    const match = matches[0]!;
    if (!eligible(match.call)) return unknown(state, 'unknown-service', possible);
    if (selected && !sameEncounter(selected.encounter, match.encounter)) return unknown(state, 'ordinal-ambiguity', possible);
    selected = match;
  }
  if (!selected) return unknown(state, 'not-current');
  return { kind: 'current', encounter: selected.encounter,
    service: selected.call.service as 'published-qualified' | 'spur-qualified', stopId: targetStopId,
    availableAt: state.availableAt, evidenceChainHash: state.evidenceChainHash };
}

/** Every surviving position must have the SAME next eligible target event.
 * Unknown potential service cannot be skipped to a convenient later call. */
export function queryNextEncounter(
  state: ProgressState | null, catalog: CompiledCatalog, targetStopId: number,
  protocol: Readonly<Protocol> = DEFAULT_PROTOCOL,
): NextEncounter {
  assertProtocol(protocol);
  if (!usable(state, catalog)) return unknown(state, 'unseeded');
  const calls = catalog.calls.filter(c => c.stopId === targetStopId && c.service !== 'traversal-only');
  if (!calls.length || calls.some(c => c.components.length !== 1)) return unknown(state, 'unmapped-call');
  let selected: { call: CompiledCall; encounter: EncounterRef } | null = null;
  const possible: EncounterRef[] = [];
  for (const interval of state.intervals) {
    // Current/future event choices can change only at a target region's exit.
    // Split at every such boundary so endpoints cannot hide another choice.
    const cuts = [interval.lo, interval.hi];
    for (const call of calls) {
      const exit = call.components[0]!.hi;
      const first = Math.ceil((interval.lo - exit) / catalog.loopM), last = Math.floor((interval.hi - exit) / catalog.loopM);
      if (last - first + 1 > protocol.maxProgressIntervals) return unknown(state, 'phase-capacity');
      for (let cycle = first; cycle <= last; cycle++) cuts.push(exit + cycle * catalog.loopM);
    }
    const positions = [...new Set(cuts)].sort((a, b) => a - b);
    positions.push(...positions.slice(1).map((p, i) => (p + positions[i]!) / 2));
    for (const position of positions) {
      let nearest: { call: CompiledCall; encounter: EncounterRef; enter: number; exit: number } | null = null;
      const candidates: { call: CompiledCall; encounter: EncounterRef; enter: number; exit: number }[] = [];
      for (const call of calls) {
        const region = call.components[0]!, baseline = state.seedGateBaselines[call.id]!;
        const cycle = Math.max(Math.ceil((position - region.hi) / catalog.loopM), baseline + (state.passedThrough[call.id] ?? -1) + 1);
        const exit = region.hi + cycle * catalog.loopM, enter = Math.max(position, region.lo + cycle * catalog.loopM);
        const encounter = proofReference(state, call, cycle);
        if (encounter.ordinal !== (state.passedThrough[call.id] ?? -1) + 1)
          return unknown(state, 'ordinal-ambiguity', [...possible, encounter]);
        const candidate = { call, encounter, enter, exit };
        candidates.push(candidate);
        if (!nearest || enter < nearest.enter) nearest = candidate;
      }
      if (!nearest) return unknown(state, 'unmapped-call');
      if (candidates.some(c => !sameEncounter(c.encounter, nearest!.encounter) && c.enter <= nearest!.exit))
        return unknown(state, 'fold-ambiguity', [...possible, ...candidates.map(c => c.encounter)]);
      possible.push(nearest.encounter);
      if (!eligible(nearest.call)) return unknown(state, 'unknown-service', possible);
      if (selected && !sameEncounter(selected.encounter, nearest.encounter)) return unknown(state, 'ordinal-ambiguity', possible);
      selected = nearest;
    }
  }
  if (!selected) return unknown(state, 'unmapped-call');
  return { kind: 'bound', encounter: selected.encounter,
    service: selected.call.service as 'published-qualified' | 'spur-qualified', stopId: targetStopId,
    availableAt: state.availableAt, evidenceChainHash: state.evidenceChainHash };
}
