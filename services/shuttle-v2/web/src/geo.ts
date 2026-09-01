// Pure geometry helpers shared by the planner, the arrivals board and the
// map layers. Extracted from TransitMap.tsx so the maths is reachable from
// tests without mounting React or Leaflet — behaviour is unchanged.

export type LatLon = { lat: number; lon: number };

export function haversineMeters(a: LatLon, b: LatLon): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const la1 = toRad(a.lat);
  const la2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Fraction of the way from a to b that p projects onto (0 = at a, 1 = at b).
// Values outside [0, 1] mean p sits beyond an endpoint. Projecting onto the
// segment axis is what makes the anchor stable against perpendicular GPS
// jitter. Straight-line distance comparisons aren't robust: a bus at the
// midpoint flips "closer to A" vs "closer to B" on noise, wrecking both
// anchor-advance and mid-segment proration.
export function progressAlongSegment(p: LatLon, a: LatLon, b: LatLon): number {
  const meanLat = ((a.lat + b.lat) / 2) * Math.PI / 180;
  const scale = Math.cos(meanLat);
  const ax = a.lon * scale, ay = a.lat;
  const bx = b.lon * scale, by = b.lat;
  const px = p.lon * scale, py = p.lat;
  const dx = bx - ax, dy = by - ay;
  const denom = dx * dx + dy * dy;
  if (denom < 1e-12) return 0;
  return ((px - ax) * dx + (py - ay) * dy) / denom;
}

// Distance from a point to a line segment, in meters (flat-earth
// approximation adequate for intra-campus distances). Unlike the line
// distance, this clamps projection to [0, 1] — points past either
// endpoint return distance to that endpoint, not some imagined
// perpendicular into the wrong direction.
export function distanceToSegmentM(p: LatLon, a: LatLon, b: LatLon): number {
  const t = Math.max(0, Math.min(1, progressAlongSegment(p, a, b)));
  const projLat = a.lat + (b.lat - a.lat) * t;
  const projLon = a.lon + (b.lon - a.lon) * t;
  const dlat = (p.lat - projLat) * 111_000;
  const dlon = (p.lon - projLon) * 84_000;
  return Math.sqrt(dlat * dlat + dlon * dlon);
}

export function nearestPathIdx(path: [number, number][], t: LatLon): number {
  let bestIdx = 0, best = Infinity;
  for (let i = 0; i < path.length; i++) {
    const d = (path[i][0] - t.lat) ** 2 + (path[i][1] - t.lon) ** 2;
    if (d < best) { best = d; bestIdx = i; }
  }
  return bestIdx;
}
// The first close approach to `t` scanning FORWARD from `startIdx` (wrapping
// once around the loop). Self-overlapping loops (e.g. Green revisits the
// campus on its way back from the southern Buildings detour) pass within
// metres of the same stop twice; the globally-nearest point can land on the
// LATER pass, which is what made slices balloon south and double back. By
// taking the first pass we reach travelling forward, the slice stays on the
// arc the bus actually drives between the two stops.
function forwardNearestIdx(path: [number, number][], t: LatLon, startIdx: number): number {
  const n = path.length;
  let bestIdx = -1, bestM = Infinity;
  let arrived = false;
  for (let step = 1; step <= n; step++) {
    const i = (startIdx + step) % n;
    const m = haversineMeters({ lat: path[i][0], lon: path[i][1] }, t);
    if (m < bestM) { bestM = m; bestIdx = i; }
    if (m <= 60) arrived = true;
    // Once we've made our closest approach on this pass and started pulling
    // away again, stop — don't roll into a later pass through the same area.
    if (arrived && m > bestM + 80 && bestIdx !== -1) break;
  }
  return bestIdx === -1 ? startIdx : bestIdx;
}
/**
 * Where a stop sits ON the route line, as a position along it.
 *
 * `seg + t` is a linear coordinate: segment index plus the fraction along it,
 * so positions compare and subtract like distances-along-the-route.
 */
interface PathPos { seg: number; t: number; lat: number; lon: number; m: number }

