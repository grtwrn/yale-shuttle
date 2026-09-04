/**
 * THE RING — a bus's place on a route is an index into a closed loop, and the
 * only meaningful reading of a change is the smallest FORWARD delta.
 *
 * A route is a cycle whose stops are served in order, each edge paid once per
 * lap. So there is no start, no end, no lap counter and no wrap event to
 * detect: "backwards by one" and "forwards by N-1" are the same move, and a
 * five-second poll cannot carry a bus N-1 stops. The wrap stops being a
 * special case because there is nothing to wrap around.
 *
 *   "if the full route is a closed loop graph and we know each stop can only
 *    be hit in order and the edge weight paid once, then why are we fumbling
 *    with going 'backwards' in the graph and re-paying the edge weight?"
 *      — the operator, 2026-09-04
 *
 * `anchorGate.ts` already reads a PROPOSAL this way, and refuses the
 * impossible ones. This module is the other half: the arithmetic a CHOOSER
 * needs so it stops proposing them. The distinction matters because a veto can
 * only freeze — and a frozen anchor is a bus the rider watches stand still
 * while it drives away.
 *
 * INDEXED BY SEQUENCE POSITION, never by stop id. Routes 9 and 10 pass the
 * same West Campus buildings twice on their out-and-back, so `stops.indexOf()`
 * answers with the first occurrence and silently ties two legs together —
 * the trap behind an earlier attempt that had to settle two chords by
 * centimetres. {@link occurrenceForward} is the ring-aware replacement, and it
 * makes the problem inapplicable rather than working around it.
 */
import { haversineMeters, progressAlongSegment } from "./geo";
import type { LatLon } from "./geo";

/**
 * Nothing on this network travels faster than this — the plausibility cap the
 * segment statistics are already filtered with. Over a 5 s poll it is 110 m,
 * under 2% of a 9 km loop, which is why a ring delta is bounded so tightly.
 */
export const RING_MAX_SPEED_M_S = 22;

/** The forward delta from `from` to `to` on a ring of `n` slots: always 0..n-1. */
export function ringForward(from: number, to: number, n: number): number {
  if (n <= 0) return 0;
  return (((to - from) % n) + n) % n;
}

/** Ring distance the short way round — for measurement, never for a decision. */
export function ringGap(a: number, b: number, n: number): number {
  const f = ringForward(a, b, n);
  return Math.min(f, n - f);
}

/**
 * Where `stopId` sits in the sequence, taking the first occurrence at or ahead
 * of `from` — the ring-aware `indexOf`.
 *
 * A route that visits a stop twice has two slots for it, and which one is meant
 * is entirely a question of where the bus already was. `stops.indexOf()` cannot
 * ask that question; it always answers with the earlier slot, which on Green
 * and Purple is a lap in the wrong place. With no prior (`from < 0`) this
 * degrades to `indexOf` exactly.
 */
export function occurrenceForward(stops: readonly number[], stopId: number, from: number): number {
  const n = stops.length;
  if (n === 0) return -1;
  if (from < 0 || from >= n) return stops.indexOf(stopId);
  for (let k = 0; k < n; k++) {
    const i = (from + k) % n;
    if (stops[i] === stopId) return i;
  }
  return -1;
}

/**
 * Length of hop `i`: stops[i] → stops[i+1], or Infinity if either end has no
 * coordinate — an unmeasurable hop is one nothing can be shown to have crossed.
 */
export function hopLength(
  stops: readonly number[],
  stopCoords: Record<number, LatLon>,
  i: number,
): number {
  const n = stops.length;
  if (n === 0) return Infinity;
  const a = stopCoords[stops[((i % n) + n) % n]!];
  const b = stopCoords[stops[((i + 1) % n + n) % n]!];
  return a && b ? haversineMeters(a, b) : Infinity;
}

/**
 * How many slots forward a bus can have advanced, given where it was and how
 * much road it can have covered since.
 *
 * MEASURED ALONG THE ROUTE'S OWN SPACING, not a constant per hop. Green's
 * Building 900 → LEPH leg is 6.7 km and downtown hops are ~100 m; one number
 * cannot serve both, and `ANCHOR_M_PER_HOP = 120` is that one number today. On
 * the long leg it grants a hop the bus cannot possibly have made; downtown it
 * withholds one it made twice over.
 *
 * AND FROM WHERE THE BUS WAS ON THE LEG, not from the stop behind it. An
 * anchor of `i` means "on segment stops[i] → stops[i+1]", so a bus 89 m into a
 * 112 m hop needs 23 m to reach the next slot, not 112. Measuring from the stop
 * is what makes a window too tight to admit a real departure: on the operator's
 * Red #316 trace the bus had covered 102 m of a 112 m hop and the window still
 * read zero.
 *
 * Hop lengths are measured as the walk needs them rather than tabulated up
 * front: the budget is a couple of hundred metres and stop spacing runs
 * 120-300 m, so this returns after one or two haversines. Building the whole
 * table would cost one per stop, per bus, per poll, on the render path.
 *
 * @param from       the slot the bus was accepted at
 * @param fromPos    where the bus was when that slot was accepted
 * @param budgetM    road it can have covered since (see {@link travelBudgetM})
 */
export function reachableHops(
  stops: readonly number[],
  stopCoords: Record<number, LatLon>,
  from: number,
  fromPos: LatLon | null,
  budgetM: number,
): number {
  const n = stops.length;
  if (n === 0 || from < 0 || from >= n) return n;
  if (!(budgetM > 0)) return 0;

  // Distance still to run on the leg the bus was on. Without a position we
  // must assume it was at the very start of it, which is the conservative read.
  let need = hopLength(stops, stopCoords, from);
  if (fromPos && Number.isFinite(need)) {
    const a = stopCoords[stops[from]!];
    const b = stopCoords[stops[(from + 1) % n]!];
    if (a && b) {
      const t = Math.min(1, Math.max(0, progressAlongSegment(fromPos, a, b)));
      need = need * (1 - t);
    }
  }
  if (need > budgetM) return 0;

  for (let k = 1; k < n; k++) {
    const nextHop = hopLength(stops, stopCoords, from + k);
    if (!Number.isFinite(nextHop)) return k;
    need += nextHop;
    if (need > budgetM) return k;
  }
  return n - 1;
}

/**
 * The road a bus can have covered since its anchor was accepted.
 *
 * OBSERVED PATH, bounded by what the clock allows. Elapsed time alone is
 * useless: a bus standing ten minutes at a layover would accrue 13 km of
 * licence and the window would stop constraining anything. Observed path is the
 * honest quantity — the feed repeats a coordinate rather than interpolating, so
 * a standing bus accumulates almost nothing while a driving one accumulates its
 * real road.
 *
 * Plus one deadband. The feed publishes a new coordinate only once the bus has
 * moved ~30 m, so the bus is always up to a deadband further along than its
 * last reported fix, and a window that does not allow for it refuses the
 * departure it exists to admit.
 *
 * The clock is still the ceiling, so a bus re-acquired across a gap cannot buy
 * an unbounded window out of one long step.
 */
export function travelBudgetM(pathM: number, elapsedMs: number, deadbandM: number): number {
  const ceiling = Math.max(0, elapsedMs / 1000) * RING_MAX_SPEED_M_S;
  return Math.min(Math.max(0, pathM) + deadbandM, ceiling + deadbandM);
}
