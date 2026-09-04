/**
 * The corroborated anchor: a bus may only be relocated on the loop when
 * something in the world says it moved.
 *
 * WHY. `findRouteAnchor` is stateless — it re-decides from scratch every poll
 * which stop a bus is at. Where a route folds back on itself, two stops sit
 * metres apart but many stops apart in sequence (Green's two Orange/Pearl
 * platforms are 35 m apart and 9 stops apart), so a GPS twitch smaller than a
 * bus flips the anchor and swings the promised arrival by a third of a lap.
 *
 * Measured on 1.59 M poll-to-poll transitions (docs/eta-error-budget.md,
 * 2026-09-03): of the 16,128 ETA jumps over five minutes,
 *
 *   7,928 (49.2%)  a detector arrival fired or the at-stop flag flipped — REAL
 *     716  (4.4%)  the bus moved >= 100 m — REAL
 *   7,047 (43.7%)  the bus twitched < 100 m (median 37.9 m, max 99 m)
 *     437  (2.7%)  the GPS fix was byte-identical — nothing happened at all
 *
 * 46.4% had no real-world event behind them, and all 437 truly eventless ones
 * came from the feed's `last_stop_id` advancing under a frozen fix.
 *
 * WHAT THIS IS NOT. It is not a rate limiter on the displayed number. That was
 * built, measured (95% of catastrophic jumps suppressed) and rejected, because
 * it damps the corrections that are RIGHT along with the ones that are wrong:
 *
 *   "I don't want a slew limiter. it can go 5->1 if it leaves early. but if it
 *    is jitter we need a fix." — the operator, 2026-09-03
 *
 * So the gate discriminates instead of damping. A real departure changes
 * `at_stop_id`, which releases in the SAME poll — 5 min -> 1 min still happens
 * instantly when the bus really left.
 *
 * `last_stop_id` stays an input. Withholding it was measured and is worse:
 * jumps over five minutes went 16,128 -> 24,986, because it does real
 * disambiguation work where a route revisits a vicinity. It is required to be
 * corroborated, not ignored.
 */
import { haversineMeters } from "./geo";

/**
 * Net displacement from where the anchor was set that justifies relocating the
 * bus on GPS evidence alone.
 *
 * NET displacement, not path length: a parked bus twitching 38 m back and
 * forth accumulates unlimited path but never leaves a 40 m circle, so a
 * cumulative measure would open the gate on exactly the population this
 * exists to reject. The twitch population tops out at 99 m by construction and
 * has a median of 37.9 m; 100 m clears all of it.
 */
export const ANCHOR_CORROBORATION_M = 100;

/**
 * Metres of travel that justify the anchor advancing ONE stop.
 *
 * Displacement alone is the wrong corroboration and measuring it proved so: it
 * establishes that the bus moved, not that it moved to the leg the stateless
 * anchor picked. On a folding route the bus legitimately covers 100 m while
 * the raw anchor jumps nine stops to a platform 35 m away that it never
 * visited — the movement is real and the relocation is still nonsense. So the
 * anchor may only advance as far along the SEQUENCE as the distance travelled
 * can account for. Stop spacing on this network runs ~120-300 m; 120 is the
 * generous end, so a legitimate one-stop advance is never held for long.
 */
export const ANCHOR_M_PER_HOP = 120;

/**
 * The feed reports a new coordinate only once a bus has moved ~30 m (2 of
 * 33,118 distinct fixes moved less, and the floor is 30.0 m whether 5 s or
 * 20 s elapsed). So 30 m is the smallest displacement that proves ANY movement
 * at all, and it is what `last_stop_id` must be corroborated by.
 */
export const ANCHOR_FEED_MOVE_M = 30;

