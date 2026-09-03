import { beforeEach, describe, expect, it } from "vitest";

import {
  createEtaGuard, etaGuardKey, resetEtaGuard, stabilizeEta,
  ETA_ARRIVING_FLOOR_SEC, ETA_CATCHUP_PER_SEC, ETA_HOLD_SEC, ETA_JITTER_SEC,
  ETA_MAX_SUPPRESSION_SEC, ETA_STALE_MS,
  type EtaGuard,
} from "./etaStability";

const T0 = new Date("2026-09-02T20:44:00Z").getTime();
const KEY = etaGuardKey("Red", "316", 146);
/** A stop five hops ahead on a 20-stop loop — the ordinary case. */
const CTX = { step: 5, loopLen: 20 };

let g: EtaGuard;
beforeEach(() => { g = createEtaGuard(); });

/** Feed one poll and get the number the rider would see. */
const poll = (rawSec: number, atMs: number, ctx = CTX) =>
  stabilizeEta(g, KEY, rawSec, atMs, ctx);

describe("stabilizeEta — the shape of a countdown", () => {
  it("passes the first sighting through untouched", () => {
    expect(poll(300, T0)).toBe(300);
    expect(g.stats.damped).toBe(0);
  });

  it("lets a countdown tick down freely, poll after poll", () => {
    poll(300, T0);
    expect(poll(295, T0 + 5_000)).toBe(295);
    expect(poll(290, T0 + 10_000)).toBe(290);
    expect(poll(120, T0 + 15_000)).toBe(120); // a big DROP is never damped
    expect(g.stats.damped).toBe(0);
  });

  it("does not ratchet: ordinary up-and-down noise passes straight through", () => {
    // A guard that clamped every upward wobble would bias the whole countdown
    // to the optimistic tail and reach zero early. Wobble ±20 s for a minute
    // and the shown value must equal the raw one every single time.
    let t = T0;
    let raw = 600;
    poll(raw, t);
    for (let i = 0; i < 12; i++) {
      t += 5_000;
      raw = 600 - i * 5 + (i % 2 === 0 ? 20 : -20);
      expect(poll(raw, t)).toBe(raw);
    }
    expect(g.stats.damped).toBe(0);
  });

  it("passes an upward revision of exactly the jitter allowance", () => {
    poll(300, T0);
    // expected = 295 after 5 s; +60 is the allowance, so 355 is still free.
    expect(poll(295 + ETA_JITTER_SEC, T0 + 5_000)).toBe(295 + ETA_JITTER_SEC);
    expect(g.stats.damped).toBe(0);
  });
});

describe("report #82 — the layover clock resets under a parked bus", () => {
  // Red #316 sat in the Winchester yard. Its GPS wandered ~30 m a poll, one
  // fix crossed the stationary radius, the layover clock restarted, and the
  // raw ETA jumped ~5 min on a bus that had not moved and left 23 s later.
  const RESET_JUMP = 300;

  it("hides the jump completely while it lasts", () => {
    expect(poll(180, T0)).toBe(180);                    // "3 min"
    // 20:45:23 — the clock resets, the arithmetic re-bills the whole hold.
    expect(poll(180 + RESET_JUMP, T0 + 5_000)).toBe(175);
    expect(poll(180 + RESET_JUMP, T0 + 10_000)).toBe(170);
    expect(poll(180 + RESET_JUMP, T0 + 15_000)).toBe(165);
    // The rider's countdown kept ticking down through the whole episode:
    // never "3 min → 8 min", never a stalled number.
    expect(g.stats.damped).toBe(3);
    // The gap the guard was holding grew as the countdown kept ticking down
    // underneath it: 300 s at the first poll, 315 s by the third.
    expect(g.stats.maxJumpSec).toBeCloseTo(RESET_JUMP + 15, 0);
  });

  it("resumes silently when the bus really does pull out", () => {
    poll(180, T0);
    for (let i = 1; i <= 4; i++) poll(480, T0 + i * 5_000);  // 20 s of artifact
    // 20:46:23 the bus departs; the credit is real again and raw agrees.
    const shown = poll(150, T0 + 25_000);
    expect(shown).toBe(150);
    expect(g.stats.released).toBe(0);   // it never had to pay anything out
    expect(g.entries.get(KEY)!.holdSinceMs).toBeNull();
  });

  it("never shows the rider a number larger than the previous poll's", () => {
    // The property the operator actually asked for, exercised over the whole
    // recorded sequence: a countdown may stall, it may not run backwards.
    const raws = [180, 175, 480, 475, 470, 465, 150, 145, 140];
    let last = Infinity;
    raws.forEach((raw, i) => {
      const shown = poll(raw, T0 + i * 5_000);
      expect(shown).toBeLessThanOrEqual(last + ETA_JITTER_SEC);
      last = shown;
    });
  });
});

