/**
 * When the published stop SEQUENCE disagrees with the published LINE.
 *
 * `traceStopLegs` (geo.ts) walks a route's published polyline forward from one
 * stop to the next and, when the walk cannot reach the next stop without going
 * round the loop, bridges the leg with a chord. Every published line but one
 * traces without a bridge. The exception is Green (route 9), and the cause is
 * not the geometry:
 *
 *   the published line passes  ... B800, B900, West Haven station, Bradley (N)
 *   the published list says    ... B800, West Haven station, B900, Bradley (N)
 *
 * The line is right. Green's buses drive B800 -> B900 -> station -> Bradley on
 * the return (2,943 consecutive B800 -> B900 arrivals against 1 for
 * B800 -> station, 676 B900 -> station, 666 station -> Bradley (N), over the
 * snapshot's three months), which is the order the polyline is published in and
 * NOT the order the stop list is published in. Asked to walk the list, the
 * tracer has to run most of the loop backwards, and the length guard replaces
 * three legs with chords — which is what makes Green's ring `bridged` and what
 * makes the ring estimator decline the line.
 *
 * So the repair reads the order off the LINE, the same move that fixed the
 * drawn route lines ("the published geometry is right, drawing it was wrong"),
 * and it is deliberately MINIMAL: the published order is honoured wherever the
 * line supports it, and only an occurrence the line cannot supply in its
 * published slot is moved to the pass the line actually makes past it. On the
 * fifteen published lines that costs exactly one move, on one route.
 *
 * The mechanism, in three steps:
 *
 *  1. Every stop gets its CANDIDATE PASSES: the local minima of its distance to
 *     the line, within {@link MAX_STOP_OFFSET_M}. A stop the line passes twice
 *     (Green's Building 600, every downtown stop whose street is driven both
 *     ways) has two; a stop on a spur has one.
 *  2. A dynamic program walks the published order and assigns each occurrence a
 *     candidate whose distance ALONG the line does not go backwards, minimising
 *     first the number of occurrences it has to SKIP and then the total offset.
 *     Monotone-with-skips, one lap, anchored at each candidate of the first
 *     stop in turn.
 *  3. Each skipped occurrence is then placed at the candidate that disturbs the
 *     published order least (and, on a tie, is nearest). The ring order is the
 *     whole set sorted by distance along the line.
 *
 * Zero skips means the published order IS the line's order, and this module
 * returns null: the ring is built exactly as before. That is why the other
 * fourteen rings are byte-identical, by construction rather than by measurement
 * (`alignStops.test.ts` measures it anyway).
 *
 * It lives under `src/` because BOTH sides need it and only `src/` is in the
 * runtime image: the server holds the repaired order in its own network (so
 * the detector's `legs`/`stop_visits` are keyed by hops the buses really
 * drive) and the client's ring computes the identical repair from the same
 * two payload fields (`routes[r]` and `route_paths[r]`), so no new field and
 * no version skew. The web build copies this one file (see the Dockerfile).
 */

export type LatLon = { lat: number; lon: number };

/**
 * The same great-circle metre as `legs.ts` and `web/src/geo.ts`, spelled again
 * here so this module depends on nothing: `legs.ts` imports IT, and a cycle
 * between the two would be a worse trade than nine lines.
 */
function haversineMeters(a: LatLon, b: LatLon): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/**
 * How far a stop's marker may sit from the pass of the line that serves it.
 *
 * Set from the lines, not from intuition, and there is a wide gap to sit in.
 * Across all fifteen published routes the largest offset in a correct
 * assignment is 99 m — Green's Building 800 on its outbound pass, where the
 * marker is at the building and the road runs round the back of it; every
 * other route's worst is 49 m or less. The spurious minima this bound exists
 * to exclude are an order of magnitude further out: without it, Green's
 * published order becomes "traceable" by putting one stop 2,129 m from the
 * line, which is not a pass at all. Anything from 120 m to 300 m gives the
 * same answer on all fifteen routes.
 */
export const MAX_STOP_OFFSET_M = 200;

/** Where the line passes a stop: the projection, and how far off it is. */
export interface Pass {
  /** Index of the segment the projection lands on. */
  seg: number;
  /** Fraction along that segment. */
  t: number;
  lat: number;
  lon: number;
  /** Distance along the line from its first point, metres. */
  m: number;
  /** Distance from the stop's marker to the projection, metres. */
  d: number;
}

export interface Alignment {
  /**
   * Ring position -> index into the published stop list. Starts at published
   * 0. Longer than the published list when a pass was ADDED (see
   * {@link SPUR_LEG_M}), and then two ring positions can name one published
   * slot.
   */
  order: number[];
  /** Ring position -> the pass the line makes there. */
  passes: Pass[];
  /** How many occurrences the published order could not supply. */
  skips: number;
  /** Ring positions the published list does not have an occurrence for. */
  added: number;
  /** Each leg of the repaired ring, as a slice of the published line. */
  legs: [number, number][][];
}

