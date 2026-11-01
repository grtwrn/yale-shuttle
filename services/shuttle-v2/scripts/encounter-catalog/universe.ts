import { canonicalJSON, sha256 } from '../encounter-proxy/canonical.js';
import { circularComponents, compatibleIntervals, distanceMeters } from '../encounter-proxy/catalog.js';
import { DEFAULT_PROTOCOL } from '../encounter-proxy/protocol.js';
import type { ArcInterval } from '../encounter-proxy/types.js';
import { LimitRefusal, type ArtifactChannel, type AuditRecord, type Caps, type CatalogInput,
  type Component, type Orientation, type SegmentFraction } from './types.js';

export interface Universe { loopM: number; cumulative: number[]; components: Component[] }

export function buildUniverse(input: CatalogInput, caps: Caps,
  emit: (channel: ArtifactChannel, record: AuditRecord) => void, step: () => void): Universe {
  const cumulative = [0];
  for (let segment = 0; segment + 1 < input.path.length; segment++) {
    step();
    const length = distanceMeters(input.path[segment]!, input.path[segment + 1]!);
    cumulative.push(cumulative.at(-1)! + length);
  }
  const loopM = cumulative.at(-1)!;
  if (!Number.isFinite(loopM) || loopM <= 0) throw new LimitRefusal('unresolved-loop-geometry');
  emit('component-universe', { kind: 'raw-loop', data: { loopM, cumulative } });
  const components: Component[] = [];
  for (const curb of input.curbs) {
    const pieces: { segment: number; range: ArcInterval; fraction: SegmentFraction }[] = [];
    for (let segment = 0; segment + 1 < input.path.length; segment++) {
      step();
      const lo = cumulative[segment]!, hi = cumulative[segment + 1]!, length = hi - lo;
      // Reuse exactly the independent R3 primitive, with original cumulative
      // coordinates, so no geographic nearest-pass selection is introduced.
      const ranges = compatibleIntervals({ path: [input.path[segment]!, input.path[segment + 1]!], cumulative: [lo, hi] },
        curb.coord, DEFAULT_PROTOCOL.departureRearmM);
      const range = ranges[0] ?? null;
      const fraction = range && length > 0 ? { segment, from: (range.lo - lo) / length, to: (range.hi - lo) / length } : null;
      emit('component-universe', { kind: 'segment-region', data: { stopId: curb.stopId, segment, range, fraction } });
      if (range && fraction) pieces.push({ segment, range, fraction });
    }
    const regions = circularComponents(pieces.map(piece => piece.range), loopM);
    for (const [index, original] of regions.entries()) {
      step();
      if (components.length >= caps.maxCandidateComponents) throw new LimitRefusal('component-cap');
      const arc = original.lo >= loopM ? { lo: original.lo - loopM, hi: original.hi - loopM } : original;
      if (![arc.lo, arc.hi].every(Number.isFinite) || arc.lo < 0 || arc.lo >= loopM || arc.hi < arc.lo
        || arc.hi > arc.lo + loopM) throw new LimitRefusal('unresolved-component-geometry');
      const segments = pieces.filter(piece => [-1, 0, 1].some(lift =>
        piece.range.lo + lift * loopM <= arc.hi && piece.range.hi + lift * loopM >= arc.lo)).map(piece => piece.fraction);
      const id = `component:${curb.stopId}:${index}:${sha256(canonicalJSON({ arc, segments })).slice(0, 16)}`;
      const component = { id, stopId: curb.stopId, arc, segments, degenerate: arc.lo === arc.hi || arc.hi - arc.lo >= loopM };
      components.push(component);
      emit('component-universe', { kind: 'component', data: component });
    }
  }
  return { loopM, cumulative, components };
}

export function orientedInterval(component: Component, orientation: Orientation, loopM: number): ArcInterval {
  if (orientation === 'forward') return { ...component.arc };
  let lo = loopM - component.arc.hi, hi = loopM - component.arc.lo;
  if (lo < 0) { lo += loopM; hi += loopM; }
  if (lo >= loopM) { lo -= loopM; hi -= loopM; }
  if (![lo, hi].every(Number.isFinite) || lo < 0 || lo >= loopM || hi < lo || hi > lo + loopM)
    throw new LimitRefusal('unresolved-orientation-geometry');
  return { lo, hi };
}
