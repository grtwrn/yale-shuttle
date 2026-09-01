/**
 * Route geometry derived from where buses actually drove.
 *
 * Upstream publishes a `path` per route, but several are far too coarse to be
 * usable: Orange Night ships 37 points for a 9.5 km loop with 26 stops, so a
 * stop sits a median 97 m from the nearest point on its own route line (max
 * 428 m). Anything that tries to locate a stop on that line — which is how the
 * map draws the segment a rider actually rides — is guessing, and the guesses
 * showed up as a solid line covering most of the route, then as straight
 * diagonals cutting across blocks once that was guarded against.
 *
 * We do not have to guess. The collector already stores every bus position it
 * polls, so for any route that has run recently there are thousands of real
 * points along the actual roads: 5,649 for Orange Night in a 7.5 h window,
 * against upstream's 37. Deriving the line from those measures a stop at a
 * median 24 m from its route — four times closer, and inside the tolerance the
 * rest of the code already assumes.
 *
 * The work here is turning a bag of positions from several buses over several
 * laps into ONE ordered loop:
 *
 *   1. Split by bus and order by time — that alone gives ordered traces.
 *   2. Find the shortest contiguous window of a trace that passes near EVERY
 *      stop on the route. A minimal covering window is one lap by construction,
 *      and it naturally excludes deadheads and depot runs, which never cover
 *      the whole route.
 *   3. Close the loop by extending until the bus returns to where the window
 *      began, because downstream code treats a route path as circular.
 *   4. Simplify, so we store a few hundred points rather than a few thousand.
 *
 * A derived path is only offered if it is measurably better than upstream's on
 * the one thing that matters — how close the stops sit to it.
 */

import { distanceMeters, type LatLon } from "./geo.js";

export interface Sample extends LatLon {
  busId: number;
  collectedAt: number;
}

export interface DerivedPath {
  path: [number, number][];
  /** Stops whose distance to the line we measured, and how far they sat. */
  stopCount: number;
  medianStopM: number;
  /**
   * The tail matters more than the middle. A route line is used to locate each
   * stop on it, so one stop sitting 280 m away breaks that leg's geometry even
   * when the typical stop is a comfortable 35 m — which is exactly Pink's
   * upstream path.
   */
  p90StopM: number;
  maxStopM: number;
  /** Metres of road the loop covers. */
  lengthM: number;
  busId: number;
}

/** How close a position must pass to count as covering a stop. */
const COVERAGE_M = 60;
/** How close the trace must return to the window start to call the loop closed. */
const CLOSE_M = 90;
/** Ignore traces shorter than this — not enough to be a lap. */
const MIN_SAMPLES = 60;
/** A lap shorter than this is a data artefact, not a route. */
const MIN_LOOP_M = 1500;
/** Guard against a "lap" that is really several laps plus a depot run. */
const MAX_LOOP_M = 80_000;
/**
 * Douglas-Peucker tolerance in degrees. ~2e-5 deg is roughly 2 m at this
 * latitude — fine enough that simplification cannot move the line off its
 * street, coarse enough to cut thousands of points to a few hundred.
 */
const SIMPLIFY_EPS = 0.00002;

/** A vertex further than this from both the published line and every stop is
 *  off-route; a stretch of them longer than MAX is a deadhead, not the route. */
const EXCURSION_OFF_M = 250;
const EXCURSION_MAX_M = 600;

/** Perpendicular distance from p to segment a-b, in degrees. */
function perpDeg(p: [number, number], a: [number, number], b: [number, number]): number {
  const x = b[1] - a[1];
  const y = b[0] - a[0];
  const len = Math.hypot(x, y);
  if (len < 1e-12) return Math.hypot(p[1] - a[1], p[0] - a[0]);
  return Math.abs((p[1] - a[1]) * y - (p[0] - a[0]) * x) / len;
}