/**
 * A leg this long, on a route whose order had to be repaired, is a run between
 * two stops rather than a hop: if one of the route's OWN stops has a pass the
 * assignment left unused strictly inside it, the line drives past that stop
 * for kilometres and the list has simply not said so.
 *
 * Green is the case and the measurement. Its list names West Haven station
 * once; the line passes it twice, on the way out and on the way back, and the
 * buses call there both times (676 station -> Building 900 arrivals against
 * 676 the other way, over the snapshot's three months). With only the return
 * pass in the ring the outbound station visit falls INSIDE the 11.7 km hop
 * from Bradley (S), the detector anchors nine hops ahead when the bus stops
 * there, and the leg is discarded for exceeding MAX_SEGMENT_HOPS — which is
 * why that hop, the longest on the line, had no measured drive at all.
 *
 * The two legs above this bound on that route are 11,743 m and 9,214 m; every
 * other leg the repair produces is 517 m or less, so nothing sits near it.
 * The second condition — {@link SPUR_SEPARATION_M} from any pass already
 * used — is what keeps the twin stops out: Bradley (S)'s spare pass sits 2 m
 * from Bradley (N)'s, and the station's sits 2,390 m from anything.
 */
export const SPUR_LEG_M = 2_000;

/** How far an added pass must be from every pass already assigned. See {@link SPUR_LEG_M}. */
export const SPUR_SEPARATION_M = 200;

/** The line's segments, with the closing wrap appended when it is published open. */
function segmentsOf(path: readonly (readonly [number, number])[]): [number, number][][] {
  const n = path.length;
  const out: [number, number][][] = [];
  for (let i = 0; i < n - 1; i++) out.push([path[i]! as [number, number], path[i + 1]! as [number, number]]);
  const a = path[0]!, b = path[n - 1]!;
  if (haversineMeters({ lat: a[0], lon: a[1] }, { lat: b[0], lon: b[1] }) > 1) {
    out.push([b as [number, number], a as [number, number]]);
  }
  return out;
}

function projectOnto(a: readonly [number, number], b: readonly [number, number], p: LatLon): { t: number; lat: number; lon: number; d: number } {
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
  return { t, lat, lon, d: haversineMeters({ lat, lon }, p) };
}

/**
 * Every pass the line makes at a stop: the local minima of distance, taken
 * cyclically so a pass across the line's own seam is not lost. Falls back to
 * the single nearest point when the line never comes within
 * {@link MAX_STOP_OFFSET_M} — a stop the line does not really serve still has
 * to go somewhere, and the caller's guards decide what that is worth.
 */
export function passesAt(segs: readonly [number, number][][], cum: readonly number[], stop: LatLon): Pass[] {
  const K = segs.length;
  const per: Pass[] = [];
  for (let i = 0; i < K; i++) {
    const s = segs[i]!;
    const r = projectOnto(s[0]!, s[1]!, stop);
    per.push({ seg: i, t: r.t, lat: r.lat, lon: r.lon, m: cum[i]! + r.t * (cum[i + 1]! - cum[i]!), d: r.d });
  }
  const minima: Pass[] = [];
  for (let i = 0; i < K; i++) {
    const prev = per[(i - 1 + K) % K]!, here = per[i]!, next = per[(i + 1) % K]!;
    if (here.d <= prev.d && here.d < next.d) minima.push(here);
  }
  const within = minima.filter((p) => p.d <= MAX_STOP_OFFSET_M);
  if (within.length > 0) return within.sort((a, b) => a.m - b.m);
  if (minima.length > 0) return [minima.reduce((x, y) => (y.d < x.d ? y : x))];
  return [per.reduce((x, y) => (y.d < x.d ? y : x))];
}

/** The piece of the line between two passes, in travel order. */
function sliceBetween(segs: readonly [number, number][][], from: Pass, to: Pass): [number, number][] {
  const K = segs.length;
  const out: [number, number][] = [[from.lat, from.lon]];
  const sameSeg = from.seg === to.seg && to.t >= from.t;
  if (!sameSeg) {
    let i = from.seg;
    for (let guard = 0; guard <= K; guard++) {
      out.push(segs[i]![1]!);
      i = (i + 1) % K;
      if (i === to.seg) break;
    }
  }
  out.push([to.lat, to.lon]);
  return out;
}

interface State { skips: number; cost: number; m: number; pick: (Pass | null)[] }

