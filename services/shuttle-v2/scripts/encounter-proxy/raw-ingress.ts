import { canonicalJSON, observationHash, sha256 } from './canonical.js';
import { assertProtocol, DEFAULT_PROTOCOL, type Protocol } from './protocol.js';
import type { PhaseReason, RawObservation, VehicleKey } from './types.js';

export interface TransportTiming {
  originalReceivedAt: number;
  /** Actual availability to THIS consumer, never substituted for the original receipt. */
  availableAt: number;
  origin?: 'historical-frame' | 'public-current';
}
export interface RawPacket {
  v: 1;
  sourceEpoch: string;
  sourceBuild: string;
  cursor: number;
  latest: number;
  hasMore: boolean;
  frameCount: number;
  originalReceivedAt: number;
  availableAt: number;
  origin: 'historical-frame' | 'public-current';
  /** Hash of this stripped receipt, deliberately independent of predictor fields. */
  receiptHash: string;
  observations: readonly RawObservation[];
  malformedBusIndices: readonly number[];
}
type ObjectValue = Record<string, unknown>;
const object = (value: unknown): value is ObjectValue => value !== null && typeof value === 'object' && !Array.isArray(value);
const clock = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const positiveId = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
export const vehicleKey = (vehicle: VehicleKey): string => canonicalJSON([vehicle.routeId, vehicle.busId, vehicle.busName]);
export const isLivePacket = (packet: RawPacket): boolean => packet.origin === 'public-current'
  && packet.frameCount === 0 && !packet.hasMore && packet.cursor === packet.latest;

function receiptBody(packet: Omit<RawPacket, 'receiptHash'>) {
  return { v: packet.v, sourceEpoch: packet.sourceEpoch, sourceBuild: packet.sourceBuild,
    cursor: packet.cursor, latest: packet.latest, hasMore: packet.hasMore, frameCount: packet.frameCount,
    originalReceivedAt: packet.originalReceivedAt, availableAt: packet.availableAt, origin: packet.origin,
    observations: packet.observations.map(value => ({ sourceEpoch: value.sourceEpoch, routeId: value.routeId,
      busId: value.busId, busName: value.busName, observedAt: value.observedAt, lat: value.lat, lon: value.lon,
      stationary: value.stationary, atStopId: value.atStopId })), malformedBusIndices: packet.malformedBusIndices };
}

/** Detect changed receipt clocks/provenance even when the GPS identity itself
 * remains unchanged. Original-byte verification belongs to the custody layer. */
export function assertStrippedPacket(packet: RawPacket, protocol: Readonly<Protocol> = DEFAULT_PROTOCOL): void {
  assertProtocol(protocol);
  if (packet.v !== 1 || !packet.sourceEpoch || !packet.sourceBuild || !positiveId(packet.cursor)
    || !positiveId(packet.latest) || packet.latest < packet.cursor || typeof packet.hasMore !== 'boolean'
    || !clock(packet.frameCount) || !clock(packet.originalReceivedAt) || !clock(packet.availableAt)
    || packet.originalReceivedAt > packet.availableAt || !['public-current', 'historical-frame'].includes(packet.origin)
    || !Array.isArray(packet.observations) || !Array.isArray(packet.malformedBusIndices)
    || packet.observations.length + packet.malformedBusIndices.length > protocol.maxPacketBuses
    || packet.receiptHash !== sha256(canonicalJSON(receiptBody(packet)))) throw new Error('Invalid stripped receipt');
  for (const observation of packet.observations) {
    const e = observation.evidence;
    if (observation.sourceEpoch !== packet.sourceEpoch || !positiveId(observation.routeId) || !positiveId(observation.busId)
      || typeof observation.busName !== 'string' || !observation.busName.length || !clock(observation.observedAt)
      || !finite(observation.lat) || Math.abs(observation.lat) > 90 || !finite(observation.lon) || Math.abs(observation.lon) > 180
      || typeof observation.stationary !== 'boolean' || (observation.atStopId !== null && !positiveId(observation.atStopId))
      || observation.observationHash !== observationHash(observation) || e.observationHash !== observation.observationHash
      || e.observedAt !== observation.observedAt || e.receiptHash !== packet.receiptHash
      || e.originalReceivedAt !== packet.originalReceivedAt || e.availableAt !== packet.availableAt
      || e.origin !== packet.origin || e.frameCount !== packet.frameCount || e.hasMore !== packet.hasMore
      || e.cursor !== packet.cursor || e.latest !== packet.latest) throw new Error('Invalid stripped observation provenance');
  }
}