describe("a bus that genuinely stops moving still gets to grow its ETA", () => {
  // The anti-pin rule. A guard that pinned a stale number would be worse than
  // the jump: it would promise a bus that is not coming.
  it("pays the revision out in full once the hold expires", () => {
    poll(600, T0);
    let t = T0;
    let shown = 600;
    // The raw ETA jumps +5 min and STAYS there — a real slowdown, not a blip.
    for (let i = 1; i <= 60; i++) {          // 5 minutes of polls
      t = T0 + i * 5_000;
      shown = poll(900, t);
    }
    expect(shown).toBe(900);                 // fully caught up
    expect(g.stats.released).toBe(1);        // counted exactly once
  });

  it("starts climbing within a bounded time and at a bounded rate", () => {
    poll(600, T0);
    let shown = poll(900, T0 + 5_000);   // the revision arrives; hold begins
    let climbedAtSec: number | null = null;
    let biggestStep = 0;
    for (let i = 2; i <= 60; i++) {
      const prev = shown;
      shown = poll(900, T0 + i * 5_000);
      if (shown > prev) {
        climbedAtSec ??= i * 5 - 5;                 // seconds since the hold began
        biggestStep = Math.max(biggestStep, shown - prev);
      } else if (climbedAtSec === null) {
        // Before it starts climbing, the number only ever ticks DOWN.
        expect(shown).toBeLessThan(prev);
      }
    }
    // It waits out the hold, then climbs — no step larger than the catch-up
    // rate allows, so the rider sees a drift, never a lurch.
    expect(climbedAtSec).not.toBeNull();
    expect(climbedAtSec!).toBeGreaterThanOrEqual(ETA_HOLD_SEC);
    expect(climbedAtSec!).toBeLessThanOrEqual(ETA_HOLD_SEC + 10);
    expect(biggestStep).toBeLessThanOrEqual(ETA_CATCHUP_PER_SEC * 5 + 0.001);
  });

  it("never hides more than the suppression cap, even at the first poll", () => {
    poll(120, T0);
    // An anchor flip to the far side of the loop: +30 min in one poll. Damping
    // that away entirely would be a lie, not a safety net.
    const shown = poll(2_000, T0 + 5_000);
    expect(shown).toBeGreaterThanOrEqual(2_000 - ETA_MAX_SUPPRESSION_SEC);
  });

  it("never says 'arriving now' about a bus that is minutes away", () => {
    poll(20, T0);
    // The bus is 20 s out, then the arithmetic says 5 min. Ticking to zero
    // would put a rider at the curb watching nothing arrive — the most
    // expensive lie in the app — so the shown value floors instead.
    expect(poll(300, T0 + 5_000)).toBe(ETA_ARRIVING_FLOOR_SEC);
    expect(poll(300, T0 + 10_000)).toBe(ETA_ARRIVING_FLOOR_SEC);
    // With a bigger revision the suppression cap binds first and the floor is
    // simply never reached — both backstops point the same way.
    resetEtaGuard(g);
    poll(20, T0);
    expect(poll(480, T0 + 5_000)).toBeGreaterThanOrEqual(ETA_ARRIVING_FLOOR_SEC);
  });

  it("floors at the raw value when the bus really is seconds away", () => {
    poll(60, T0);
    // raw below the floor: nothing to suppress, show the truth.
    expect(poll(10, T0 + 5_000)).toBe(10);
  });
});

