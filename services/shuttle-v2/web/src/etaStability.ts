// The rider-facing stability guard on a bus's ETA.
//
// WHY THIS EXISTS (report #82, 2026-09-02). Red #316 sat in the Winchester
// yard, not moving, while its GPS wandered ~30 m per poll. One fix crossed the
// 75 m stationary radius, the collector re-anchored the layover clock, and the
// client re-billed a fresh ~5 min hold: the trip card went 15 min → 20 min and
// the map bubble went "3 min" → "8 min" in six seconds, on a bus that had not
// moved and that pulled out 23 s later. The rider's words: "it jumped from
// 3min to 8 min!". The operator's standing priority: "i'm not worried about a
// few seconds. i'm worried about saying a bus is 10min away and then a few
// seconds later dropping to 1 second."
//
// So the defect is the JUMP, independent of cause. Root causes (layover clock,
// anchor flips, pin churn) are worth fixing on their own, and are being fixed
// separately — this module is the net underneath them. With it in place the
// #82 sequence is invisible to the rider even with the bug fully present.
//
// THE RULE. A countdown ticks DOWN by roughly the elapsed time. An upward
// revision is therefore news, and news has to earn its way onto the screen:
//   - Anything ≤ ETA_JITTER_SEC above the expected tick passes straight
//     through, damped or not. A ratchet that clamped every +5 s wobble would
//     bias the whole countdown to the optimistic tail and hit zero early.
//   - A bigger upward revision is suppressed for at most ETA_HOLD_SEC while
//     the countdown keeps ticking down. Most artifacts resolve inside that
//     window: the measured median is 105 s (see ETA_HOLD_SEC).
//   - Past the hold it stops being noise, so the shown value climbs toward
//     the raw one at ETA_CATCHUP_PER_SEC. THIS IS THE ANTI-PIN RULE: a bus
//     that has genuinely stopped moving always gets to grow its ETA, on a
//     bounded schedule, and the guard can never park a stale number forever.
//     A guard that pinned the number would be worse than the jump — it would
//     promise a bus that is not coming.
//   - Two backstops sit under that: the shown value never falls below
//     ETA_ARRIVING_FLOOR_SEC while a real revision is being suppressed (never
//     say "arriving now" about a bus that is eight minutes out — the most
//     expensive lie in the app), and it never hides more than
//     ETA_MAX_SUPPRESSION_SEC of a revision at all.
//
// DOWNWARD revisions are never damped, only counted. Holding one back would
// tell a rider "3 min" while the bus is at the curb, and they would miss it.
// The counters (`stats.drops`) exist so the operator can see how often the
// other half of the complaint — the collapse to "1 second" — actually
// happens, before anyone builds a guard for it.
//
// The guard is a plain object the caller owns, not a global inside
// `computeUpcomingArrivals`: that function is still pure when no guard is
// passed, which is what keeps `scripts/eta-replay/` an honest measurement of
// the underlying arithmetic.

/** Upward revisions at or below this (seconds) pass through untouched. */
export const ETA_JITTER_SEC = 60;
/**
 * How long an upward revision may be suppressed before it starts paying out.
 *
 * MEASURED, not chosen. Replaying the 75 m stationary rule (`detector.ts`)
 * over 95,369 retained `raw_positions` on 2026-09-03 found 18,845 layover-
 * clock resets, of which 415 were spurious in the report-#82 sense — the bus
 * had been holding at least a minute and was still loitering within 150 m
 * thirty seconds later. The gap between such a reset and the bus genuinely
 * leaving (past 250 m) runs: p25 75 s, MEDIAN 105 s, p75 145 s, p90 226 s.
 *
 * So a 45 s hold would have covered 0.2% of them and a 60 s hold 9.4%; two
 * minutes covers 61%, and everything past it is paid out gradually rather
 * than dropped on the rider at once. Lengthen this only with a new
 * measurement — it is the single constant that trades "the number lurched"
 * against "the number was stale".
 */