/** Explicit raw allowlist. The caller must retain the original bytes BEFORE
 * projecting them. No spread, model field, forecast or predictor hash enters
 * the returned packet or its semantic receipt hash. */
export function projectPublicPacket(input: unknown, timing: TransportTiming,
  protocol: Readonly<Protocol> = DEFAULT_PROTOCOL): RawPacket {
  assertProtocol(protocol);
  if (!clock(timing.originalReceivedAt) || !clock(timing.availableAt)
    || timing.availableAt < timing.originalReceivedAt) throw new Error('Invalid original/consumer receipt clocks');
  const origin = timing.origin ?? 'public-current';
  if (!['public-current', 'historical-frame'].includes(origin)) throw new Error('Invalid raw observation origin');
  if (!object(input) || input.v !== 1 || typeof input.epoch !== 'string' || !input.epoch.length
    || typeof input.build !== 'string' || !input.build.length || !positiveId(input.cursor)
    || !positiveId(input.latest) || input.latest < input.cursor || typeof input.hasMore !== 'boolean'
    || !Array.isArray(input.frames) || !object(input.feed) || !Array.isArray(input.feed.buses)
    || input.feed.buses.length > protocol.maxPacketBuses) throw new Error('Malformed raw public packet');
  const cores: Omit<RawObservation, 'observationHash' | 'evidence'>[] = [];
  const malformedBusIndices: number[] = [];
  for (const [index, bus] of input.feed.buses.entries()) {
    if (!object(bus) || !positiveId(bus.route_id) || !positiveId(bus.bus_id)
      || typeof bus.bus_name !== 'string' || !bus.bus_name.length || bus.bus_name.length > 128
      || !clock(bus.observed_at) || !finite(bus.lat) || Math.abs(bus.lat) > 90
      || !finite(bus.lon) || Math.abs(bus.lon) > 180 || typeof bus.stationary !== 'boolean'
      || (bus.at_stop_id != null && !positiveId(bus.at_stop_id))) {
      malformedBusIndices.push(index); continue;
    }
    cores.push({ sourceEpoch: input.epoch, routeId: bus.route_id, busId: bus.bus_id, busName: bus.bus_name,
      observedAt: bus.observed_at, lat: bus.lat, lon: bus.lon, stationary: bus.stationary,
      atStopId: bus.at_stop_id == null ? null : bus.at_stop_id });
  }
  const base = { v: 1 as const, sourceEpoch: input.epoch, sourceBuild: input.build,
    cursor: input.cursor, latest: input.latest, hasMore: input.hasMore, frameCount: input.frames.length,
    originalReceivedAt: timing.originalReceivedAt, availableAt: timing.availableAt, origin,
    observations: cores, malformedBusIndices };
  const receiptHash = sha256(canonicalJSON(base));
  const observations = cores.map(core => {
    const hash = observationHash(core);
    return { ...core, observationHash: hash, evidence: { receiptHash, observationHash: hash,
      observedAt: core.observedAt, originalReceivedAt: timing.originalReceivedAt, availableAt: timing.availableAt,
      origin, frameCount: base.frameCount, hasMore: base.hasMore, cursor: base.cursor, latest: base.latest } };
  });
  return { ...base, observations, receiptHash };
}

