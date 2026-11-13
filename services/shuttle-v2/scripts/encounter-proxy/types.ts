/** Pure outcome inputs. Predictor and full-packet custody fields are absent. */
export interface Point { lat: number; lon: number }
export interface VehicleKey { routeId: number; busId: number; busName: string }
export interface EvidenceRef {
  /** Hash of the STRIPPED raw receipt, never a full predictor packet hash. */
  receiptHash: string;
  observationHash: string;
  observedAt: number;
  originalReceivedAt: number;
  availableAt: number;
  origin: 'historical-frame' | 'public-current';
  frameCount: number;
  hasMore: boolean;
  cursor: number;
  latest: number;
}
export interface RawObservation extends Point, VehicleKey {
  sourceEpoch: string;
  observedAt: number;
  stationary: boolean;
  atStopId: number | null;
  observationHash: string;
  evidence: EvidenceRef;
}

/** An explicit independently reviewed portion of an ORIGINAL raw segment. */
export interface SegmentMask { segment: number; from?: number; to?: number }
export type ServiceStatus = 'published-qualified' | 'spur-qualified' | 'unknown' | 'traversal-only';
export interface CallSpec {
  id: string;
  stopId: number;
  publishedIndex: number | null;
  service: ServiceStatus;
  masks: readonly SegmentMask[];
  /** Independent catalog/service/mapping evidence; never model evidence. */
  evidenceHashes: readonly string[];
}
export interface RouteCatalogSpec {
  v: 1;
  routeId: number;
  sourceTopologyHash: string;
  pathProvenance: string;
  path: readonly Point[];
  publishedStops: readonly number[];
  stopCoords: Readonly<Record<number, Point>>;
  calls: readonly CallSpec[];
}
export interface ArcInterval { lo: number; hi: number }
export interface CompiledCall {
  id: string;
  stopId: number;
  publishedIndex: number | null;
  service: ServiceStatus;
  coord: Point;
  /** Modulo-loop region, split at the raw path seam. */
  regions: readonly ArcInterval[];
  /** A connected seam-crossing region is represented once in lifted form. */
  components: readonly ArcInterval[];
  evidenceHashes: readonly string[];
  automatic: boolean;
}
export interface CompiledCatalog {
  v: 1;
  routeId: number;
  catalogHash: string;
  sourceTopologyHash: string;
  path: readonly Point[];
  cumulative: readonly number[];
  loopM: number;
  publishedStops: readonly number[];
  calls: readonly CompiledCall[];
}
export interface EncounterRef {
  generationId: string;
  occurrenceId: string;
  ordinal: number;
}
export type PhaseReason = 'unseeded' | 'fold-ambiguity' | 'ordinal-ambiguity' | 'unknown-service'
  | 'unmapped-call' | 'not-current' | 'off-path' | 'unreachable' | 'observation-gap' | 'receipt-gap'
  | 'identity-change' | 'epoch-change' | 'catalog-change' | 'protocol-change' | 'same-clock-conflict'
  | 'regressing-observation' | 'phase-capacity' | 'malformed-observation' | 'missing-bus'
  | 'source-regression' | 'source-gap' | 'restart';
export interface PhaseGeneration {
  id: string;
  seedObservationHash: string;
  seedAvailableAt: number;
  seedIntervals: readonly ArcInterval[];
}
export interface ProgressState {
  v: 1;
  protocolHash: string;
  catalogHash: string;
  sourceEpoch: string;
  vehicle: VehicleKey;
  generation: PhaseGeneration | null;
  intervals: readonly ArcInterval[];
  lastRawPoint: Point;
  lastObservedAt: number;
  lastAvailableAt: number;
  lastObservationHash: string;
  lastEvidence: EvidenceRef;
  evidenceChainHash: string;
  availableAt: number;
  /** First region cycle at/after the seed, per occurrence. */
  seedGateBaselines: Readonly<Record<string, number>>;
  /** Highest irrevocably passed generation-relative ordinal, default -1. */
  passedThrough: Readonly<Record<string, number>>;
}
export interface PhaseBoundary {
  kind: 'invalidate'; reason: PhaseReason; availableAt: number;
  generationId: string | null; evidenceChainHash: string;
}
export interface PassedEncounter {
  kind: 'passed'; encounter: EncounterRef; service: ServiceStatus;
  stopId: number; availableAt: number; evidenceChainHash: string;
}
export interface ProgressResult {
  state: ProgressState | null;
  status: 'seeded' | 'unseeded' | 'invalid';
  events: readonly (PhaseBoundary | PassedEncounter)[];
  availableAt: number;
}
export interface QualifiedEncounter {
  kind: 'current' | 'bound'; encounter: EncounterRef;
  service: 'published-qualified' | 'spur-qualified'; stopId: number;
  availableAt: number; evidenceChainHash: string;
}
export interface UnknownEncounter {
  kind: 'unknown'; reason: PhaseReason; possible: readonly EncounterRef[];
  availableAt: number;
}
export type CurrentEncounter = (QualifiedEncounter & { kind: 'current' }) | UnknownEncounter;
export type NextEncounter = (QualifiedEncounter & { kind: 'bound' }) | UnknownEncounter;
