/**
 * Road length of each hop of a route, along the published polyline.
 *
 * MIRRORS `web/src/geo.ts` — `haversineMeters`, `polylineMeters`,
 * `traceStopLegs` and the helpers they need are copied verbatim, because the
 * server and the client must measure the SAME metres: the calibrator prices a
 * route's pace in seconds per road metre (`computePace`), serves each hop's
 * length as `segments[r]["A-B"].legM`, and the client's ring estimator cuts
 * that same leg into cells with its own copy of the tracer. `legs.test.ts`
 * pins the two copies to identical output on a checked-in route, so a change
 * to one side that is not made to the other fails the suite.
 *
 * Why road and not chord: the chord under-prices a winding hop. Measured over
 * the published lines, road/chord runs to a p90 of 1.9 on Red and 4.8 on Blue
 * Night; a pace pooled over chord metres then mixes "a straight hop" and "a
 * hop round three sides of a block" as if they were the same speed.
 *
 * Nothing here reads the database or the network class; it is geometry only.
 */

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
 * A published polyline only needs a vertex where the road turns, so a stop
 * mid-block can be hundreds of metres from the nearest vertex while sitting
 * right on the line (see web/src/geo.ts for the history).
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

/** One traced leg, and whether the route line could actually supply it. */
export interface TracedLeg { slice: [number, number][]; bridged: boolean }

/**
 * The share of the whole loop a single leg may cover before it is certainly a
 * wrap rather than a leg. Set from the routes (longest legitimate leg 51.7% of
 * its loop, a wrap 88%+); see web/src/geo.ts for both edges.
 */
const MAX_LEG_LOOP_FRACTION = 0.7;

/**
 * The legs between consecutive stops, in travel order. A leg the line cannot
 * supply (the forward walk wrapped) is a straight `bridged` chord instead.
 */
export function traceStopLegs(
  path: [number, number][] | undefined, stops: LatLon[] | undefined,
): TracedLeg[] {
  if (!path || path.length < 2 || !stops || stops.length < 2) return [];
  const legs: TracedLeg[] = [];
  const loopM = polylineMeters(path);
  let cursor = forwardProject(path, stops[0]!, 0);
  for (let s = 1; s < stops.length; s++) {
    const next = forwardProject(path, stops[s]!, cursor.seg);
    let slice = sliceBetween(path, cursor, next);
    let bridged = false;
    if (slice.length < 2 || polylineMeters(slice) > loopM * MAX_LEG_LOOP_FRACTION) {
      slice = [
        [stops[s - 1]!.lat, stops[s - 1]!.lon],
        [stops[s]!.lat, stops[s]!.lon],
      ];
      bridged = true;
    }
    legs.push({ slice, bridged });
    cursor = next;
  }
  return legs;
}

export function polylineMeters(pts: readonly [number, number][]): number {
  let m = 0;
  for (let i = 1; i < pts.length; i++) {
    m += haversineMeters(
      { lat: pts[i - 1]![0], lon: pts[i - 1]![1] },
      { lat: pts[i]![0], lon: pts[i]![1] },
    );
  }
  return m;
}

// -- Server-side convenience (not in web/src/geo.ts) --------------------------

/**
 * Road metres of every hop of a LOOP: entry i is the leg from `stops[i]` to
 * `stops[(i + 1) % n]`, traced along `path` exactly as the client's ring
 * estimator traces it (the sequence closed back onto its first stop). `null`
 * where the line could not supply the leg (bridged) — the caller falls back to
 * the chord there rather than pricing a straight line as road. An unusable
 * path or a sequence under two stops yields all nulls.
 */
export function routeLegMeters(
  path: readonly (readonly [number, number])[] | undefined, stops: readonly LatLon[],
): (number | null)[] {
  const n = stops.length;
  const out: (number | null)[] = new Array<number | null>(n).fill(null);
  if (!path || path.length < 2 || n < 2) return out;
  const legs = traceStopLegs(path as [number, number][], [...stops, stops[0]!]);
  if (legs.length !== n) return out;
  for (let i = 0; i < n; i++) {
    const l = legs[i]!;
    if (!l.bridged) out[i] = polylineMeters(l.slice);
  }
  return out;
}
