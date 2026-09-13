import { describe, expect, it } from "vitest";

import {
  AT_STOP_WALK_SEC,
  canStillCatch,
  computeLeaveAlert,
  findReminderOption,
  HEADS_UP_LEAD_SEC,
  LEAVE_BUFFER_SEC,
  leaveAlertMessage,
  markFired,
  NO_PINGS_FIRED,
  secUntilLeave,
  type FiredPings,
  type LeaveAlertInput,
} from "./leaveAlert";
import { canCatch, STOP_DWELL_SEC } from "./planner";

const NOW = 1_700_000_000_000;

/** Fresh input: ETA computed right now, so remaining === busEtaSec. */
const input = (busEtaSec: number, walkToSec: number, over: Partial<LeaveAlertInput> = {}): LeaveAlertInput => ({
  busEtaSec, walkToSec, computedAtMs: NOW, nowMs: NOW, ...over,
});

/** busEtaSec such that secUntilLeave === untilLeave for a fresh input. */
const etaFor = (untilLeave: number, walkToSec: number) =>
  untilLeave + walkToSec + LEAVE_BUFFER_SEC;

describe("secUntilLeave", () => {
  it("is ETA minus walk minus the safety buffer", () => {
    // 10 min ETA, 3 min walk → leave in 10 − 3 − 0.5 = 6.5 min.
    expect(secUntilLeave(input(600, 180))).toBe(600 - 180 - LEAVE_BUFFER_SEC);
  });

  it("counts down elapsed time since the ETA was computed", () => {
    // Computed 60 s ago: a 600 s ETA has 540 s remaining. Same clock math
    // the on-screen countdown uses (remainingSec), so the ping and the
    // number the rider is watching agree.
    const s = input(600, 180, { computedAtMs: NOW - 60_000 });
    expect(secUntilLeave(s)).toBe(540 - 180 - LEAVE_BUFFER_SEC);
  });

  it("goes negative when the rider is already late", () => {
    expect(secUntilLeave(input(60, 180))).toBeLessThan(0);
  });
});

describe("computeLeaveAlert — normal sequence", () => {
  const walk = 180; // 3 min

  it("stays silent while leave-time is more than 5 min out", () => {
    expect(computeLeaveAlert(input(etaFor(HEADS_UP_LEAD_SEC + 1, walk), walk), NO_PINGS_FIRED)).toBeNull();
    expect(computeLeaveAlert(input(3600, walk), NO_PINGS_FIRED)).toBeNull();
  });

  it("fires heads_up when leave-time drops to 5 min out (boundary inclusive)", () => {
    expect(computeLeaveAlert(input(etaFor(HEADS_UP_LEAD_SEC, walk), walk), NO_PINGS_FIRED)).toBe("heads_up");
  });

  it("fires heads_up once, then leave_now at T−0, then nothing", () => {
    let fired: FiredPings = NO_PINGS_FIRED;

    // T−5 window
    const p1 = computeLeaveAlert(input(etaFor(290, walk), walk), fired);
    expect(p1).toBe("heads_up");
    fired = markFired(fired, p1!);

    // Still in the window a tick later — no repeat.
    expect(computeLeaveAlert(input(etaFor(280, walk), walk), fired)).toBeNull();
    expect(computeLeaveAlert(input(etaFor(5, walk), walk), fired)).toBeNull();

    // T−0
    const p2 = computeLeaveAlert(input(etaFor(0, walk), walk), fired);
    expect(p2).toBe("leave_now");
    fired = markFired(fired, p2!);

    // Past T−0 — no repeat, ever.
    expect(computeLeaveAlert(input(etaFor(-30, walk), walk), fired)).toBeNull();
    expect(computeLeaveAlert(input(etaFor(-600, walk), walk), fired)).toBeNull();
  });

  it("counts down a stale ETA before judging the window", () => {
    // Fresh, this would be far outside T−5 (untilLeave 600). But computed
    // 400 s ago it's really untilLeave 200 → heads_up.
    const s = input(etaFor(600, walk), walk, { computedAtMs: NOW - 400_000 });
    expect(computeLeaveAlert(s, NO_PINGS_FIRED)).toBe("heads_up");
  });
});