describe("state is keyed, scoped, and cleared", () => {
  it("keeps one countdown per (route, bus, stop)", () => {
    expect(etaGuardKey("Red", "316", 146)).not.toBe(etaGuardKey("Red", "316", 11));
    expect(etaGuardKey("Red", "316", 146)).not.toBe(etaGuardKey("Red", "40", 146));
    expect(etaGuardKey("Red", "316", 146)).not.toBe(etaGuardKey("Blue Day", "316", 146));
  });

  it("does not let one bus's suppression touch another's number", () => {
    const other = etaGuardKey("Red", "40", 146);
    stabilizeEta(g, KEY, 180, T0, CTX);
    stabilizeEta(g, other, 180, T0, CTX);
    expect(stabilizeEta(g, KEY, 480, T0 + 5_000, CTX)).toBe(175);
    expect(stabilizeEta(g, other, 180, T0 + 5_000, CTX)).toBe(180);
  });

  it("a pin change (resetEtaGuard) makes the next poll authoritative", () => {
    poll(180, T0);
    expect(poll(480, T0 + 5_000)).toBe(175);   // suppressing
    resetEtaGuard(g);
    expect(g.stats.suppressing).toBe(0);
    // The rider re-planned. Whatever the arithmetic says now is the truth.
    expect(poll(480, T0 + 10_000)).toBe(480);
  });

  it("a bus that departs the stop restarts its countdown instead of being damped", () => {
    // Two hops out, then it drives past: the stop is now a whole loop away.
    // That upward revision is real — damping it would keep counting down to a
    // bus already gone.
    poll(60, T0, { step: 2, loopLen: 20 });
    const shown = poll(1_400, T0 + 5_000, { step: 21, loopLen: 20 });
    expect(shown).toBe(1_400);
    expect(g.stats.reseeded).toBe(1);
    expect(g.stats.damped).toBe(0);
  });

  it("an anchor that merely slips back a stop or two is still damped", () => {
    // Same upward direction, but the stop moved a couple of steps, not a lap
    // — the signature of a GPS wobble, which is exactly what the guard is for.
    poll(180, T0, { step: 5, loopLen: 20 });
    const shown = poll(480, T0 + 5_000, { step: 7, loopLen: 20 });
    expect(shown).toBe(175);
    expect(g.stats.damped).toBe(1);
    expect(g.stats.reseeded).toBe(0);
  });

  it("a bus that vanishes from the feed and returns starts clean", () => {
    poll(180, T0);
    // Gone for longer than the stale window (a feed gap, a tab in the
    // background, a bus id reissue). Its old countdown says nothing about the
    // new sighting, so it must not damp it.
    const shown = poll(900, T0 + ETA_STALE_MS + 5_000);
    expect(shown).toBe(900);
    expect(g.stats.reseeded).toBe(1);
  });

  it("survives a clock that jumps backwards", () => {
    poll(180, T0);
    expect(poll(240, T0 - 60_000)).toBe(240);
    expect(g.stats.reseeded).toBe(1);
  });

  it("is idempotent within one poll — several call sites, one number", () => {
    // TransitMap asks for the same (bus, stop) from the trip card, the
    // next-bus line and the stop cards in a single render. They must agree.
    poll(180, T0);
    const a = poll(480, T0 + 5_000);
    const b = poll(480, T0 + 5_000);
    const c = poll(480, T0 + 5_000);
    expect([b, c]).toEqual([a, a]);
  });
});

describe("the guard records what it hid", () => {
  it("counts damped polls, the largest jump, and the seconds suppressed", () => {
    poll(180, T0);
    poll(480, T0 + 5_000);
    poll(500, T0 + 10_000);
    expect(g.stats.damped).toBe(2);
    expect(g.stats.maxJumpSec).toBeGreaterThan(300);
    expect(g.stats.totalJumpSec).toBeGreaterThan(600);
    expect(g.stats.suppressing).toBe(1);
    // One line per EPISODE, not per poll: two damped polls, one entry, stamped
    // with the revision that opened it.
    expect(g.log).toHaveLength(1);
    expect(g.log.at(-1)).toMatchObject({ key: KEY, kind: "damped", rawSec: 480 });
  });

  it("counts large DOWNWARD revisions without damping them", () => {
    // The other half of the operator's complaint — "saying a bus is 10min away
    // and then a few seconds later dropping to 1 second". Never suppressed: a
    // rider told 3 min about a bus at the curb misses it. Counted, so the
    // question can be answered with data before anyone builds a guard for it.
    poll(600, T0);
    expect(poll(1, T0 + 5_000)).toBe(1);
    expect(g.stats.drops).toBe(1);
    expect(g.stats.maxDropSec).toBeGreaterThan(590);
    expect(g.log.at(-1)).toMatchObject({ kind: "drop" });
  });

  it("keeps the event log bounded", () => {
    poll(180, T0);
    for (let i = 1; i <= 200; i++) poll(5_000, T0 + i * 5_000);
    expect(g.log.length).toBeLessThanOrEqual(40);
  });

  it("evicts stale keys instead of growing without bound", () => {
    for (let i = 0; i < 50; i++) stabilizeEta(g, `k${i}`, 300, T0, CTX);
    expect(g.entries.size).toBe(50);
    // Long after, one key reports again; the sweep clears the abandoned ones.
    stabilizeEta(g, "k0", 300, T0 + ETA_STALE_MS * 3, CTX);
    expect(g.entries.size).toBe(1);
  });
});