export const ETA_HOLD_SEC = 120;
/** After the hold, how fast (s per real second) the shown value climbs to the raw one. */
export const ETA_CATCHUP_PER_SEC = 4;
/**
 * Hard cap on how much of an upward revision may be hidden at any instant.
 * Ten minutes: comfortably over the largest credible artifact (a re-billed
 * layover — Blue Weekend's Stop & Shop hold calibrates at 475 s) and well
 * under a whole-lap anchor flip, which is not an artifact this guard should
 * swallow whole. It also bounds the worst case: ETA_HOLD_SEC + this over
 * ETA_CATCHUP_PER_SEC, about three and a quarter minutes, is the longest the
 * rider can be shown a number the arithmetic disagrees with.
 */
export const ETA_MAX_SUPPRESSION_SEC = 600;
/** While suppressing, never show less than this — no false "arriving now". */
export const ETA_ARRIVING_FLOOR_SEC = 45;
/** No sighting of this (bus, stop) for this long → forget it and re-seed. */
export const ETA_STALE_MS = 60_000;
/** Keep at most this many keys. The trip card watches one; the saved-stop
 *  and route cards ask about every stop in a group, so the ceiling is
 *  generous and the stale sweep below does the real work. */
export const ETA_GUARD_MAX_KEYS = 2_000;
/** How often the stale sweep may run. Keeps the hot path O(1) per call. */
export const ETA_PRUNE_INTERVAL_MS = 30_000;
/** How many recent guard events to keep for inspection. */
export const ETA_GUARD_LOG_SIZE = 40;

export type EtaGuardEntry = {
  /** What the rider was last shown for this (bus, stop). */
  shownSec: number;
  /** What the arithmetic last produced, before damping. */
  rawSec: number;
  /** When those were computed (ms epoch). */
  atMs: number;
  /** Loop step at which this stop was reached — how the guard spots a departure. */
  step: number;
  /** When the current suppression began, or null when nothing is suppressed. */
  holdSinceMs: number | null;
};

export type EtaGuardEvent = {
  key: string;
  atMs: number;
  kind: "damped" | "released" | "reseeded" | "drop";
  rawSec: number;
  shownSec: number;
  /** Signed size of the revision the guard reacted to, in seconds. */
  deltaSec: number;
};

export type EtaGuardStats = {
  /** Polls on which an upward revision was damped. */
  damped: number;
  /** Suppressions that outlived the hold and had to be paid out. */
  released: number;
  /** Entries dropped because the bus departed the stop, wrapped a lap, or vanished. */
  reseeded: number;
  /** Large DOWNWARD revisions — counted, never damped. */
  drops: number;
  /** Largest single upward revision the guard has seen (seconds). */
  maxJumpSec: number;
  /** Largest single downward revision seen (seconds, positive). */
  maxDropSec: number;
  /** Sum of upward revisions damped — total seconds of lurch the rider did not see. */
  totalJumpSec: number;
  /** Keys currently suppressing something. */
  suppressing: number;
};

export type EtaGuard = {
  entries: Map<string, EtaGuardEntry>;
  stats: EtaGuardStats;
  /** Most recent events, newest last. Bounded. */
  log: EtaGuardEvent[];
  /** When the stale sweep last ran (ms epoch). */
  lastPruneMs: number;
};

/** Context the guard needs to tell "the bus went past" from "the anchor slipped". */
export type EtaGuardContext = {
  /** Loop step at which this arrival was reached (1 = next stop). */
  step: number;
  /** Number of stops in the route loop, so a lap wrap is recognisable. */
  loopLen: number;
};

export function createEtaGuard(): EtaGuard {
  return {
    entries: new Map(),
    stats: {
      damped: 0, released: 0, reseeded: 0, drops: 0,
      maxJumpSec: 0, maxDropSec: 0, totalJumpSec: 0, suppressing: 0,
    },
    log: [],
    lastPruneMs: 0,
  };
}

/** Forget everything. Called when the rider re-plans — a new pin, a new trip. */
export function resetEtaGuard(guard: EtaGuard): void {
  guard.entries.clear();
  guard.stats.suppressing = 0;
}

/**
 * The key an entry lives under. Route label included because bus names
 * (`#40`) are only unique within a route's fleet, and the stop because the
 * same vehicle owns an independent countdown at every stop ahead of it.
 */