describe("computeLeaveAlert — late arm", () => {
  const walk = 240; // 4 min

  it("armed inside T−5: fires only heads_up now, leave_now later", () => {
    let fired: FiredPings = NO_PINGS_FIRED;
    const p1 = computeLeaveAlert(input(etaFor(120, walk), walk), fired);
    expect(p1).toBe("heads_up");
    fired = markFired(fired, p1!);
    expect(fired.leaveNow).toBe(false); // leave_now still owed

    const p2 = computeLeaveAlert(input(etaFor(-1, walk), walk), fired);
    expect(p2).toBe("leave_now");
  });

  it("armed inside T−0: fires only leave_now — never both back-to-back", () => {
    let fired: FiredPings = NO_PINGS_FIRED;
    const p1 = computeLeaveAlert(input(etaFor(-10, walk), walk), fired);
    expect(p1).toBe("leave_now");
    fired = markFired(fired, p1!);

    // Both pings recorded fired: a later tick in either window is silent.
    expect(fired).toEqual({ headsUp: true, leaveNow: true });
    expect(computeLeaveAlert(input(etaFor(-11, walk), walk), fired)).toBeNull();
    expect(computeLeaveAlert(input(etaFor(120, walk), walk), fired)).toBeNull();
  });

  it("fires leave_now exactly at the boundary (untilLeave === 0)", () => {
    expect(computeLeaveAlert(input(etaFor(0, walk), walk), NO_PINGS_FIRED)).toBe("leave_now");
  });
});

describe("computeLeaveAlert — at-stop suppression", () => {
  it("never fires when the walk is under 60 s, in any window", () => {
    const walk = AT_STOP_WALK_SEC - 1;
    expect(computeLeaveAlert(input(etaFor(300, walk), walk), NO_PINGS_FIRED)).toBeNull();
    expect(computeLeaveAlert(input(etaFor(100, walk), walk), NO_PINGS_FIRED)).toBeNull();
    expect(computeLeaveAlert(input(etaFor(0, walk), walk), NO_PINGS_FIRED)).toBeNull();
    expect(computeLeaveAlert(input(etaFor(-300, walk), walk), NO_PINGS_FIRED)).toBeNull();
  });

  it("a 60 s walk is far enough to remind", () => {
    const walk = AT_STOP_WALK_SEC;
    expect(computeLeaveAlert(input(etaFor(0, walk), walk), NO_PINGS_FIRED)).toBe("leave_now");
  });
});

describe("computeLeaveAlert — ETA jumps back up (bus pinned/switched)", () => {
  const walk = 180;

  it("heads_up never re-fires after the ETA leaves and re-enters T−5", () => {
    let fired: FiredPings = NO_PINGS_FIRED;
    fired = markFired(fired, computeLeaveAlert(input(etaFor(200, walk), walk), fired)!);

    // ETA jumps way up (switched to a farther bus) — silent…
    expect(computeLeaveAlert(input(etaFor(900, walk), walk), fired)).toBeNull();
    // …and silent again when it drops back into the heads-up window.
    expect(computeLeaveAlert(input(etaFor(250, walk), walk), fired)).toBeNull();
    // leave_now still fires when its moment truly comes.
    expect(computeLeaveAlert(input(etaFor(0, walk), walk), fired)).toBe("leave_now");
  });

  it("leave_now never re-fires after an ETA bounce", () => {
    let fired: FiredPings = NO_PINGS_FIRED;
    fired = markFired(fired, computeLeaveAlert(input(etaFor(-5, walk), walk), fired)!);
    expect(computeLeaveAlert(input(etaFor(600, walk), walk), fired)).toBeNull();
    expect(computeLeaveAlert(input(etaFor(-5, walk), walk), fired)).toBeNull();
  });
});

describe("markFired", () => {
  it("heads_up marks only heads_up", () => {
    expect(markFired(NO_PINGS_FIRED, "heads_up")).toEqual({ headsUp: true, leaveNow: false });
  });
  it("leave_now marks both — no belated heads_up after leave-time", () => {
    expect(markFired(NO_PINGS_FIRED, "leave_now")).toEqual({ headsUp: true, leaveNow: true });
  });
  it("does not mutate its input", () => {
    const before: FiredPings = { headsUp: false, leaveNow: false };
    markFired(before, "leave_now");
    expect(before).toEqual({ headsUp: false, leaveNow: false });
  });
});

