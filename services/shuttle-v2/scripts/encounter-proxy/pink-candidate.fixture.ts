import { readFileSync } from 'node:fs';
import { canonicalJSON, deepFreeze, sha256 } from './canonical.js';
import type { CallSpec, RouteCatalogSpec } from './types.js';

interface CandidateSource {
  v: 1; scope: string; qualificationPending: true; fixtureModeRequired: true;
  originalTopologyProjectionSHA256: string;
  rawSource: { routeId: number; publishedStops: number[]; path: [number, number][];
    stopCoords: Record<number, { lat: number; lon: number }> };
  publishedMasks: number[][];
  conditionalNonserviceMasks: { stopId: number; direction: string; segments: number[] }[];
  assumption: string;
}
const candidate = deepFreeze(JSON.parse(readFileSync(new URL('./__fixtures__/pink-candidate-catalog-source.v1.json', import.meta.url), 'utf8')) as CandidateSource);
export const PINK_CANDIDATE_QUALIFICATION = {
  fixtureModeOnly: true, qualificationPending: true,
  scope: candidate.scope, assumption: candidate.assumption,
  originalTopologyProjectionSHA256: candidate.originalTopologyProjectionSHA256,
} as const;

/** Conditional fixture construction, NOT an operator/service attestation.
 * Authentic coordinates/order/path are copied unchanged; directional mask
 * declarations are explicitly pending independent future qualification. */
export function pinkCandidateSpec(fixtureMode: true): RouteCatalogSpec {
  if (fixtureMode !== true) throw new Error('Pink candidate mapping is fixture-only and remains unqualified');
  const raw = candidate.rawSource;
  const sourceTopologyHash = sha256(canonicalJSON(raw));
  const fixtureAssumptionHash = sha256(canonicalJSON({ fixtureMode: true, qualificationPending: true,
    sourceTopologyHash, assumption: candidate.assumption, publishedMasks: candidate.publishedMasks,
    conditionalNonserviceMasks: candidate.conditionalNonserviceMasks }));
  const calls: CallSpec[] = raw.publishedStops.map((stopId, publishedIndex) => ({
    id: `published:${publishedIndex}:${stopId}`, stopId, publishedIndex,
    service: 'published-qualified', masks: candidate.publishedMasks[publishedIndex]!.map(segment => ({ segment })),
    evidenceHashes: [fixtureAssumptionHash],
  }));
  for (const nonservice of candidate.conditionalNonserviceMasks) calls.push({
    id: `fixture-nonservice:${nonservice.stopId}:${nonservice.direction}`, stopId: nonservice.stopId, publishedIndex: null,
    service: 'traversal-only', masks: nonservice.segments.map(segment => ({ segment })), evidenceHashes: [fixtureAssumptionHash],
  });
  return { v: 1, routeId: raw.routeId, sourceTopologyHash,
    pathProvenance: 'Authentic source field values; directional masks are fixture-candidate assumptions with qualification pending',
    path: raw.path.map(([lat, lon]) => ({ lat, lon })), publishedStops: [...raw.publishedStops],
    stopCoords: Object.fromEntries(Object.entries(raw.stopCoords).map(([id, p]) => [id, { lat: p.lat, lon: p.lon }])), calls };
}