export function etaGuardKey(routeLabel: string, busName: string, stopId: number): string {
  return `${routeLabel}|${busName}|${stopId}`;
}

function record(guard: EtaGuard, ev: EtaGuardEvent): void {
  guard.log.push(ev);
  if (guard.log.length > ETA_GUARD_LOG_SIZE) guard.log.shift();
}

/**
 * Drop entries nothing has touched in a while, cap the map's size, and take
 * the chance to recount `suppressing` exactly (the incremental count in
 * `stabilizeEta` cannot see an eviction). Throttled, so the hot path stays
 * O(1) per call — the saved-stop lists ask about every stop in a group.
 */
function prune(guard: EtaGuard, nowMs: number): void {
  if (
    nowMs - guard.lastPruneMs < ETA_PRUNE_INTERVAL_MS &&
    guard.entries.size <= ETA_GUARD_MAX_KEYS
  ) return;
  guard.lastPruneMs = nowMs;
  for (const [k, e] of guard.entries) {
    if (nowMs - e.atMs > ETA_STALE_MS) guard.entries.delete(k);
  }
  // Still over? Evict oldest-first — Map iterates in insertion order and
  // every write re-inserts, so the head is the least recently written.
  while (guard.entries.size > ETA_GUARD_MAX_KEYS) {
    const oldest = guard.entries.keys().next();
    if (oldest.done) break;
    guard.entries.delete(oldest.value);
  }
  let n = 0;
  for (const e of guard.entries.values()) if (e.holdSinceMs !== null) n++;
  guard.stats.suppressing = n;
}

/**
 * Damp an upward revision of one (bus, stop) ETA. Returns the number to show,
 * in seconds. Pass the SAME guard every poll; the guard is the only state.
 *
 * Never returns more than `rawSec` and never less than 0.
 */