describe("leaveAlertMessage", () => {
  it("heads_up: '<route> in N min — leave in M min'", () => {
    // 3 min walk, leave in 5 min → bus in 8.5 min → "8 min" (fmtMin floors).
    const s = input(etaFor(300, 180), 180);
    expect(leaveAlertMessage("heads_up", "Blue Day", s)).toBe("Blue Day in 8 min — leave in 5 min");
  });

  it("heads_up on a late arm shows the shorter real lead", () => {
    const s = input(etaFor(180, 180), 180); // leave in 3 min → bus in 6.5
    expect(leaveAlertMessage("heads_up", "Orange Day", s)).toBe("Orange Day in 6 min — leave in 3 min");
  });

  it("leave_now: 'Time to leave — <route> in N min, M min walk'", () => {
    const s = input(etaFor(0, 180), 180); // bus in walk+buffer = 3.5 min
    expect(leaveAlertMessage("leave_now", "Blue Day", s)).toBe("Time to leave — Blue Day in 3 min, 3 min walk");
  });

  it("uses 'min' spelling throughout, never a bare 'm'", () => {
    const s = input(etaFor(300, 240), 240);
    for (const msg of [
      leaveAlertMessage("heads_up", "Red", s),
      leaveAlertMessage("leave_now", "Red", s),
    ]) {
      expect(msg).toMatch(/min/);
      expect(msg).not.toMatch(/\d+m\b/);
    }
  });

  it("counts down a stale ETA in the message like the on-screen number", () => {
    // 8.5 min ETA computed 2 min ago reads "6 min", matching the card.
    const s = input(510, 180, { computedAtMs: NOW - 120_000 });
    expect(leaveAlertMessage("leave_now", "Blue Day", s)).toMatch(/^Time to leave — Blue Day in 6 min/);
  });

  it("prefixes the rain warning when rain is likely, on both pings", () => {
    const s = input(etaFor(300, 180), 180);
    expect(leaveAlertMessage("heads_up", "Blue Day", s, true))
      .toBe("🌧 Rain likely — Blue Day in 8 min — leave in 5 min");
    const t = input(etaFor(0, 180), 180);
    expect(leaveAlertMessage("leave_now", "Blue Day", t, true))
      .toBe("🌧 Rain likely — Time to leave — Blue Day in 3 min, 3 min walk");
  });

  it("says nothing about rain by default", () => {
    const s = input(etaFor(300, 180), 180);
    expect(leaveAlertMessage("heads_up", "Blue Day", s)).not.toMatch(/🌧|[Rr]ain/);
    expect(leaveAlertMessage("heads_up", "Blue Day", s, false)).not.toMatch(/🌧|[Rr]ain/);
  });
});

describe("findReminderOption — disarm when the bus/option disappears", () => {
  const shuttle = { mode: "shuttle", routeLabel: "Blue Day", busEtaSec: 300, walkToSec: 180 };
  const walkOpt = { mode: "walk", routeLabel: "Walk", walkToSec: 0 };

  it("returns the armed shuttle option while it is live", () => {
    expect(findReminderOption([walkOpt, shuttle], "Blue Day")).toBe(shuttle);
  });

  it("null when the option is gone from the plan (route stopped running)", () => {
    expect(findReminderOption([walkOpt], "Blue Day")).toBeNull();
    expect(findReminderOption([], "Blue Day")).toBeNull();
    expect(findReminderOption(null, "Blue Day")).toBeNull();
    expect(findReminderOption(undefined, "Blue Day")).toBeNull();
  });

  it("null when the option is flagged departed", () => {
    expect(findReminderOption([{ ...shuttle, departed: true }], "Blue Day")).toBeNull();
  });

  it("null when the option has no live bus ETA (future mode / no bus)", () => {
    expect(findReminderOption([{ ...shuttle, busEtaSec: undefined }], "Blue Day")).toBeNull();
  });

  it("never follows a walk option even under the armed label", () => {
    expect(findReminderOption([{ ...walkOpt, routeLabel: "Blue Day" }], "Blue Day")).toBeNull();
  });
});