/** Project a point onto one segment, in local metres. */
function projectSeg(a: [number, number], b: [number, number], p: LatLon): { t: number; lat: number; lon: number; m: number } {
  const kx = 111_320 * Math.cos((p.lat * Math.PI) / 180);
  const ky = 111_320;
  const ax = a[1] * kx, ay = a[0] * ky;
  const bx = b[1] * kx, by = b[0] * ky;
  const px = p.lon * kx, py = p.lat * ky;
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 < 1e-9 ? 0 : ((px - ax) * dx + (py - ay) * dy) / l2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const lat = a[0] + (b[0] - a[0]) * t;
  const lon = a[1] + (b[1] - a[1]) * t;
  return { t, lat, lon, m: haversineMeters({ lat, lon }, p) };
}

/**
 * The first place, travelling forward from `fromSeg`, where the line comes
 * closest to `stop` — projected onto the SEGMENTS, not snapped to a vertex.
 *
 * Snapping to vertices was the bug behind every straight diagonal. A published
 * polyline only needs a vertex where the road turns, so a stop mid-block can be
 * hundreds of metres from the nearest vertex while sitting right on the line:
 * on Orange Night the median stop is 97 m from a vertex and 6 m from the line.
 * Slicing between vertices therefore measured the wrong distance, mis-ordered
 * stops that shared a vertex, and wrapped — dragging in most of the loop, which
 * the length guard then replaced with a straight line through the buildings.
 *
 * Yale's own map draws these same published lines correctly, which was the
 * clue: the geometry was never coarse, the consumer was.
 */
function forwardProject(path: [number, number][], stop: LatLon, fromSeg: number): PathPos {
  const n = path.length;
  let best: PathPos | null = null;
  let arrived = false;
  for (let step = 0; step < n; step++) {
    const i = (fromSeg + step) % n;
    const a = path[i]!;
    const b = path[(i + 1) % n]!;
    const r = projectSeg(a, b, stop);
    if (!best || r.m < best.m) best = { seg: i, t: r.t, lat: r.lat, lon: r.lon, m: r.m };
    if (r.m <= 60) arrived = true;
    // Once past the closest approach on this pass, stop — do not roll on into a
    // later pass through the same area. Routes 9 and 10 visit West Campus stops
    // twice and the second pass is a different leg.
    if (arrived && best && r.m > best.m + 80) break;
  }
  return best ?? { seg: fromSeg, t: 0, lat: path[fromSeg]![0], lon: path[fromSeg]![1], m: Infinity };
}

/** The piece of the line between two positions, following travel order. */
function sliceBetween(path: [number, number][], from: PathPos, to: PathPos): [number, number][] {
  const n = path.length;
  const out: [number, number][] = [[from.lat, from.lon]];
  const sameSeg = from.seg === to.seg && to.t >= from.t;
  if (!sameSeg) {
    let i = (from.seg + 1) % n;
    for (let guard = 0; guard <= n; guard++) {
      out.push([path[i]![0], path[i]![1]]);
      if (i === to.seg) break;
      i = (i + 1) % n;
    }
  }
  out.push([to.lat, to.lon]);
  return out;
}

/** One drawn leg, and whether the route line could actually supply it. */
export interface TracedLeg { slice: [number, number][]; bridged: boolean }

/**
 * The legs between consecutive stops, in travel order. Exported so the drawn
 * result can be measured leg-by-leg — "how often do we give up on the route and
 * draw a straight line through the buildings" is the number that matters, and
 * it is not visible in the concatenated polyline.
 */
export function traceStopLegs(
  path: [number, number][] | undefined, stops: LatLon[] | undefined,
): TracedLeg[] {
  if (!path || path.length < 2 || !stops || stops.length < 2) return [];
  const legs: TracedLeg[] = [];
  const loopM = polylineMeters(path);
  let cursor = forwardProject(path, stops[0], 0);
  for (let s = 1; s < stops.length; s++) {
    const next = forwardProject(path, stops[s], cursor.seg);
    let slice = sliceBetween(path, cursor, next);
    let bridged = false;

    // Backstop, not the mechanism, and deliberately loose.
    //
    // The old rule — a leg may not exceed twice the straight line between its
    // stops — was measuring the wrong thing. On Purple's West Campus
    // out-and-back the route genuinely doubles back, so consecutive stops sit
    // close together while the road between them runs out to the turnaround and
    // returns. That is real route, and the rule was replacing it with a chord
    // through the water: only 73% of Purple's drawn metres landed on a
    // published street, one of them 1,151 m off.
    //
    // What is actually wrong is a leg that wrapped: the forward walk missed its
    // stop and carried on round the loop. That is bounded by geometry, not by a
    // tuned ratio — no leg between two consecutive stops covers half the loop.
    if (slice.length < 2 || polylineMeters(slice) > loopM * MAX_LEG_LOOP_FRACTION) {
      slice = [
        [stops[s - 1].lat, stops[s - 1].lon],
        [stops[s].lat, stops[s].lon],
      ];
      bridged = true;
    }
    legs.push({ slice, bridged });
    cursor = next;
  }
  return legs;
}

