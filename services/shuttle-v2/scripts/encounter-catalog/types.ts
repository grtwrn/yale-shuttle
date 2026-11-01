import type { ArcInterval, Point } from '../encounter-proxy/types.js';

export interface SourcePin { id: string; file: string; bytes: number; sha256: string }
export interface Evidence { status: 'reviewed' | 'fixture-assumption' | 'unqualified'; sourceIds: string[] }
export interface PublishedOccurrence { id: string; publishedIndex: number; stopId: number }
export interface SpurOccurrence { id: string; stopId: number; evidence: Evidence }
export interface Curb { stopId: number; coord: Point; sourceIds: string[] }
export interface PlanToken { id: string; occurrenceOptions: string[] }
export interface PlanVariant { id: string; sourceIds: string[]; tokens: PlanToken[] }
export type Orientation = 'forward' | 'reverse';
export interface CatalogInput {
  schema: 'independent-catalog-embedding-input/v1';
  mode: 'fixture' | 'reference-analysis';
  routeId: number;
  sources: SourcePin[];
  path: Point[];
  curbs: Curb[];
  published: PublishedOccurrence[];
  spurs: SpurOccurrence[];
  variants: PlanVariant[];
  scope: {
    onePlanCycleOneRawLoop: Evidence;
    orientations: Orientation[];
    orientationExclusions: { orientation: Orientation; evidence: Evidence }[];
    qualificationPending: true;
  };
}

export interface Caps {
  maxSourceFiles: number; maxSourceFileBytes: number; maxAggregateSourceBytes: number;
  maxVertices: number; maxCalls: number; maxAdmittedSourceVariants: number;
  maxTypedInterpretations: number; maxCandidateComponents: number;
  maxExpandedStates: number; maxFeasibleAssignments: number;
  maxDiagnosticOutputBytes: number; reservedRefusalOutputBytes: number;
  internalMonotonicBudgetMs: number; externalOwnerWallMs: number;
  linuxMemoryBytes: number; nodeMaxOldSpaceMiB: number; linuxCPUCount: number; maxPids: number;
}
export type ArtifactChannel = 'component-universe' | 'interpretations' | 'search-trace-rejections'
  | 'feasible-embeddings' | 'ambiguous-and-unknown-regions';
export interface AuditRecord { kind: string; data: unknown }
export interface EnumeratorOptions {
  /** A recording sink may throw LimitRefusal before exceeding its output cap. */
  emit?: (channel: ArtifactChannel, record: AuditRecord) => void;
  /** Actual monotonic clock; tests/replay may supply their explicitly retained clock transcript. */
  now?: () => number;
  /** Engineering bounds may only be lowered; effective values are included in the result. */
  caps?: Partial<Caps>;
}
export interface SegmentFraction { segment: number; from: number; to: number }
export interface Component {
  id: string; stopId: number; arc: ArcInterval;
  segments: SegmentFraction[];
  /** A full-loop/point region cannot identify a separate R3 service encounter. */
  degenerate: boolean;
}
export interface Choice {
  tokenId: string; occurrenceId: string; componentId: string; lift: number;
  interval: ArcInterval;
}
export interface Interpretation {
  id: string; variantId: string; orientation: Orientation; rotation: number;
  crosswalk: { tokenId: string; occurrenceId: string }[];
}
export interface Embedding {
  id: string; interpretation: Interpretation; choices: Choice[];
  /** No solution is discarded by this alias annotation. */
  physicalAssignmentKey: string;
  inseparableOccurrences: string[];
}
export interface Invariance {
  occurrenceId: string; stopId: number; kind: 'published' | 'spur';
  mappings: { componentId: string; orientation: Orientation }[];
  status: 'candidate-invariant-pending-admission' | 'unknown'; reasons: string[];
}
export interface UnknownRegion {
  stopId: number; componentId: string; reason: string; possibleOccurrences: string[];
  service: 'unknown';
}
export interface SearchFrame {
  phase: 'crosswalk' | 'embedding'; variantIndex: number; tokenIndex: number;
  interpretationId: string | null; nextCandidateIndices: number[];
  /** Input/component array indices keep refusal frontier size bounded even for long valid IDs. */
  prefix: { tokenIndex: number; occurrenceIndex: number; componentIndex?: number; lift?: number }[];
}
export interface Counts {
  expandedStates: number; interpretations: number; feasibleAssignments: number;
  rejectedPrefixes: number; unresolvedPrefixes: number;
}
export type Verdict = 'refused-source-scope' | 'refused-incomplete'
  | 'complete-exhaustive-but-ambiguous' | 'complete-exhaustive-invariant-subset-pending-admission';
export interface EnumerationResult {
  schema: 'independent-catalog-embedding-result/v1';
  inputHash: string; protocolHash: string; r3ProtocolHash: string;
  mode: CatalogInput['mode']; effectiveCaps: Caps;
  verdict: Verdict; complete: boolean; searchExhausted: boolean; refusals: string[];
  counts: Counts; variantSolutions: Record<string, number>;
  components: Component[]; invariance: Invariance[]; unknownRegions: UnknownRegion[];
  frontier: SearchFrame[];
  liveQualified: false; publicationCapability: false;
}

export class LimitRefusal extends Error {
  constructor(readonly reason: string) { super(reason); this.name = 'LimitRefusal'; }
}