/**
 * THE LIVE WALK, NOT THE PLANNED ONE (report #108 follow-up).
 *
 * The card and the ping must answer with the same walk. Report #108's fix made
 * the CARD print the walk its total was priced on (`liveWalkToSec`, see
 * optionLegs.ts); this module was left reading `walkToSec`, the walk planTrip
 * measured from the search origin. On the operator's own card those were 46 min
 * and 17 min — so the ping fired 29 minutes of ETA after the rider had to
 * leave, and printed "17 min walk" beside a card reading 46.
 *
 * The reported card, to the second: planned walk 17 min, the walk the total was
 * actually built from 46 min (the rider had walked away from the board stop).
 */
const PLANNED = 17 * 60; // 1020 s — what planTrip measured from the origin
const LIVE = 46 * 60;    // 2760 s — what the live recompute priced

/** The reported card's two walks, with the live one in force. */
const bothWalks = (busEtaSec: number): LeaveAlertInput => ({
  busEtaSec, walkToSec: PLANNED, liveWalkToSec: LIVE, computedAtMs: NOW, nowMs: NOW,
});

describe("leave alerts follow the live walk (report #108 follow-up)", () => {
  it("times leaving by the walk the rider actually faces", () => {
    // It is time to leave when the bus is walk + buffer away.
    expect(secUntilLeave(bothWalks(LIVE + LEAVE_BUFFER_SEC))).toBe(0);
    // Read off the PLANNED walk the same moment looks 29 minutes early.
    expect(LIVE - PLANNED).toBe(29 * 60);
  });

  it("fires leave_now at the moment the rider must leave, not 29 min later", () => {
    const s = bothWalks(LIVE + LEAVE_BUFFER_SEC);
    expect(computeLeaveAlert(s, NO_PINGS_FIRED)).toBe("leave_now");
  });

  it("RIDER HARM: by the old ping's moment the rider is 28 min past rescue", () => {
    // Keyed to the planned walk, leave_now waited until the bus was
    // PLANNED + buffer away — 1050 s of ETA left. A rider who needs LIVE
    // (2760 s) to reach the stop is 1710 s short at that instant, so the
    // honest reading of the moment the old ping fired is deeply NEGATIVE:
    // leave-time is long gone and the bus cannot be caught.
    const tooLate = PLANNED + LEAVE_BUFFER_SEC;
    expect(secUntilLeave(bothWalks(tooLate))).toBe(-(1710 + LEAVE_BUFFER_SEC));
    expect(LIVE - tooLate).toBe(1710); // the walk gap, to the second
  });

  it("fires heads_up 5 min before the live leave-time", () => {
    const s = bothWalks(LIVE + LEAVE_BUFFER_SEC + HEADS_UP_LEAD_SEC);
    expect(secUntilLeave(s)).toBe(HEADS_UP_LEAD_SEC);
    expect(computeLeaveAlert(s, NO_PINGS_FIRED)).toBe("heads_up");
  });

  it("prints the walk the card prints — never two answers on one screen", () => {
    const s = bothWalks(LIVE + LEAVE_BUFFER_SEC);
    // The card says 46 min; so does the ping.
    expect(leaveAlertMessage("leave_now", "Blue Day", s))
      .toBe("Time to leave — Blue Day in 46 min, 46 min walk");
    const h = bothWalks(LIVE + LEAVE_BUFFER_SEC + HEADS_UP_LEAD_SEC);
    expect(leaveAlertMessage("heads_up", "Blue Day", h))
      .toBe("Blue Day in 51 min — leave in 5 min");
  });

  it("suppresses the ping for a rider who has REACHED the stop (live walk 0)", () => {
    // The mirror case. planTrip measured a 5-minute walk; the rider is now
    // inside AT_PLACE_M, so the live walk is 0 and the card shows no walk chip
    // at all. They can see the bus — a ping is noise, in every window.
    const atStop = (busEtaSec: number): LeaveAlertInput => ({
      busEtaSec, walkToSec: 300, liveWalkToSec: 0, computedAtMs: NOW, nowMs: NOW,
    });
    expect(computeLeaveAlert(atStop(330), NO_PINGS_FIRED)).toBeNull();
    expect(computeLeaveAlert(atStop(600), NO_PINGS_FIRED)).toBeNull();
    expect(computeLeaveAlert(atStop(60), NO_PINGS_FIRED)).toBeNull();
  });

  it("DOES ping a rider who searched at the stop and then walked away", () => {
    // The same report, the other direction: walkToSec is 0 because the rider
    // searched from the board stop, and planner.ts holds it constant. They have
    // since walked 5 minutes off, so the reminder is exactly what they need.
    const walkedOff = (busEtaSec: number): LeaveAlertInput => ({
      busEtaSec, walkToSec: 0, liveWalkToSec: 300, computedAtMs: NOW, nowMs: NOW,
    });
    expect(computeLeaveAlert(walkedOff(330), NO_PINGS_FIRED)).toBe("leave_now");
    expect(computeLeaveAlert(walkedOff(630), NO_PINGS_FIRED)).toBe("heads_up");
  });

  it("REGRESSION GUARD: no live walk → the plan's own walk, unchanged", () => {
    // Future-mode plans and any option the live recompute never touched.
    const s: LeaveAlertInput = { busEtaSec: 210, walkToSec: 180, computedAtMs: NOW, nowMs: NOW };
    expect(secUntilLeave(s)).toBe(0);
    expect(computeLeaveAlert(s, NO_PINGS_FIRED)).toBe("leave_now");
    expect(leaveAlertMessage("leave_now", "Red", s)).toBe("Time to leave — Red in 3 min, 3 min walk");
  });
});