export function buildStopSequencePolyline(
  path: [number, number][] | undefined, stops: LatLon[] | undefined,
): [number, number][] | undefined {
  const legs = traceStopLegs(path, stops);
  if (legs.length === 0) return undefined;
  const out: [number, number][] = [];
  for (let i = 0; i < legs.length; i++) {
    const slice = legs[i]!.slice;
    if (i === 0) out.push(...slice);
    else out.push(...slice.slice(1)); // dedupe junction point
  }
  if (out.length < 2) return undefined;

  // No whole-ride backstop any more. It compared the traced ride against the
  // straight line through its stops and discarded anything past 2.5x — which
  // an out-and-back exceeds by construction, so it was throwing away 38 of 822
  // correct rides and drawing them as chords instead. It existed to catch a
  // tracer that could wander; this one cannot, because every leg it emits is
  // either a slice of the published route or a bounded straight bridge.
  return out;
}

/**
 * How close an intermediate stop may come to the board or alight stop before
 * its dot is dropped as a duplicate. Well under the 28 m between College/Wall
 * (N) and (S) — two genuinely different stops that both deserve a dot — so
 * only a stop the ride literally calls at twice is filtered out.
 */
const RIDE_DOT_ENDPOINT_M = 8;

/**
 * The stops a rider passes between boarding and getting off, i.e. everything
 * the ride calls at that is not an endpoint. Drawn as small faded dots on the
 * trip map so "which stops are along this route" is answerable there and not
 * only in the list below it (report #47). The board/alight rings stay
 * dominant — these are ornaments, not markers.
 *
 * Routes 9 and 10 repeat stops for the West Campus out-and-back, so a ride can
 * pass its own board or alight stop mid-segment; such a dot would sit under a
 * ring and muddy it, so it is dropped.
 */
export function rideStopDots(segCoords: readonly LatLon[]): LatLon[] {
  if (segCoords.length < 3) return [];
  const board = segCoords[0]!;
  const alight = segCoords[segCoords.length - 1]!;
  return segCoords.slice(1, -1).filter(
    (s) => haversineMeters(s, board) >= RIDE_DOT_ENDPOINT_M
      && haversineMeters(s, alight) >= RIDE_DOT_ENDPOINT_M,
  );
}

/**
 * The share of the whole loop a single leg may cover before it is certainly a
 * wrap rather than a leg.
 *
 * Set from the routes, not from intuition, and there is a wide gap to sit in.
 * Measured across all 15 published lines, the longest legitimate leg is 51.7%
 * of the loop (Grocery TJ, five stops far apart); most are under 20%. A leg
 * produced by a wrap is 88% or more, because it covers everything except the
 * hop it should have drawn — Green's one bad leg measures 98.2%.
 *
 * Both edges matter. At 0.5 the bound cut Grocery TJ's real legs and drew a
 * 1,567 m line across open water; at 0.9 it stopped catching a line published
 * in the wrong direction, which draws 88% of the loop for every leg and is the
 * "whole route painted solid" bug the rider first reported.
 */
const MAX_LEG_LOOP_FRACTION = 0.7;

export function polylineMeters(pts: readonly [number, number][]): number {
  let m = 0;
  for (let i = 1; i < pts.length; i++) {
    m += haversineMeters(
      { lat: pts[i - 1][0], lon: pts[i - 1][1] },
      { lat: pts[i][0], lon: pts[i][1] },
    );
  }
  return m;
}
