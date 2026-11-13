/** Controlled geometry only. These declarations are not real service proof. */
import { observationHash, sha256 } from './canonical.js';
import { compileCatalog } from './catalog.js';
import type { CallSpec, Point, RawObservation, RouteCatalogSpec, ServiceStatus } from './types.js';

export const proof = sha256('controlled fixture mapping; not physical service truth');
const source = sha256('controlled raw topology');
export const FOLD = [
  { lat: 41, lon: -73 }, { lat: 41, lon: -72.96 },
  { lat: 41.0002, lon: -72.96 }, { lat: 41.0002, lon: -73 }, { lat: 41, lon: -73 },
];
export const FOLD_STOP = { lat: 41.0001, lon: -72.98 };
export const APEX = { lat: 41.0001, lon: -72.96 };

export function foldSpec(north: ServiceStatus | 'omitted' = 'published-qualified'): RouteCatalogSpec {
  const published = north === 'published-qualified';
  const calls: CallSpec[] = [
    { id: 'south', stopId: 100, publishedIndex: 0, service: 'published-qualified', masks: [{ segment: 0 }], evidenceHashes: [proof] },
    { id: 'apex', stopId: 200, publishedIndex: 1, service: 'published-qualified', masks: [0, 1, 2].map(segment => ({ segment })), evidenceHashes: [proof] },
  ];
  if (north !== 'omitted') calls.push({ id: 'north', stopId: 100, publishedIndex: published ? 2 : null,
    service: north, masks: [{ segment: 2 }], evidenceHashes: north === 'unknown' ? [] : [proof] });
  return { v: 1, routeId: 100, sourceTopologyHash: source, pathProvenance: 'controlled independent fixture',
    path: FOLD, publishedStops: published ? [100, 200, 100] : [100, 200], stopCoords: { 100: FOLD_STOP, 200: APEX }, calls };
}
export const foldCatalog = (north: ServiceStatus | 'omitted' = 'published-qualified') => compileCatalog(foldSpec(north));

export function squareSpec(): RouteCatalogSpec {
  return { v: 1, routeId: 100, sourceTopologyHash: source, pathProvenance: 'controlled independent fixture',
    path: [{ lat: 41, lon: -73 }, { lat: 41, lon: -72.98 }, { lat: 41.01, lon: -72.98 },
      { lat: 41.01, lon: -73 }, { lat: 41, lon: -73 }],
    publishedStops: [100, 200], stopCoords: { 100: { lat: 41, lon: -72.99 }, 200: { lat: 41.01, lon: -72.99 } },
    calls: [
      { id: 'bottom', stopId: 100, publishedIndex: 0, service: 'published-qualified', masks: [{ segment: 0 }], evidenceHashes: [proof] },
      { id: 'top', stopId: 200, publishedIndex: 1, service: 'published-qualified', masks: [{ segment: 2 }], evidenceHashes: [proof] },
    ] };
}

export function fix(point: Point, observedAt: number, options: {
  stationary?: boolean; atStopId?: number | null; historical?: boolean; availableAt?: number;
  originalReceivedAt?: number; sourceEpoch?: string; busId?: number;
} = {}): RawObservation {
  const core = { ...point, sourceEpoch: options.sourceEpoch ?? 'raw-fixture-epoch', routeId: 100,
    busId: options.busId ?? 7, busName: '#raw', observedAt,
    stationary: options.stationary ?? false, atStopId: options.atStopId ?? null };
  const hash = observationHash(core), originalReceivedAt = options.originalReceivedAt ?? observedAt + 100;
  const availableAt = options.availableAt ?? originalReceivedAt + 100;
  return { ...core, observationHash: hash, evidence: {
    receiptHash: sha256(`stripped:${hash}:${originalReceivedAt}:${availableAt}:${!!options.historical}`),
    observationHash: hash, observedAt, originalReceivedAt, availableAt,
    origin: options.historical ? 'historical-frame' : 'public-current', frameCount: options.historical ? 1 : 0,
    hasMore: false, cursor: 1, latest: 1,
  } };
}