/**
 * The recorded incident, replayed poll by poll.
 *
 * Red #316 in the Winchester yard, 2026-09-03. Verified against production
 * `raw_positions`: the bus's stationary anchor was set at 20:40:13; at
 * 20:45:18 a wandering GPS fix put it 91.2 m away, past the collector's 75 m
 * radius, and the layover clock reset after holding for 305 s. The bus had
 * not moved. It genuinely pulled out at 20:46:23 and reached the next stop at
 * 20:46:48.
 *
 * `raw` below is the arithmetic's own output across that window, with t in
 * seconds from report #80's frame (20:44:54): three minutes ticking down, the
 * re-billed hold at t=24, the fresh hold slowly accruing credit, and the real
 * remaining time from t=89.
 */
describe("report #82, replayed against the recorded timeline", () => {
  const raw = (t: number) => {
    if (t < 24) return 180 - t;              // "3 min", counting down
    if (t < 89) return 480 - (t - 24) * 0.5; // the clock resets; ~8 min
    return Math.max(20, 150 - (t - 89));     // it left; the honest remainder
  };

  it("turns a five-minute lurch into a countdown", () => {
    const g2 = createEtaGuard();
    const shownMin: number[] = [];
    let worstRise = 0;
    let prev: number | null = null;
    for (let t = 0; t <= 140; t += 5) {
      const shown = stabilizeEta(g2, KEY, raw(t), T0 + t * 1_000, { step: 4, loopLen: 20 });
      if (prev !== null) worstRise = Math.max(worstRise, shown - prev);
      prev = shown;
      shownMin.push(Math.round(shown / 60));
    }
    // What the rider actually reads. The complaint — "it jumped from 3min to
    // 8 min!" — is gone: the printed minutes only ever go down.
    expect(Math.max(...shownMin)).toBe(3);
    expect(shownMin).toEqual([...shownMin].sort((a, b) => b - a));
    // The only poll that raises the number at all is the honest one — the bus
    // pulls out and the arithmetic corrects downward past the countdown — and
    // even that stays inside the jitter allowance, well under the printed
    // minute. Nothing in the episode itself moves the number upward.
    expect(worstRise).toBeLessThanOrEqual(ETA_JITTER_SEC);
    expect(g2.stats.damped).toBeGreaterThan(0);
    expect(g2.stats.maxJumpSec).toBeGreaterThan(300);
  });

  it("gets out of the way the moment the arithmetic corrects itself", () => {
    // The failure this replay caught in an earlier draft: the bus pulls out,
    // the raw ETA falls 450 → 149 s, and because 149 was still above the
    // suppressed countdown the guard kept suppressing — pinning the rider at
    // the 45 s floor for a bus two and a half minutes away. A guard that
    // holds a stale number is worse than the jump it prevents.
    const g2 = createEtaGuard();
    for (let t = 0; t <= 85; t += 5) stabilizeEta(g2, KEY, raw(t), T0 + t * 1_000, { step: 4, loopLen: 20 });
    const afterDeparture = stabilizeEta(g2, KEY, raw(90), T0 + 90_000, { step: 4, loopLen: 20 });
    expect(afterDeparture).toBe(raw(90));
    expect(g2.entries.get(KEY)!.holdSinceMs).toBeNull();
  });

  it("opens a fresh episode when the correction is still a lurch", () => {
    // A raw value that falls, but not far enough to stop being a lurch, must
    // not be waved through merely because it fell.
    const g2 = createEtaGuard();
    stabilizeEta(g2, KEY, 180, T0, CTX);
    expect(stabilizeEta(g2, KEY, 600, T0 + 5_000, CTX)).toBe(175);
    const shown = stabilizeEta(g2, KEY, 400, T0 + 10_000, CTX);
    expect(shown).toBe(170);                       // still counting down
    expect(g2.entries.get(KEY)!.holdSinceMs).not.toBeNull();
  });
});