/** Ramer-Douglas-Peucker, iterative so a long trace cannot blow the stack. */
export function simplify(points: readonly [number, number][], eps: number): [number, number][] {
  if (points.length < 3) return [...points];
  const keep = new Array<boolean>(points.length).fill(false);
  keep[0] = true;
  keep[points.length - 1] = true;
  const stack: Array<[number, number]> = [[0, points.length - 1]];
  while (stack.length) {
    const [lo, hi] = stack.pop()!;
    let maxD = 0;
    let idx = -1;
    for (let i = lo + 1; i < hi; i++) {
      const d = perpDeg(points[i]!, points[lo]!, points[hi]!);
      if (d > maxD) {
        maxD = d;
        idx = i;
      }
    }
    if (idx !== -1 && maxD > eps) {
      keep[idx] = true;
      stack.push([lo, idx], [idx, hi]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

function pathLengthM(points: readonly [number, number][]): number {
  let m = 0;
  for (let i = 1; i < points.length; i++) {
    m += distanceMeters(
      { lat: points[i - 1]![0], lon: points[i - 1]![1] },
      { lat: points[i]![0], lon: points[i]![1] },
    );
  }
  return m;
}

/** Distance from every stop to the nearest point on `path`. */
export function stopDistances(
  path: readonly [number, number][], stops: readonly LatLon[],
): number[] {
  return stops.map((s) => {
    let best = Infinity;
    for (const p of path) {
      const d = distanceMeters({ lat: p[0], lon: p[1] }, s);
      if (d < best) best = d;
    }
    return best;
  });
}

/**
 * How far from BOTH the stops and the published line a derived path strays, as
 * the length of the longest contiguous stretch that is off both.
 *
 * This exists because of Blue Night. Both its buses drive 2.1 km north, once an
 * hour all evening, up to 996 m from the published line, past none of the
 * route's 20 stops — a layover/relief run. It is real, repeated driving, so
 * every measure of "did the buses go here" says yes; the two buses' laps agree
 * to within a metre, which is why cross-bus agreement cannot catch it either.
 *
 * What separates it from route is purpose, and purpose shows up as: nobody
 * could board there, and the operator never published it. A genuine long hop
 * (routes 9 and 10 run kilometres to West Campus without an intermediate stop)
 * stays close to the published line, so it is not caught by this.
 */
export function deadheadExcursionM(
  path: readonly [number, number][],
  upstream: readonly [number, number][] | undefined,
  stops: readonly LatLon[],
): number {
  if (!upstream || upstream.length < 2) return 0; // nothing to judge against
  let worst = 0;
  let run = 0;
  for (let i = 0; i < path.length; i++) {
    const here = { lat: path[i]![0], lon: path[i]![1] };
    const offRoute =
      nearestM(here, upstream) > EXCURSION_OFF_M &&
      Math.min(...stops.map((t) => distanceMeters(here, t))) > EXCURSION_OFF_M;
    if (offRoute && i > 0) {
      run += distanceMeters({ lat: path[i - 1]![0], lon: path[i - 1]![1] }, here);
      if (run > worst) worst = run;
    } else {
      run = 0;
    }
  }
  return worst;
}

/**
 * Simplify, but never let a stop's own vertex be smoothed away.
 *
 * The consumer (`buildStopSequencePolyline`) snaps each stop to the nearest
 * VERTEX and slices between the two indices, so two stops that collapse onto a
 * shared vertex produce a leg of zero length — the ride line simply vanishes on
 * that hop. Plain Douglas-Peucker did that to 1-6 legs per route, because the
 * points near a stop are exactly the slow, bunched, nearly-collinear ones it is
 * designed to discard.
 *
 * So the line is cut at each stop's closest point and each piece simplified on
 * its own. Every stop keeps a vertex of its own; everything between them still
 * gets thinned.
 */
export function simplifyKeepingStops(
  points: readonly [number, number][],
  eps: number,
  stops: readonly LatLon[],
): [number, number][] {
  if (points.length < 3) return [...points];

  const anchors = new Set<number>([0, points.length - 1]);
  for (const stop of stops) {
    let bestI = 0;
    let best = Infinity;
    for (let i = 0; i < points.length; i++) {
      const d = distanceMeters({ lat: points[i]![0], lon: points[i]![1] }, stop);
      if (d < best) { best = d; bestI = i; }
    }
    anchors.add(bestI);
  }

  const cuts = [...anchors].sort((a, b) => a - b);
  const out: [number, number][] = [];
  for (let k = 0; k < cuts.length - 1; k++) {
    const piece = simplify(points.slice(cuts[k]!, cuts[k + 1]! + 1), eps);
    out.push(...(k === 0 ? piece : piece.slice(1)));
  }
  return out;
}

/** Distance from a point to the nearest vertex of a line. */
function nearestM(p: LatLon, line: readonly [number, number][]): number {
  let best = Infinity;
  for (const q of line) {
    const d = distanceMeters(p, { lat: q[0], lon: q[1] });
    if (d < best) best = d;
  }
  return best;
}

const quantile = (xs: readonly number[], q: number): number => {
  if (xs.length === 0) return Infinity;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))]!;
};
const median = (xs: readonly number[]): number => quantile(xs, 0.5);

/**
 * Derive one route's loop from observed positions.
 *
 * `stops` is the route's unique stop coordinates. Returns null when the
 * observations do not contain a single lap covering every stop — which is the
 * correct answer for a route that has not run recently, or has run only
 * partially inside the retention window.
 */
export function derivePath(samples: readonly Sample[], stops: readonly LatLon[]): DerivedPath | null {
  if (stops.length < 2 || samples.length < MIN_SAMPLES) return null;

  const byBus = new Map<number, Sample[]>();
  for (const s of samples) {
    const list = byBus.get(s.busId);
    if (list) list.push(s);
    else byBus.set(s.busId, [s]);
  }

  let best: DerivedPath | null = null;

  for (const trace of byBus.values()) {
    if (trace.length < MIN_SAMPLES) continue;
    trace.sort((a, b) => a.collectedAt - b.collectedAt);

    // Which stops each position covers. Most positions cover none.
    const covers: number[][] = trace.map((p) => {
      const hit: number[] = [];
      for (let si = 0; si < stops.length; si++) {
        if (distanceMeters(p, stops[si]!) <= COVERAGE_M) hit.push(si);
      }
      return hit;
    });

    // Shortest window covering every stop — one lap, by construction.
    const need = stops.length;
    const count = new Array<number>(stops.length).fill(0);
    let have = 0;
    let lo = 0;
    let bestLo = -1;
    let bestHi = -1;
    for (let hi = 0; hi < trace.length; hi++) {
      for (const si of covers[hi]!) {
        if ((count[si] = (count[si] ?? 0) + 1) === 1) have++;
      }
      while (have === need) {
        if (bestLo === -1 || hi - lo < bestHi - bestLo) {
          bestLo = lo;
          bestHi = hi;
        }
        for (const si of covers[lo]!) {
          if ((count[si] = (count[si] ?? 0) - 1) === 0) have--;
        }
        lo++;
      }
    }
    if (bestLo === -1) continue; // this bus never covered the whole route

    // Close the loop: keep going until it returns to where the window started.
    let end = bestHi;
    for (let i = bestHi + 1; i < trace.length; i++) {
      end = i;
      if (distanceMeters(trace[i]!, trace[bestLo]!) <= CLOSE_M) break;
    }

    const raw = trace.slice(bestLo, end + 1).map((p) => [p.lat, p.lon] as [number, number]);
    const lengthM = pathLengthM(raw);
    if (lengthM < MIN_LOOP_M || lengthM > MAX_LOOP_M) continue;

    const path = simplifyKeepingStops(raw, SIMPLIFY_EPS, stops);
    if (path.length < 8) continue;

    const dists = stopDistances(path, stops);
    const candidate: DerivedPath = {
      path,
      stopCount: stops.length,
      medianStopM: Math.round(median(dists)),
      p90StopM: Math.round(quantile(dists, 0.9)),
      maxStopM: Math.round(Math.max(...dists)),
      lengthM: Math.round(lengthM),
      busId: trace[0]!.busId,
    };
    // Select on the TAIL, not the middle: a lap that leaves one stop stranded
    // is worse than one that sits slightly further from all of them. Ties break
    // on brevity, which favours a clean lap over a lap plus a detour.
    if (
      best === null ||
      candidate.p90StopM < best.p90StopM ||
      (candidate.p90StopM === best.p90StopM && candidate.lengthM < best.lengthM)
    ) {
      best = candidate;
    }
  }

  return best;
}

/**
 * Whether a derived path should replace the published one.
 *
 * Judged on the only thing the drawing code needs: how close stops sit to the
 * line. Requires a clear margin rather than any improvement, so a marginally
 * better derivation does not churn geometry that already works.
 */
export function isBetterThanUpstream(
  derived: DerivedPath,
  upstream: readonly [number, number][] | undefined,
  stops: readonly LatLon[],
  /**
   * The route's ordered stop sequence. When supplied, acceptance is decided by
   * the thing that actually matters — how many legs can be drawn — instead of
   * by stop proximity alone. Blue Night is why: its derived path sits closer to
   * every stop yet traces WORSE (116 unusable legs against upstream's 80),
   * because proximity says nothing about whether the stops fall along the line
   * in order.
   */
  sequence?: readonly LatLon[],
): boolean {
  if (derived.maxStopM > 250) return false; // not trustworthy on its own terms
  if (!upstream || upstream.length < 2) return true;

  // Reject a lap that includes driving riders never do. Checked before any
  // comparison, because such a path can beat upstream on every other measure.
  if (deadheadExcursionM(derived.path, upstream, stops) > EXCURSION_MAX_M) return false;

  const up = stopDistances(upstream, stops);
  const upP90 = quantile(up, 0.9);
  const upMedian = median(up);

  // Judge on the tail first. Upstream's Pink path has a fine median (35 m) and
  // a p90 of 278 m — the median says "good", the tail says a tenth of its stops
  // are nowhere near the line, and it is the tail that breaks the drawing.
  // A clear margin is required so a marginal win never churns working geometry.
  const tailWin = derived.p90StopM * 1.5 < upP90;
  const medianWin = derived.medianStopM * 1.5 < upMedian;
  // Never accept something that is markedly worse on the other measure.
  const noRegression =
    derived.p90StopM <= upP90 * 1.2 && derived.medianStopM <= upMedian * 1.2;
  if (!((tailWin || medianWin) && noRegression)) return false;

  // Decisive when we have the sequence: the derived line must draw at least as
  // many legs as the one it would replace.
  if (sequence && sequence.length >= 2) {
    // A wide margin, not merely "fewer". Three reasons, in order of weight:
    //
    // 1. The published line is the operator's own answer and it is usually
    //    right. Yale's own map draws Purple from this feed and it is perfect:
    //    299 points, no vertex gap over 40 m. Where a leg still comes out as a
    //    diagonal on a line like that, the fault is in how we SLICE it, and
    //    swapping the line neither fixes that nor is honest about it.
    // 2. This count is a model of the client's drawing, not the drawing itself.
    //    A margin absorbs the disagreement instead of pretending there is none.
    // 3. A derivation is one bus, one lap, one evening. It should have to earn
    //    its place against a published line, not edge it out by a leg.
    //
    // Halving is the threshold because it separates the real case from the
    // marginal ones: Orange Night (37 points for 9.5 km) clears it easily,
    // while Purple, Green, Red and Brown — all with good published lines — do
    // not, and keep the operator's geometry.
    const up = traceFailures(upstream, sequence);
    return traceFailures(derived.path, sequence) * 2 <= up && up > 0;
  }
  return true;
}

/**
 * How many legs of a route CANNOT be traced plausibly along a given path.
 *
 * Stop-to-line distance is only a proxy. What the map actually does is walk the
 * path stop by stop and draw the piece between each consecutive pair; when the
 * match goes backwards it wraps, which either paints most of the loop or gets
 * flattened to a straight diagonal across blocks. So the honest measure of a
 * route line is how many of its legs survive that walk.
 *
 * This mirrors the client's tracer closely enough to rank two candidate paths.
 * It is not a second implementation of the drawing — it counts failures.
 *
 * `sequence` is the route's ORDERED stop list, duplicates included: routes 9
 * and 10 visit West Campus stops twice and the order is the point.
 *
 * Measured over the trips that actually occur: a ride is 2-8 stops boarded
 * anywhere on the loop, not a lap from stop 0. Both narrower measures misled
 * me — walking the full sequence from stop 0 called Blue Night's derived path
 * a tie with upstream, and walking full loops from every start still called it
 * a tie, when across real ride lengths it is materially worse.
 */
export function traceFailures(
  path: readonly [number, number][], sequence: readonly LatLon[],
): number {
  if (path.length < 2 || sequence.length < 2) return sequence.length;
  let total = 0;
  for (let start = 0; start < sequence.length; start++) {
    for (const legs of [2, 4, 6, 8]) {
      if (legs >= sequence.length) break;
      const ride: LatLon[] = [];
      for (let j = 0; j <= legs; j++) ride.push(sequence[(start + j) % sequence.length]!);
      total += traceFailuresFrom(path, ride);
    }
  }
  return total;
}

function traceFailuresFrom(
  path: readonly [number, number][], sequence: readonly LatLon[],
): number {
  if (path.length < 2 || sequence.length < 2) return sequence.length;

  // Mirrors web/src/geo.ts traceStopLegs. Stops are PROJECTED onto the
  // segments, not snapped to vertices: a published polyline carries a vertex
  // only where the road turns, so a mid-block stop can be hundreds of metres
  // from the nearest vertex while sitting on the line. Judging a candidate by
  // the old vertex-snapping model measured a defect the client no longer has.
  const loopM = pathLengthM(path);
  const n = path.length;

  const project = (stop: LatLon, fromSeg: number) => {
    let best = { seg: fromSeg, t: 0, lat: path[fromSeg]![0], lon: path[fromSeg]![1], m: Infinity };
    let arrived = false;
    for (let step = 0; step < n; step++) {
      const i = (fromSeg + step) % n;
      const a = path[i]!;
      const b = path[(i + 1) % n]!;
      const kx = 111_320 * Math.cos((stop.lat * Math.PI) / 180);
      const ax = a[1] * kx, ay = a[0] * 111_320;
      const bx = b[1] * kx, by = b[0] * 111_320;
      const px = stop.lon * kx, py = stop.lat * 111_320;
      const dx = bx - ax, dy = by - ay;
      const l2 = dx * dx + dy * dy;
      let t = l2 < 1e-9 ? 0 : ((px - ax) * dx + (py - ay) * dy) / l2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const lat = a[0] + (b[0] - a[0]) * t;
      const lon = a[1] + (b[1] - a[1]) * t;
      const m = distanceMeters({ lat, lon }, stop);
      if (m < best.m) best = { seg: i, t, lat, lon, m };
      if (m <= 60) arrived = true;
      if (arrived && m > best.m + 80) break;
    }
    return best;
  };

  let cursor = project(sequence[0]!, 0);
  let failures = 0;
  for (let s = 1; s < sequence.length; s++) {
    const next = project(sequence[s]!, cursor.seg);
    const pts: [number, number][] = [[cursor.lat, cursor.lon]];
    if (!(cursor.seg === next.seg && next.t >= cursor.t)) {
      let i = (cursor.seg + 1) % n;
      for (let guard = 0; guard <= n; guard++) {
        pts.push(path[i]!);
        if (i === next.seg) break;
        i = (i + 1) % n;
      }
    }
    pts.push([next.lat, next.lon]);
    if (pts.length < 2 || pathLengthM(pts) > loopM * 0.7) failures++;
    cursor = next;
  }
  return failures;
}