export function stabilizeEta(
  guard: EtaGuard,
  key: string,
  rawSec: number,
  nowMs: number,
  ctx: EtaGuardContext,
): number {
  const prev = guard.entries.get(key);
  const write = (shownSec: number, holdSinceMs: number | null) => {
    const was = prev?.holdSinceMs != null ? 1 : 0;
    const is = holdSinceMs !== null ? 1 : 0;
    guard.stats.suppressing = Math.max(0, guard.stats.suppressing + is - was);
    guard.entries.delete(key); // re-insert so Map order tracks recency
    guard.entries.set(key, { shownSec, rawSec, atMs: nowMs, step: ctx.step, holdSinceMs });
    prune(guard, nowMs);
    return shownSec;
  };

  if (!prev) return write(rawSec, null);

  const elapsedSec = (nowMs - prev.atMs) / 1000;

  // Forget the entry and start clean when it cannot be compared:
  //   - the clock went backwards (a caller replaying, or a device clock fix);
  //   - nothing has been seen for a minute (the bus vanished from the feed and
  //     came back — its old countdown says nothing about the new sighting);
  //   - the stop is suddenly most of a lap away, which is what "the bus just
  //     drove past it" looks like. Real departures MUST reset, or the guard
  //     would keep showing "arriving now" for a bus already gone. An anchor
  //     that merely slips back a stop or two moves `step` by a stop or two and
  //     is damped like any other artifact.
  const departed = ctx.loopLen > 0 && ctx.step - prev.step > ctx.loopLen / 2;
  if (elapsedSec < 0 || elapsedSec * 1000 > ETA_STALE_MS || departed) {
    guard.stats.reseeded++;
    record(guard, {
      key, atMs: nowMs, kind: "reseeded", rawSec, shownSec: rawSec,
      deltaSec: rawSec - prev.shownSec,
    });
    return write(rawSec, null);
  }

  // What the countdown would read if it had simply ticked.
  const expected = Math.max(0, prev.shownSec - elapsedSec);
  const jump = rawSec - expected;

  // Hysteresis. Deciding to suppress takes a revision bigger than the jitter
  // allowance; STOPPING takes the raw value coming back down to the countdown.
  // Without that asymmetry an episode ended with a step of up to the whole
  // allowance — the climb converged to within 55 s of the raw value and then
  // took the last 55 s in one poll, which is the very shape being guarded
  // against.
  //
  // But the stickiness has to be broken by the arithmetic CORRECTING itself,
  // or the guard turns into the opposite bug. Replaying report #82's own
  // timeline caught it: the bus finally pulled out, the raw ETA fell 450 → 149
  // s, and because 149 was still above the suppressed countdown the episode
  // stayed open and pinned the rider at 45 s for a bus two and a half minutes
  // away. A material fall in the RAW value therefore closes the episode; the
  // ordinary rules then judge the new number on its own, which normally
  // accepts it and opens a fresh episode if it is still absurd.
  const rawFell = prev.rawSec - rawSec > ETA_JITTER_SEC;
  const engaged = prev.holdSinceMs !== null && !rawFell;
  const damp = engaged ? rawSec > expected : jump > ETA_JITTER_SEC;

  if (!damp) {
    // Down, flat, or ordinary noise: take it. The guard never holds a number
    // back from falling — a rider who is told "3 min" about a bus at the curb
    // misses it, which is worse than any jump.
    const drop = expected - rawSec;
    if (drop > ETA_JITTER_SEC) {
      guard.stats.drops++;
      if (drop > guard.stats.maxDropSec) guard.stats.maxDropSec = drop;
      record(guard, { key, atMs: nowMs, kind: "drop", rawSec, shownSec: rawSec, deltaSec: -drop });
    }
    return write(rawSec, null);
  }

  // An upward revision worth suppressing. `engaged` and not merely
  // `prev.holdSinceMs` — an episode closed by a correction must not hand its
  // elapsed hold to the next one, or the fresh episode would start already
  // past the hold and pay out immediately.
  const holdSinceMs = engaged ? prev.holdSinceMs! : nowMs;
  const heldSec = (nowMs - holdSinceMs) / 1000;
  const overSec = heldSec - ETA_HOLD_SEC;

  let shown = expected;
  if (overSec > 0) {
    // Past the hold the revision has persisted across many polls; it is real
    // news. Climb toward it at a bounded rate instead of stepping. This is
    // what stops the guard from ever pinning a stale number.
    shown = Math.max(shown, prev.shownSec + ETA_CATCHUP_PER_SEC * elapsedSec);
  }
  // Never say "arriving now" while hiding minutes of revision.
  shown = Math.max(shown, Math.min(rawSec, ETA_ARRIVING_FLOOR_SEC));
  // Never hide more than this much of it, whatever the timing says.
  shown = Math.max(shown, rawSec - ETA_MAX_SUPPRESSION_SEC);
  shown = Math.min(shown, rawSec);

  guard.stats.damped++;
  guard.stats.totalJumpSec += jump;
  if (jump > guard.stats.maxJumpSec) guard.stats.maxJumpSec = jump;
  // Count a release exactly once per episode: the poll on which the hold
  // expires, not every poll of the climb that follows.
  const prevHeldSec = engaged ? (prev.atMs - holdSinceMs) / 1000 : 0;
  const crossedHold = overSec > 0 && prevHeldSec <= ETA_HOLD_SEC;
  if (crossedHold) guard.stats.released++;
  // One log line per EPISODE, not per poll — an episode can run for dozens of
  // polls and would otherwise flush every other key out of the ring. The
  // counters above still count every poll.
  if (!engaged || crossedHold) {
    record(guard, {
      key, atMs: nowMs, kind: crossedHold ? "released" : "damped",
      rawSec, shownSec: shown, deltaSec: jump,
    });
  }
  return write(shown, holdSinceMs);
}

/**
 * The app's guard. One per page: `computeUpcomingArrivals` is called from
 * several places each poll for the same (bus, stop), and they must all show
 * the rider the same number.
 *
 * Exposed on `window.__shuttleEtaGuard` so a browser harness (or the operator
 * in devtools) can read `.stats` and `.log` and answer "how often is reality
 * jumping underneath us?" without a schema change or a network call.
 */
export const etaGuard: EtaGuard = createEtaGuard();

declare global {
  interface Window { __shuttleEtaGuard?: EtaGuard }
}

if (typeof window !== "undefined") {
  try { window.__shuttleEtaGuard = etaGuard; } catch { /* never break the app to publish a counter */ }
}
