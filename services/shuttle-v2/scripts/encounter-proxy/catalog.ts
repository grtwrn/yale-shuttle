import { canonicalJSON, deepFreeze, sha256 } from './canonical.js';
import { assertProtocol, DEFAULT_PROTOCOL, PROTOCOL_SHA256, type Protocol } from './protocol.js';
import type { ArcInterval, CompiledCall, CompiledCatalog, Point, RouteCatalogSpec } from './types.js';

const EARTH_M = 6_371_000;
const radians = (degrees: number) => degrees * Math.PI / 180;
const wrapped = (value: number) => ((value + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
export const isHash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export const isPoint = (p: unknown): p is Point => !!p && typeof p === 'object'
  && Number.isFinite((p as Point).lat) && Math.abs((p as Point).lat) <= 90
  && Number.isFinite((p as Point).lon) && Math.abs((p as Point).lon) <= 180;

/** Conventional great-circle distance; no learned or estimator geometry. */
export function distanceMeters(a: Point, b: Point): number {
  const lat = radians(b.lat - a.lat), lon = radians(b.lon - a.lon);
  const h = Math.sin(lat / 2) ** 2 + Math.cos(radians(a.lat)) * Math.cos(radians(b.lat)) * Math.sin(lon / 2) ** 2;
  return 2 * EARTH_M * Math.asin(Math.sqrt(Math.min(1, Math.max(0, h))));
}

/** All portions of a raw straight segment inside a local metric GPS disc.
 * The reference latitude is the observation's, not a predictor-selected arc. */
function discFraction(a: Point, b: Point, centre: Point, radius: number): ArcInterval | null {
  const cos = Math.cos(radians(centre.lat));
  const ax = EARTH_M * wrapped(radians(a.lon - centre.lon)) * cos;
  const ay = EARTH_M * radians(a.lat - centre.lat);
  const bx = EARTH_M * wrapped(radians(b.lon - centre.lon)) * cos;
  const by = EARTH_M * radians(b.lat - centre.lat);
  const dx = bx - ax, dy = by - ay, d2 = dx * dx + dy * dy;
  if (d2 === 0) return ax * ax + ay * ay <= radius * radius ? { lo: 0, hi: 1 } : null;
  const middle = -(ax * dx + ay * dy) / d2;
  const nearestX = ax + middle * dx, nearestY = ay + middle * dy;
  const remaining = radius * radius - nearestX * nearestX - nearestY * nearestY;
  if (remaining < 0) return null;
  const span = Math.sqrt(remaining / d2), lo = Math.max(0, middle - span), hi = Math.min(1, middle + span);
  return lo <= hi ? { lo, hi } : null;
}

export function mergeIntervals(input: readonly ArcInterval[]): ArcInterval[] {
  const sorted = input.map(i => ({ lo: i.lo, hi: i.hi })).sort((a, b) => a.lo - b.lo || a.hi - b.hi);
  const out: ArcInterval[] = [];
  for (const interval of sorted) {
    const previous = out.at(-1);
    if (previous && interval.lo <= previous.hi) previous.hi = Math.max(previous.hi, interval.hi);
    else out.push(interval);
  }
  return out;
}

export function circularComponents(input: readonly ArcInterval[], loopM: number): ArcInterval[] {
  const regions = mergeIntervals(input);
  if (regions.length > 1 && regions[0]!.lo === 0 && regions.at(-1)!.hi === loopM) {
    const first = regions.shift()!, last = regions.pop()!;
    regions.push({ lo: last.lo, hi: loopM + first.hi });
  }
  return regions.sort((a, b) => a.lo - b.lo);
}

export function compatibleIntervals(
  catalog: Pick<CompiledCatalog, 'path' | 'cumulative'>, point: Point, radius: number,
): ArcInterval[] {
  const intervals: ArcInterval[] = [];
  for (let segment = 0; segment + 1 < catalog.path.length; segment++) {
    const range = discFraction(catalog.path[segment]!, catalog.path[segment + 1]!, point, radius);
    const start = catalog.cumulative[segment]!, length = catalog.cumulative[segment + 1]! - start;
    if (range && length > 0) intervals.push({ lo: start + length * range.lo, hi: start + length * range.hi });
  }
  return mergeIntervals(intervals);
}

function intersection(a: readonly ArcInterval[], b: readonly ArcInterval[]): ArcInterval[] {
  const out: ArcInterval[] = [];
  for (const first of a) for (const second of b) {
    const lo = Math.max(first.lo, second.lo), hi = Math.min(first.hi, second.hi);
    if (lo <= hi) out.push({ lo, hi });
  }
  return mergeIntervals(out);
}

function subtract(input: readonly ArcInterval[], covered: readonly ArcInterval[]): ArcInterval[] {
  let out = input.map(i => ({ ...i }));
  for (const cut of mergeIntervals(covered)) {
    const next: ArcInterval[] = [];
    for (const part of out) {
      if (cut.hi < part.lo || cut.lo > part.hi) next.push(part);
      else {
        if (cut.lo > part.lo) next.push({ lo: part.lo, hi: cut.lo });
        if (cut.hi < part.hi) next.push({ lo: cut.hi, hi: part.hi });
      }
    }
    out = next;
  }
  return mergeIntervals(out);
}

function dense(value: unknown): value is unknown[] {
  return Array.isArray(value) && Object.keys(value).length === value.length
    && Array.from({ length: value.length }, (_, i) => Object.hasOwn(value, i)).every(Boolean);
}

/** Compile only an explicit independent catalog. No route repair or nearest
 * pass assignment is imported. Omitted physical counterpasses stay unknown. */
export function compileCatalog(spec: RouteCatalogSpec, protocol: Readonly<Protocol> = DEFAULT_PROTOCOL): CompiledCatalog {
  assertProtocol(protocol);
  if (!spec || spec.v !== 1 || !Number.isSafeInteger(spec.routeId) || !isHash(spec.sourceTopologyHash)
    || typeof spec.pathProvenance !== 'string' || !spec.pathProvenance.trim()
    || !dense(spec.path) || spec.path.length < 3 || spec.path.length > protocol.maxCatalogVertices
    || !spec.path.every(isPoint) || !dense(spec.publishedStops) || spec.publishedStops.length < 1
    || !spec.publishedStops.every(Number.isSafeInteger) || !dense(spec.calls) || spec.calls.length > protocol.maxCatalogCalls)
    throw new Error('Invalid independent route catalog');
  const first = spec.path[0]!, last = spec.path.at(-1)!;
  if (first.lat !== last.lat || first.lon !== last.lon) throw new Error('Raw catalog path must be explicitly closed; no chord fallback');
  const path = spec.path.map(p => ({ lat: p.lat, lon: p.lon }));
  const cumulative = [0];
  for (let i = 1; i < path.length; i++) cumulative.push(cumulative[i - 1]! + distanceMeters(path[i - 1]!, path[i]!));
  const loopM = cumulative.at(-1)!;
  if (!Number.isFinite(loopM) || loopM <= 0) throw new Error('Independent route has no finite travel length');
  const base = { path, cumulative };
  const ids = new Set<string>(), published = new Set<number>(), compiled: CompiledCall[] = [];
  const coords = spec.stopCoords;
  for (const call of spec.calls) {
    if (!call || typeof call.id !== 'string' || !call.id || ids.has(call.id) || !Number.isSafeInteger(call.stopId)
      || !isPoint(coords?.[call.stopId]) || !['published-qualified', 'spur-qualified', 'unknown', 'traversal-only'].includes(call.service)
      || !dense(call.evidenceHashes) || !call.evidenceHashes.every(isHash) || !dense(call.masks))
      throw new Error('Invalid independent call mapping');
    ids.add(call.id);
    if (call.publishedIndex !== null) {
      if (!Number.isSafeInteger(call.publishedIndex) || call.publishedIndex < 0 || call.publishedIndex >= spec.publishedStops.length
        || spec.publishedStops[call.publishedIndex] !== call.stopId || published.has(call.publishedIndex)
        || !['published-qualified', 'unknown'].includes(call.service)) throw new Error('Published call identity changed or collapsed');
      published.add(call.publishedIndex);
    } else if (call.service === 'published-qualified') throw new Error('Published service needs its original index');
    if (call.service !== 'unknown' && !call.evidenceHashes.length) throw new Error('Qualified service/nonservice mapping requires independent evidence');
    const maskIntervals: ArcInterval[] = [];
    for (const mask of call.masks) {
      const lo = mask.from ?? 0, hi = mask.to ?? 1;
      if (!Number.isSafeInteger(mask.segment) || mask.segment < 0 || mask.segment + 1 >= path.length
        || !Number.isFinite(lo) || !Number.isFinite(hi) || lo < 0 || hi > 1 || lo > hi) throw new Error('Invalid raw segment mask');
      const start = cumulative[mask.segment]!, length = cumulative[mask.segment + 1]! - start;
      maskIntervals.push({ lo: start + length * lo, hi: start + length * hi });
    }
    const coord = { lat: coords[call.stopId]!.lat, lon: coords[call.stopId]!.lon };
    const physical = compatibleIntervals(base, coord, protocol.departureRearmM);
    const regions = intersection(physical, maskIntervals), components = circularComponents(regions, loopM);
    if (call.service !== 'unknown' && components.length !== 1) throw new Error('Qualified call must map to exactly one raw traversal region');
    compiled.push({ id: call.id, stopId: call.stopId, publishedIndex: call.publishedIndex, service: call.service,
      coord, regions, components, evidenceHashes: [...call.evidenceHashes], automatic: false });
  }
  if (published.size !== spec.publishedStops.length) throw new Error('Every original published occurrence must be retained');
  const targetIds = [...new Set([...spec.publishedStops, ...compiled.map(c => c.stopId)])].sort((a, b) => a - b);
  for (const stopId of targetIds) {
    const coord = coords[stopId];
    if (!isPoint(coord)) throw new Error('Missing original stop coordinate');
    const physical = compatibleIntervals(base, coord, protocol.departureRearmM);
    const covered = compiled.filter(c => c.stopId === stopId).flatMap(c => c.regions);
    const missing = subtract(physical, covered);
    for (const [index, component] of circularComponents(missing, loopM).entries()) {
      const id = `unknown:${stopId}:${index}:${sha256(canonicalJSON(component)).slice(0, 16)}`;
      if (ids.has(id)) throw new Error('Reserved automatic unknown occurrence ID');
      ids.add(id);
      const regions = component.hi > loopM
        ? [{ lo: component.lo, hi: loopM }, { lo: 0, hi: component.hi - loopM }] : [{ ...component }];
      compiled.push({ id, stopId, publishedIndex: null, service: 'unknown', coord: { lat: coord.lat, lon: coord.lon }, regions,
        components: [{ ...component }], evidenceHashes: [], automatic: true });
    }
  }
  if (compiled.length > protocol.maxCatalogCalls) throw new Error('Independent catalog call capacity exceeded');
  const catalogHash = sha256(canonicalJSON({ v: 1, protocolHash: PROTOCOL_SHA256, spec, calls: compiled, cumulative }));
  return deepFreeze({ v: 1, routeId: spec.routeId, catalogHash, sourceTopologyHash: spec.sourceTopologyHash,
    path, cumulative, loopM, publishedStops: [...spec.publishedStops], calls: compiled }) as CompiledCatalog;
}