/**
 * Never hold a disputed anchor longer than this. If the gate is wrong, the
 * damage is bounded; a genuinely moving bus clears the distance test within
 * seconds, so this only governs a bus that keeps reporting while disputed.
 *
 * Longer than {@link ANCHOR_STALE_MS} on purpose, and the two never race: the
 * staleness path keys on the gap since the bus was last SEEN, which stays at
 * one poll (~5 s) for any bus actually on the feed. A bus that vanishes for
 * two minutes is reset rather than timed out, which is the right answer — its
 * old anchor is not evidence about where it came back.
 *
 * Swept on the replay: 90 s left 14,109 jumps over five minutes, 300 s leaves
 * 12,881, and 600 s adds nothing further.
 */
export const ANCHOR_MAX_HOLD_MS = 300_000;

/** A bus unseen for this long has no usable history; start fresh. */
export const ANCHOR_STALE_MS = 120_000;

export interface GatedAnchor {
  /**
   * The index we are currently willing to show. Negative means this entry
   * exists only to carry the fix memory below — {@link noteFix} may open one
   * before the gate has ever run — and the gate treats it as no history.
   */
  index: number;
  /** Where the bus was when this index was accepted. */
  lat: number;
  lon: number;
  /** `at_stop_id` / `last_stop_id` as they were when this index was accepted. */
  atStopId: number | null;
  lastStopId: number | null;
  /** When the raw anchor first disagreed with `index`, else null. */
  disagreeSince: number | null;
  seenAt: number;
  /**
   * The last two DISTINCT coordinates this bus reported — the step whose
   * direction tells `findRouteAnchor` which branch of a fold the bus is on.
   *
   * DISTINCT, not last-poll: 53.6% of consecutive samples are byte-identical
   * (the feed repeats a fix rather than interpolating, in runs of 15 s and up
   * to 28 min), so "the previous poll" is most often the same point and has no
   * direction in it. Keeping the last two distinct fixes means a bus that
   * stands still keeps the heading of the move that brought it there, which is
   * exactly the branch it is on, and a bus that pulls out reverses it on the
   * first fix that moves.
   */
  fix?: { lat: number; lon: number } | undefined;
  prevFix?: { lat: number; lon: number } | undefined;
}

export type AnchorStore = Map<string, GatedAnchor>;

/**
 * The app's single live anchor memory.
 *
 * Module-level on purpose: the gate needs to remember where it last put each
 * bus, and the rendered ETA is recomputed from scratch on every poll from
 * several places at once. One shared store keeps the map, the route cards and
 * the trip card from disagreeing about where a bus is.
 *
 * Anything HYPOTHETICAL must not touch it — a replay, a future-mode plan, a
 * test. Those pass their own store, or none, and `computeUpcomingArrivals`
 * then behaves exactly as it always has.
 */
export const liveAnchorStore: AnchorStore = new Map();

export interface GateBus {
  lat?: number | undefined;
  lon?: number | undefined;
  at_stop_id?: number | null | undefined;
  last_stop_id?: number | null | undefined;
}

export interface GateResult {
  index: number;
  /** Why the anchor was allowed to move, for measurement. null = held. */
  released:
    | "first" | "stale" | "agrees"
    | "at-stop" | "forward-consistent" | "feed+moved" | "timeout"
    | null;
}

const norm = (v: number | null | undefined): number | null =>
  v === undefined || v === null ? null : v;

/**
 * Remember this poll's coordinate and hand back the previous DISTINCT one, so
 * `findRouteAnchor` can read the direction of travel off the step between them
 * and tell the two branches of an out-and-back apart.
 *
 * Idempotent within a poll: a repeated coordinate is not a new fix, and the
 * app computes arrivals several times per poll from the map, the route cards
 * and the trip card off one shared store.
 *
 * Returns null when there is no second fix yet — a bus first seen this session,
 * or one that has only ever reported the same point — and then nothing about
 * the anchor changes.
 */