/**
 * THE TERMINAL PING MAY NOT FIRE ON A PROMISE IT CANNOT KEEP.
 *
 * `leave_now` is the LAST ping and it DISARMS the reminder (TransitMap:
 * `if (ping === "leave_now") setReminder(null)`), so one bad tick does not
 * mis-time a notification — it spends a reminder the rider cannot get back,
 * and the app is silent for the rest of the trip. Keyed to the PLANNED walk
 * that tick could not exist (planTrip holds the number constant). Keyed to the
 * LIVE walk it can, two measured ways, and both are cases where the sentence
 * "time to leave and you will make it" is FALSE — so one rule covers both:
 * the planner's own `canCatch`.
 */
describe("leave_now never fires for a bus the rider can no longer make", () => {
  const HEADS_UP_DONE: FiredPings = { headsUp: true, leaveNow: false };

  /** The reported card's walks, with a LIVE walk we vary tick by tick. */
  const tick = (liveWalkToSec: number, busEtaSec = 700): LeaveAlertInput =>
    ({ busEtaSec, walkToSec: 17 * 60, liveWalkToSec, computedAtMs: NOW, nowMs: NOW });

  it("ONE WILD GPS FIX MUST NOT SPEND THE REMINDER", () => {
    // Nothing filters a fix on the way in: geoWatch.ts hands every position to
    // onFix, `coords.accuracy` is read nowhere in web/src, and the rescue
    // one-shot takes a network-accuracy fix up to two minutes old.
    //
    // heads_up has fired; the rider is a 5-minute walk out and the bus is 700 s
    // away, so leave-time is still 370 s off and the engine is silent.
    expect(secUntilLeave(tick(300))).toBe(370);
    expect(computeLeaveAlert(tick(300), HEADS_UP_DONE)).toBeNull();

    // One poll reads a walk of 1090 s — the fix has put the rider ~836 m from
    // the board stop instead of ~330 m. secUntilLeave flips to −420 s.
    expect(secUntilLeave(tick(1090))).toBe(-420);
    // Unguarded that is a leave_now, and the caller DISARMS on it. Nothing
    // fires: the promise is false — 1090 s of walk for a bus 700 s out.
    expect(computeLeaveAlert(tick(1090), HEADS_UP_DONE)).toBeNull();
    expect(canStillCatch(tick(1090))).toBe(false);

    // THE REMINDER SURVIVES: leave_now is still owed, so when the fix recovers
    // the engine is silent at 370 s out and pings at its real moment.
    expect(computeLeaveAlert(tick(300), HEADS_UP_DONE)).toBeNull();
    expect(computeLeaveAlert(tick(300, 330), HEADS_UP_DONE)).toBe("leave_now");
  });

  it("an HONEST collapse of the BUS's ETA still pings on the tick it happens", () => {
    // The direction that matters: suppressing a real leave_now strands the
    // rider. THE DISCRIMINATOR IS WHICH NUMBER MOVED. A real departure or
    // re-anchor collapses the BUS's ETA and leaves the walk alone, so the
    // promise stays true; a bad fix inflates the WALK past the bus, so it does
    // not. The gate reads the promise and never has to guess the cause.
    const walk = 600; // an honest 10-minute walk, unchanged across both ticks
    expect(secUntilLeave(tick(walk, 1200))).toBe(570);
    expect(computeLeaveAlert(tick(walk, 1200), HEADS_UP_DONE)).toBeNull();
    // 1200 s → 620 s in one poll, a 580 s lurch, and it pings instantly —
    // because 620 s LANDS where the promise still holds, not because 580 s is a
    // big number. The next vector pins that distinction: a LARGER collapse
    // landing lower is suppressed.
    expect(secUntilLeave(tick(walk, 620))).toBe(-10);
    expect(computeLeaveAlert(tick(walk, 620), HEADS_UP_DONE)).toBe("leave_now");
    // Even a collapse straight to the kerb still pings while the rider can make
    // it by the dwell.
    expect(computeLeaveAlert(tick(walk, walk - LEAVE_BUFFER_SEC), HEADS_UP_DONE)).toBe("leave_now");
  });

  it("is a 90 s WINDOW, and WHERE the ETA lands is the determinant", () => {
    // The honest description of what the gate costs, to the second. At a 600 s
    // displayed walk, leave_now needs `until <= 0` (remaining <= 630) AND
    // `canStillCatch` (remaining >= 540), so it fires in [540, 630] — 90 s WIDE,
    // 91 inclusive integer seconds — against ungated [0, 630], 630 s wide and
    // 631 inclusive integer seconds. The width is the quantity; 91 and 631 are
    // the counts of whole seconds those closed intervals contain. The 90 s here
    // is `STOP_DWELL_SEC + LEAVE_BUFFER_SEC`, NOT the `SWITCH_BUFFER_SEC` 90 s
    // of the silent-but-armed walk band — two widths that coincide numerically.
    const walk = 600;
    expect(computeLeaveAlert(tick(walk, 631), HEADS_UP_DONE)).toBeNull();     // too early
    expect(computeLeaveAlert(tick(walk, 630), HEADS_UP_DONE)).toBe("leave_now");
    expect(computeLeaveAlert(tick(walk, 540), HEADS_UP_DONE)).toBe("leave_now"); // last firing
    expect(computeLeaveAlert(tick(walk, 539), HEADS_UP_DONE)).toBeNull();     // first suppressed

    // So the guard is NOT robust in proportion to the jump it survives. The
    // 580 s collapse above pings; a 661 s one, landing 1 s lower than the edge,
    // does not. Jumps of that size are ordinary here — 343 drops >= 300 s in
    // docs/eta-lurch-classification.md, |jump| p99.9 of 572.6 s.
    expect(1200 - 539).toBeGreaterThan(1200 - 620);
    expect(computeLeaveAlert(tick(walk, 620), HEADS_UP_DONE)).toBe("leave_now");

    // WHAT IS OUTSIDE THE WINDOW, in two cases that differ — this is an
    // inference restated, not re-asserted, because three drafts got it wrong.
    // `canCatch` false is the test that picks `boardable`, so WHERE A CATCHABLE
    // ENTRY EXISTS the card's total has already moved to a later bus and the
    // refused ping would have contradicted the card under it. WHERE NONE EXISTS
    // `boardable` falls back to `match` itself (planner.ts:255), the card keeps
    // pricing the refused bus at wait 0, and this gate is the only surface
    // declining the promise — planner.test.ts pins that case with one live entry
    // at eta 700 against a walk of 800 s. Here `live` is not modelled at all, so
    // these two assertions pin the PREDICATE's edge only.
    expect(canStillCatch(tick(walk, 539))).toBe(false);
    expect(canCatch(walk, 539)).toBe(false);
    expect(canCatch(walk, 540)).toBe(true);
  });

  it("does not spend the reminder on the ARMING tick for a bus past catching", () => {
    // The reminder counts down `match` — the bus the row FOLLOWS — which the
    // "two questions, two buses" rule deliberately keeps on a vehicle that may
    // be out of reach while the card's total is priced on `boardable`. Executed
    // against pickLiveArrival, not read off the contract: a pinned bus 2400 s
    // out whose only other entry is its own next lap at 4200 s returns
    // match 2400 / boardable 4200 with departed false, so findReminderOption
    // hands the engine 2400 s. At a 46-minute live walk that is −390 s, and the
    // rider armed into an immediate ping-and-disarm for a bus 6 min past
    // catching.
    const arming: LeaveAlertInput =
      { busEtaSec: 2400, walkToSec: 17 * 60, liveWalkToSec: 46 * 60, computedAtMs: NOW, nowMs: NOW };
    expect(secUntilLeave(arming)).toBe(-390);
    expect(computeLeaveAlert(arming, NO_PINGS_FIRED)).toBeNull();
    expect(canStillCatch(arming)).toBe(false);
    // Still armed, so the reminder is there for the bus it CAN make — the next
    // lap the card is already pricing its total on.
    expect(computeLeaveAlert({ ...arming, busEtaSec: 4200 }, NO_PINGS_FIRED)).toBeNull();
    expect(computeLeaveAlert({ ...arming, busEtaSec: 46 * 60 + LEAVE_BUFFER_SEC }, NO_PINGS_FIRED))
      .toBe("leave_now");
  });

  it("suppresses EXACTLY the unkeepable promises, to the second", () => {
    // A late arm is still a ping — the rider who taps at T−0 is told to go.
    // The boundary is the planner's dwell: a bus waits STOP_DWELL_SEC at the
    // kerb, so being that late is still catchable and one second more is not.
    const eta = 700;
    expect(computeLeaveAlert(tick(eta + STOP_DWELL_SEC, eta), NO_PINGS_FIRED)).toBe("leave_now");
    expect(computeLeaveAlert(tick(eta + STOP_DWELL_SEC + 1, eta), NO_PINGS_FIRED)).toBeNull();
    // An honest leave_now fires when the bus is walk + LEAVE_BUFFER_SEC away —
    // remaining ABOVE the walk — so it is inside the bound by construction.
    // What the bound excludes is a promise `canCatch` already calls false. That
    // is the same test that prices the card's total on a later bus WHEN A
    // CATCHABLE ENTRY EXISTS; with a single live entry `boardable` falls back to
    // `match` (planner.ts:255) and the card stays on the refused bus at wait 0,
    // so this gate is then the only surface declining it. Both cases are bounded
    // in leaveAlert.ts's header; the vector is in planner.test.ts.
    expect(canStillCatch(tick(eta - LEAVE_BUFFER_SEC, eta))).toBe(true);
  });

  it("counts the ETA down before judging reachability, like the timing does", () => {
    // One clock for both halves: a 700 s ETA computed 400 s ago has 300 s left,
    // so a 300 s walk is still catchable and still pings.
    const stale: LeaveAlertInput =
      { busEtaSec: 700, walkToSec: 1020, liveWalkToSec: 300, computedAtMs: NOW - 400_000, nowMs: NOW };
    expect(secUntilLeave(stale)).toBe(-30);
    expect(computeLeaveAlert(stale, NO_PINGS_FIRED)).toBe("leave_now");
    // 100 s later there is nothing left to catch, and the ping stops.
    const gone: LeaveAlertInput = { ...stale, computedAtMs: NOW - 500_000 };
    expect(computeLeaveAlert(gone, NO_PINGS_FIRED)).toBeNull();
    expect(canStillCatch(stale)).toBe(true);
    expect(canStillCatch(gone)).toBe(false);
  });

  it("REGRESSION GUARD: no live walk → reachability off the plan's own walk", () => {
    // Future-mode plans and any option the live recompute never touched. The
    // planned walk cannot jump, so this can only ever be the honest case.
    // Labelled as such: it passes with and without the guard, which is the
    // point — the planned walk cannot jump, so the gate must be invisible here.
    const s: LeaveAlertInput = { busEtaSec: 210, walkToSec: 180, computedAtMs: NOW, nowMs: NOW };
    expect(computeLeaveAlert(s, NO_PINGS_FIRED)).toBe("leave_now");
  });
});