/**
 * The repaired ring order, or null when the published order already is the
 * line's order (the answer on fourteen of fifteen routes) or when no
 * assignment exists at all.
 */
function solve(
  path: readonly (readonly [number, number])[] | undefined,
  stops: readonly LatLon[] | undefined,
  allowSkips: boolean,
): Alignment | null {
  if (!path || path.length < 2 || !stops || stops.length < 2) return null;
  const segs = segmentsOf(path);
  if (segs.length < 2) return null;
  const cum: number[] = [0];
  for (const s of segs) {
    cum.push(cum[cum.length - 1]! + haversineMeters({ lat: s[0]![0], lon: s[0]![1] }, { lat: s[1]![0], lon: s[1]![1] }));
  }
  const loopM = cum[cum.length - 1]!;
  if (!(loopM > 0)) return null;
  const N = stops.length;
  const cands = stops.map((s) => passesAt(segs, cum, s));

  let best: State | null = null;
  for (const anchor of cands[0]!) {
    const m0 = anchor.m;
    let live: State[] = [{ skips: 0, cost: anchor.d, m: m0, pick: [anchor] }];
    for (let i = 1; i < N && live.length > 0; i++) {
      const next: State[] = [];
      for (const st of live) {
        // Skip: this occurrence is placed afterwards, wherever the line
        // actually passes it.
        if (allowSkips) next.push({ skips: st.skips + 1, cost: st.cost, m: st.m, pick: [...st.pick, null] });
        for (const c of cands[i]!) {
          let m = c.m;
          while (m < m0) m += loopM;
          if (m > m0 + loopM || m < st.m) continue;
          next.push({ skips: st.skips, cost: st.cost + c.d, m, pick: [...st.pick, c] });
        }
      }
      // Only the cheapest way to reach a given position matters.
      const byPos = new Map<number, State>();
      for (const s of next) {
        const k = Math.round(s.m);
        const held = byPos.get(k);
        if (!held || s.skips < held.skips || (s.skips === held.skips && s.cost < held.cost)) byPos.set(k, s);
      }
      live = [...byPos.values()];
    }
    for (const s of live) {
      if (s.pick.length !== N) continue;
      if (!best || s.skips < best.skips || (s.skips === best.skips && s.cost < best.cost)) best = s;
    }
  }
  if (!best) return null;

  // Place what the published order could not supply, at the pass that disturbs
  // that order least — Green's station is a 3 m call on distance alone (37 m on
  // the return pass against 40 m on the outbound one) and a 9-slot call on
  // order, which is the evidence that is not a coin toss.
  const pass: Pass[] = new Array<Pass>(N);
  const placed: { i: number; m: number }[] = [];
  for (let i = 0; i < N; i++) {
    const p = best.pick[i];
    if (p) { pass[i] = p; placed.push({ i, m: p.m }); }
  }
  placed.sort((a, b) => a.m - b.m);
  for (let i = 0; i < N; i++) {
    if (best.pick[i]) continue;
    let pick: Pass | null = null;
    let pickRank = Infinity, pickD = Infinity;
    for (const c of cands[i]!) {
      // Where this candidate would land among the occurrences already placed,
      // expressed as the published index it would sit between.
      let ahead = 0;
      for (const q of placed) if (q.m < c.m) ahead++;
      const rank = ahead === 0 ? 0 : placed[ahead - 1]!.i + 1;
      const disturbance = Math.abs(rank - i);
      if (disturbance < pickRank || (disturbance === pickRank && c.d < pickD)) {
        pick = c; pickRank = disturbance; pickD = c.d;
      }
    }
    pass[i] = pick ?? cands[i]![0]!;
  }

  let ring = Array.from({ length: N }, (_, i) => ({ i, p: pass[i]! })).sort((a, b) => a.p.m - b.p.m);

  // A stop the line drives past for kilometres inside one leg, that the list
  // gave no occurrence there (SPUR_LEG_M).
  const used = ring.map((x) => x.p.m);
  const apart = (a: number, b: number) => { const d = Math.abs(a - b); return Math.min(d, loopM - d); };
  const extra: { i: number; p: Pass }[] = [];
  for (let k = 0; k < ring.length; k++) {
    const from = ring[k]!.p, to = ring[(k + 1) % ring.length]!.p;
    let span = to.m - from.m;
    if (span <= 0) span += loopM;
    if (span < SPUR_LEG_M) continue;
    for (let i = 0; i < N; i++) {
      for (const c of cands[i]!) {
        let d = c.m - from.m;
        if (d <= 0) d += loopM;
        if (d <= 0 || d >= span) continue;
        if (used.some((u) => apart(u, c.m) < SPUR_SEPARATION_M)) continue;
        if (extra.some((e) => apart(e.p.m, c.m) < SPUR_SEPARATION_M)) continue;
        extra.push({ i, p: c });
      }
    }
  }
  if (extra.length > 0) ring = ring.concat(extra).sort((a, b) => a.p.m - b.p.m);

  const zero = ring.findIndex((x) => x.i === 0);
  ring = ring.slice(zero).concat(ring.slice(0, zero));
  const order = ring.map((x) => x.i);
  const passes = ring.map((x) => x.p);
  const legs: [number, number][][] = [];
  for (let k = 0; k < ring.length; k++) {
    legs.push(sliceBetween(segs, passes[k]!, passes[(k + 1) % ring.length]!));
  }
  return { order, passes, skips: best.skips, added: extra.length, legs };
}