export function noteFix(
  store: AnchorStore,
  key: string,
  bus: GateBus,
  now: number,
): { lat: number; lon: number } | null {
  const lat = bus.lat;
  const lon = bus.lon;
  if (lat === undefined || lon === undefined || !lat || !lon) return null;
  const prev = store.get(key);
  // Away long enough to have no usable history: where it used to be is not
  // evidence about where it came back from either.
  if (!prev || now - prev.seenAt > ANCHOR_STALE_MS) {
    store.set(key, {
      index: -1,
      lat, lon,
      atStopId: norm(bus.at_stop_id),
      lastStopId: norm(bus.last_stop_id),
      disagreeSince: null,
      seenAt: now,
      fix: { lat, lon },
      prevFix: undefined,
    });
    return null;
  }
  if (!prev.fix) {
    store.set(key, { ...prev, fix: { lat, lon } });
    return null;
  }
  if (prev.fix.lat === lat && prev.fix.lon === lon) return prev.prevFix ?? null;
  store.set(key, { ...prev, prevFix: prev.fix, fix: { lat, lon } });
  return prev.fix;
}

/**
 * Decide which anchor index to use, given the raw one and the bus's evidence.
 * Pure apart from the supplied store, which the caller owns — so a hypothetical
 * or historical computation can pass its own store (or none) and never disturb
 * the live one.
 */