export interface StrippedExchange {
  /** External custody ONLY: never pass these two fields to the outcome reducer. */
  fullPacketHash: string;
  fullPacketBytes: number;
  packet: RawPacket | null;
  error: 'http-error' | 'malformed-packet' | 'packet-capacity' | null;
}
export function stripRawExchange(bytes: Uint8Array, status: number, timing: TransportTiming,
  protocol: Readonly<Protocol> = DEFAULT_PROTOCOL): StrippedExchange {
  assertProtocol(protocol);
  const custody = { fullPacketHash: sha256(bytes), fullPacketBytes: bytes.byteLength };
  if (bytes.byteLength > protocol.maxPacketBytes) return { ...custody, packet: null, error: 'packet-capacity' };
  if (status !== 200) return { ...custody, packet: null, error: 'http-error' };
  try {
    const input: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    return { ...custody, packet: projectPublicPacket(input, timing, protocol), error: null };
  } catch { return { ...custody, packet: null, error: 'malformed-packet' }; }
}

interface FixRecord { hash: string; liveSpent: boolean; canonical: boolean }
interface VehicleIngress { identity: VehicleKey; maximumObservedAt: number | null; fixes: Record<string, FixRecord> }
export interface IngressState {
  v: 1;
  sourceEpoch: string | null;
  sourceBuild: string | null;
  lastCursor: number | null;
  lastAvailableAt: number | null;
  lastOriginalReceivedAt: number | null;
  vehicles: Record<string, VehicleIngress>;
}
export interface IngressBoundary { vehicle: string | null; reason: PhaseReason; availableAt: number }
export interface ObservationDisposition {
  vehicle: string;
  observationHash: string;
  kind: 'new' | 'copy' | 'live-upgrade' | 'conflict' | 'reordered' | 'stale' | 'future' | 'capacity';
}
export interface IngressResult {
  state: IngressState;
  packet: RawPacket;
  canonicalObservations: readonly RawObservation[];
  liveWitnesses: readonly RawObservation[];
  boundaries: readonly IngressBoundary[];
  dispositions: readonly ObservationDisposition[];
}
export function emptyIngressState(): IngressState {
  return { v: 1, sourceEpoch: null, sourceBuild: null, lastCursor: null, lastAvailableAt: null,
    lastOriginalReceivedAt: null, vehicles: {} };
}

/** Every receipt has already been durably recorded. Deduplication decides
 * observation identity separately from one-time live-witness provenance. */