/**
 * Two ring positions this close along the line are the same place, and a
 * repair that puts two occurrences there has not found a pass for one of
 * them — a stop the line passes ONCE cannot be served twice. Two genuinely
 * distinct stops do come close: Orange / Bradley (N) and (S) sit 2 m apart on
 * the line, and Green's ring needs both.
 */
const SAME_PLACE_M = 1;

/**
 * The repair is a CORRECTION to the published list, never a rewrite of it.
 *
 * At most this share of a route's occurrences may be moved (or added). Green
 * needs one move and one addition out of 23 — 4% and 4%. A published line that
 * runs COUNTER to its stop list, which has happened and is the "whole route
 * painted solid" bug the rider first reported, needs every stop moved: and
 * there the list is right and the LINE is the defect, so reversing the list
 * would run the estimator round the route backwards. Past this bound the route
 * keeps its published order, its bridged ring and the legacy arithmetic —
 * exactly where it already was — and `derivePath.ts` is the remedy for the
 * geometry.
 */
const MAX_MOVED_FRACTION = 0.1;

/**
 * The repair: the ring order the line supports, or null when the published
 * order IS that order (fourteen routes of fifteen) or when nothing fits.
 *
 * "Nothing fits" includes a repair that had to stack two occurrences on one
 * pass. A small out-and-back can bridge its return leg — it covers most of a
 * short loop by construction — while its published order is perfectly right;
 * asked to repair that, the assignment can only put the repeated stop's two
 * occurrences on the one pass the line makes at it, which is a ring with a hop
 * from a stop to itself. Declining leaves the ring bridged and the route on
 * the legacy arithmetic, which is where it already was.
 */
export function alignStopsToPath(
  path: readonly (readonly [number, number])[] | undefined,
  stops: readonly LatLon[] | undefined,
): Alignment | null {
  const a = solve(path, stops, true);
  if (!a || (a.skips === 0 && a.added === 0)) return null;
  const budget = Math.max(1, Math.floor(a.order.length * MAX_MOVED_FRACTION));
  if (a.skips > budget || a.added > budget) return null;
  const at = a.passes.map((p) => p.m).sort((x, y) => x - y);
  for (let k = 1; k < at.length; k++) if (at[k]! - at[k - 1]! < SAME_PLACE_M) return null;
  return a;
}

/**
 * The legs a stop list already in travel order draws along the line, each a
 * slice of it — the assignment with NO skips, i.e. every stop taken at a pass
 * that does not go backwards, at the least total offset.
 *
 * `traceStopLegs` walks forward greedily and takes the nearest pass it can
 * reach; on a route that doubles back past its own stops that can be the wrong
 * pass, and then the next stop is behind the cursor and the leg wraps. This
 * decides every stop's pass together instead. Null when the order is not one
 * the line can supply at all.
 */
export function legSlicesInOrder(
  path: readonly (readonly [number, number])[] | undefined,
  stops: readonly LatLon[] | undefined,
): [number, number][][] | null {
  const a = solve(path, stops, false);
  return a && a.skips === 0 && a.added === 0 && a.legs.length === (stops?.length ?? -1) ? a.legs : null;
}

/**
 * The stop order the ring should be built on: upstream's, or the repair when
 * upstream's cannot be traced along upstream's own line.
 *
 * The trace is the trigger and the only one — a route whose published order
 * the line supports returns null here and is built exactly as before. The
 * server calls this so its detector, its `legs`/`stop_visits` and its served
 * hop keys are all in the order the buses drive; the client's ring calls the
 * same function on the same two payload fields and gets the same answer, so
 * there is nothing to serve and nothing to skew.
 */
export function repairedStopOrder(
  path: readonly (readonly [number, number])[] | undefined,
  stops: readonly LatLon[] | undefined,
): number[] | null {
  const aligned = alignStopsToPath(path, stops);
  return aligned && aligned.legs.length === aligned.order.length ? aligned.order : null;
}