export function gateAnchor(
  store: AnchorStore,
  key: string,
  rawIndex: number,
  bus: GateBus,
  now: number,
  /** Length of the route's stop sequence, for forward-distance arithmetic. */
  stopCount: number,
): GateResult {
  const lat = bus.lat;
  const lon = bus.lon;
  const atStopId = norm(bus.at_stop_id);
  const lastStopId = norm(bus.last_stop_id);
  const prev = store.get(key);
  const accept = (released: GateResult["released"]): GateResult => {
    store.set(key, {
      // The fix memory (`noteFix`) rides on the same entry and is not the
      // gate's business — carry it through every write rather than resetting
      // the bus's heading each time the anchor is allowed to move.
      ...prev,
      index: rawIndex,
      lat: lat ?? 0,
      lon: lon ?? 0,
      atStopId,
      lastStopId,
      disagreeSince: null,
      seenAt: now,
    });
    return { index: rawIndex, released };
  };

  // No history (`index < 0` is a memory-only entry `noteFix` opened before the
  // gate ever ran), a bus that has been away, or no GPS to reason about: accept.
  if (!prev || prev.index < 0) return accept("first");
  if (now - prev.seenAt > ANCHOR_STALE_MS) return accept("stale");
  if (lat === undefined || lon === undefined || !lat || !lon) return accept("stale");

  if (rawIndex === prev.index) {
    // Agreement. Keep the anchor's ORIGIN position: displacement has to be
    // measured from where the anchor was set, not from last poll, or a bus
    // creeping 30 m at a time would never accumulate evidence.
    store.set(key, { ...prev, disagreeSince: null, seenAt: now });
    return { index: prev.index, released: "agrees" };
  }

  const N = Math.max(1, stopCount);

  // --- the raw anchor wants to move. What corroborates it?
  //
  // NOT direction. Letting the step between two fixes overturn a hold — the
  // gate releasing whenever the bus drives against the leg it is holding —
  // was built and measured on the rider simulator, and it is a LOSS: Green's
  // strand share falls 27.4 -> 24.9% and Purple's rises 27.1 -> 32.6%, worse
  // than master, with jumps over 300 s up on both. Direction belongs where it
  // is unambiguous, choosing between two candidate legs the bus is ON
  // (anchor.ts); as a licence to relocate it re-opens the gate on exactly the
  // population the gate exists for.
  // 1. A real arrival or departure. `at_stop_id` flipping in either direction
  //    is the collector saying the bus reached or left a stop, and it is the
  //    signal that must never be delayed: a bus pulling out early goes
  //    at_stop_id -> null in the same poll the rider needs to see 5 -> 1.
  //
  //    With ONE exception, in one direction. When the flag CLEARS, the bus has
  //    just left the stop the anchor was standing at — and on that very poll
  //    the stateless scan retreats one chord, to the leg INTO that stop. It
  //    does so because `last_stop_id` still names the stop before (the feed
  //    lags a stop on arrival) and the scan breaks ties forward from there;
  //    the chord into the stop wins over the chord out of it until the bus is
  //    150 m clear or the feed catches up. So the stop the bus has just pulled
  //    away from flips from a lap away to "now", and back a poll or two later.
  //    Replayed over 9 h of production positions with the production layover
  //    clock: 1,500 one-stop-backward anchor flips, 1,091 of them on exactly
  //    this signal — the largest single defect class left on the board
  //    (Red #316 did it three times in three minutes, Prospect / Hillside,
  //    SCL and 130 Prospect (S)).
  //
  //    A bus that has just left S is not approaching S. Refusing that one
  //    retreat is not a delay: the anchor stays on the chord OUT of the stop,
  //    which is where the departure is priced — its proration ticks in this
  //    same poll and 5 -> 1 on an early departure is untouched. It is not a
  //    hold either: the bus itself is not being held anywhere, only the one
  //    answer that contradicts the event is declined, and every other
  //    relocation the flag change vouches for (an arrival, a forward move,
  //    even a fold-back flip) still passes as before.
  if (atStopId !== prev.atStopId) {
    const departed = prev.atStopId !== null && atStopId === null;
    const retreat = rawIndex === (prev.index - 1 + N) % N;
    if (!(departed && retreat)) return accept("at-stop");
    // Record that the departure has been seen (`atStopId: null`), or every
    // later disagreement would re-open the at-stop gate against a stale
    // value and a fold-back flip an hour later would walk straight through.
    // The origin stays where the anchor was accepted, so the distance the
    // bus covers from the stop still counts towards corroborating its next
    // real move.
    store.set(key, { ...prev, atStopId: null, disagreeSince: prev.disagreeSince ?? now, seenAt: now });
    return { index: prev.index, released: null };
  }

  const movedM = haversineMeters({ lat, lon }, { lat: prev.lat, lon: prev.lon });

  // 2. The move is consistent with the ground covered. `forward` is how far
  //    along the loop the raw anchor wants to jump; anything the travelled
  //    distance cannot account for is a relocation, not a progression. A
  //    backwards jump (forward > half the loop) is never distance-justified.
  const forward = ((rawIndex - prev.index) % N + N) % N;
  // The first hop is NOT free. Granting one stop unconditionally is precisely
  // the eventless population: `last_stop_id` advances under a byte-identical
  // fix, the raw anchor moves one stop, and the promise jumps a whole lap on
  // zero new evidence. One deadband step (30 m) is the least the feed can
  // report and so the least that can count as movement at all.
  const allowedHops =
    (movedM >= ANCHOR_FEED_MOVE_M ? 1 : 0) + Math.floor(movedM / ANCHOR_M_PER_HOP);
  if (forward <= allowedHops && forward <= N / 2) return accept("forward-consistent");

  // 3. The feed reassigned the bus's stop AND it actually moved, AND the jump
  //    is still forward-plausible. Either half alone is the failure mode:
  //    last_stop_id under a frozen fix is the whole of the eventless
  //    population, and sub-30 m movement is below what the feed can report.
  if (
    lastStopId !== prev.lastStopId &&
    movedM >= ANCHOR_FEED_MOVE_M &&
    forward <= allowedHops + 1 &&
    forward <= N / 2
  ) {
    return accept("feed+moved");
  }

  // 4. Bounded damage if the gate is wrong.
  const since = prev.disagreeSince ?? now;
  if (now - since >= ANCHOR_MAX_HOLD_MS) return accept("timeout");

  store.set(key, { ...prev, disagreeSince: since, seenAt: now });
  return { index: prev.index, released: null };
}

/** Drop entries for buses that have not been seen for a while. */
export function pruneAnchors(store: AnchorStore, now: number): void {
  for (const [k, v] of store) {
    if (now - v.seenAt > ANCHOR_STALE_MS) store.delete(k);
  }
}