export function ingestRawPacket(previous: IngressState, packet: RawPacket,
  protocol: Readonly<Protocol> = DEFAULT_PROTOCOL): IngressResult {
  assertStrippedPacket(packet, protocol);
  let state: IngressState = structuredClone(previous);
  const boundaries: IngressBoundary[] = [];
  const dispositions: ObservationDisposition[] = [];
  let canonicalObservations: RawObservation[] = [], liveWitnesses: RawObservation[] = [];
  const invalidateAll = (reason: PhaseReason) => {
    boundaries.push({ vehicle: null, reason, availableAt: packet.availableAt });
    state = emptyIngressState();
  };
  if (state.sourceEpoch !== null && (state.sourceEpoch !== packet.sourceEpoch || state.sourceBuild !== packet.sourceBuild))
    invalidateAll('epoch-change');
  if (state.lastAvailableAt !== null && (packet.availableAt < state.lastAvailableAt
    || packet.originalReceivedAt < state.lastOriginalReceivedAt!)) invalidateAll('source-regression');
  if (state.lastAvailableAt !== null && packet.availableAt - state.lastAvailableAt > protocol.maxActualReceiptGapMs)
    invalidateAll('receipt-gap');
  if (state.lastCursor !== null && packet.cursor < state.lastCursor && isLivePacket(packet)) invalidateAll('source-regression');
  if (state.lastCursor !== null && packet.cursor > state.lastCursor + 1) invalidateAll('source-gap');
  const present = new Set(packet.observations.map(vehicleKey));
  for (const key of Object.keys(state.vehicles)) if (!present.has(key)) {
    boundaries.push({ vehicle: key, reason: packet.malformedBusIndices.length ? 'malformed-observation' : 'missing-bus',
      availableAt: packet.availableAt });
  }
  const conflicted = new Set<string>();
  for (const observation of packet.observations) {
    const key = vehicleKey(observation), observedKey = String(observation.observedAt);
    const identity = { routeId: observation.routeId, busId: observation.busId, busName: observation.busName };
    // Exact identity is required. Provider/name reuse only censors continuity;
    // it never joins visits or silently transfers a pending promise.
    for (const [oldKey, old] of Object.entries(state.vehicles)) if (oldKey !== key
      && (old.identity.busId === identity.busId || old.identity.busName === identity.busName)) {
      boundaries.push({ vehicle: oldKey, reason: 'identity-change', availableAt: packet.availableAt });
      if (present.has(oldKey)) {
        conflicted.add(oldKey); conflicted.add(key);
        boundaries.push({ vehicle: key, reason: 'identity-change', availableAt: packet.availableAt });
      }
      delete state.vehicles[oldKey];
    }
    const record = state.vehicles[key] ??= { identity, maximumObservedAt: null, fixes: {} };
    const old = record.fixes[observedKey];
    if (observation.observationHash !== observationHash(observation)
      || observation.evidence.observationHash !== observation.observationHash)
      throw new Error('Invalid stripped observation identity');
    const addDisposition = (kind: ObservationDisposition['kind']) => dispositions.push({ vehicle: key,
      observationHash: observation.observationHash, kind });
    if (old && old.hash !== observation.observationHash) {
      old.hash = 'conflict'; old.liveSpent = true; conflicted.add(key);
      boundaries.push({ vehicle: key, reason: 'same-clock-conflict', availableAt: packet.availableAt });
      addDisposition('conflict'); continue;
    }
    // Remember identity/variants BEFORE every eligibility filter. Rejected
    // future/stale input must not poison the accepted-progress watermark.
    const fix = record.fixes[observedKey] ??= { hash: observation.observationHash, liveSpent: false, canonical: false };
    if (record.maximumObservedAt !== null) for (const value of Object.keys(record.fixes)) {
      if (Number(value) < record.maximumObservedAt - protocol.maxDistinctObservationGapMs) delete record.fixes[value];
    }
    if (Object.keys(record.fixes).length > protocol.maxRetainedFixesPerVehicle) {
      conflicted.add(key); record.fixes = {};
      boundaries.push({ vehicle: key, reason: 'phase-capacity', availableAt: packet.availableAt });
      addDisposition('capacity'); continue;
    }
    if (record.maximumObservedAt !== null && observation.observedAt < record.maximumObservedAt) {
      if (isLivePacket(packet)) boundaries.push({ vehicle: key, reason: 'regressing-observation', availableAt: packet.availableAt });
      addDisposition('reordered'); continue;
    }
    const future = observation.observedAt > packet.originalReceivedAt;
    const stale = packet.originalReceivedAt - observation.observedAt > protocol.maxAbsLiveObservedReceiptSkewMs
      || packet.availableAt - observation.observedAt > protocol.maxAbsLiveObservedReceiptSkewMs;
    if (future || stale) {
      addDisposition(future ? 'future' : 'stale');
      // Historical prehistory may seed phase, but cannot become a live witness
      // or replace an observation newer than the current causal prefix.
      if (future || (packet.origin === 'public-current' && isLivePacket(packet))) {
        boundaries.push({ vehicle: key, reason: 'malformed-observation', availableAt: packet.availableAt });
        continue;
      }
    }
    if (!fix.canonical) {
      fix.canonical = true;
      record.maximumObservedAt = Math.max(record.maximumObservedAt ?? observation.observedAt, observation.observedAt);
      canonicalObservations.push(observation); addDisposition('new');
    } else addDisposition('copy');
    if (isLivePacket(packet) && !future && !stale && !fix.liveSpent) {
      fix.liveSpent = true; liveWitnesses.push(observation); addDisposition('live-upgrade');
    }
  }
  canonicalObservations = canonicalObservations.filter(value => !conflicted.has(vehicleKey(value)));
  liveWitnesses = liveWitnesses.filter(value => !conflicted.has(vehicleKey(value)));
  state.sourceEpoch = packet.sourceEpoch; state.sourceBuild = packet.sourceBuild;
  state.lastCursor = Math.max(state.lastCursor ?? packet.cursor, packet.cursor);
  state.lastAvailableAt = packet.availableAt; state.lastOriginalReceivedAt = packet.originalReceivedAt;
  return { state, packet, canonicalObservations, liveWitnesses, boundaries, dispositions };
}
