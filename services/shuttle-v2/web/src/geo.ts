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
export function buildStopSequencePolyline(
  path: [number, number][] | undefined, stops: LatLon[] | undefined,
): [number, number][] | undefined {
  if (!path || path.length < 2 || !stops || stops.length < 2) return undefined;
  // Trace the route polyline in travel order: anchor the first stop globally,
  // then walk forward stop-by-stop. Forward matching keeps the indices
  // monotonic, so the "ride" line follows the actual streets between board and
  // alight without grabbing the wrong loop occurrence (which produced straight
  // cross-cuts and ~7 km southern detours on Green).
  let cursor = nearestPathIdx(path, stops[0]);
  const out: [number, number][] = [];
  for (let s = 1; s < stops.length; s++) {
    const nextIdx = forwardNearestIdx(path, stops[s], cursor);
    let slice = nextIdx >= cursor
      ? path.slice(cursor, nextIdx + 1)
      : [...path.slice(cursor), ...path.slice(0, nextIdx + 1)];
    // Degenerate match (same index) — bridge with a straight segment so the
    // line never silently vanishes.
    if (slice.length < 2) slice = [path[cursor], path[nextIdx]];

    // Validate THIS leg before accepting it. Two consecutive stops are a block
    // or two apart; the road between them wanders, but not several times the
    // straight-line distance. When it does, `nextIdx` matched the wrong point
    // and the wrap branch above has just appended most of the loop.
    //
    // Checking per leg rather than per trace matters: the failure is local, so
    // discarding the whole trace throws away every good leg with it. Bridging
    // only the bad leg keeps real road geometry everywhere else.
    const legDirect = haversineMeters(stops[s - 1], stops[s]);
    if (polylineMeters(slice) > Math.max(MIN_LEG_ALLOWANCE_M, legDirect * MAX_LEG_DETOUR)) {
      slice = [
        [stops[s - 1].lat, stops[s - 1].lon],
        [stops[s].lat, stops[s].lon],
      ];
    }

    if (s === 1) out.push(...slice);
    else out.push(...slice.slice(1)); // dedupe junction point
    cursor = nextIdx;
  }
  if (out.length < 2) return undefined;

  // Sanity-check the trace before trusting it.
  //
  // Tracing assumes the polyline is fine-grained enough that each stop maps to
  // a distinct, monotonically advancing point on it. Several upstream polylines
  // are not: Orange Night publishes 37 points for 26 stops (227 m median
  // spacing), so stops land 380-430 m from the nearest point, four of them
  // collapse onto the same index, and the mapping inverts. Each inversion takes
  // the wrap branch above and appends most of the loop, which rendered as the
  // whole route drawn solid in the rider's colour — measured at a median 83% of
  // the loop for Orange Night and up to 400% for Green.
  //
  // No threshold tuning fixes that, because the resolution simply is not there.
  // So compare what we traced against the straight-line path through the same
  // stops: a real road route wanders, but not several times further than the
  // stops themselves. Beyond that, the trace is wrong, and returning undefined
  // makes the caller fall back to straight segments between stops — visibly
  // simpler, but honest about where the bus goes.
  const traced = polylineMeters(out);
  const direct = polylineMeters(stops.map((c) => [c.lat, c.lon] as [number, number]));
  if (direct > 0 && traced > direct * MAX_TRACE_DETOUR) return undefined;
  return out;
}

/**
 * How far a single leg's traced road may exceed the straight line between its
 * two stops before we stop believing it. Real routes measure ~1.1-1.4x.
 */
const MAX_LEG_DETOUR = 2;

/**
 * Floor for the above, so a pair of stops 40 m apart is still allowed to go
 * around a block instead of being flattened to a straight line.
 */
const MIN_LEG_ALLOWANCE_M = 250;

/**
 * Backstop on the assembled ride. Per-leg checking catches the failure at
 * source, so this rarely fires — it exists for a shape the per-leg rule cannot
 * see, e.g. many legs each individually plausible but collectively absurd.
 */
const MAX_TRACE_DETOUR = 2.5;

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
