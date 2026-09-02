import { describe, expect, it } from "vitest";

import {
  AT_STOP_WALK_SEC,
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
  const isBlue = (o: { routeLabel: string }) => o.routeLabel === "Blue Day";

  it("returns the armed shuttle option while it is live", () => {
    expect(findReminderOption([walkOpt, shuttle], isBlue)).toBe(shuttle);
  });

  it("follows the option it was armed on, not the first with that route label", () => {
    // Report #55 puts two itineraries of one route in the list. Matching on
    // the label pinged the rider for the stop they had walked away from.
    const atProspect = { mode: "shuttle", routeLabel: "Blue Day", boardStopId: 100, busEtaSec: 2400, walkToSec: 120 };
    const viaWhitney = { mode: "shuttle", routeLabel: "Blue Day", boardStopId: 129, busEtaSec: 360, walkToSec: 360 };
    const armed = (o: { boardStopId?: number }) => o.boardStopId === 129;
    expect(findReminderOption([atProspect, viaWhitney], armed)).toBe(viaWhitney);
  });

  it("null when the option is gone from the plan (route stopped running)", () => {
    expect(findReminderOption([walkOpt], isBlue)).toBeNull();
    expect(findReminderOption([], isBlue)).toBeNull();
    expect(findReminderOption<typeof shuttle>(null, isBlue)).toBeNull();
    expect(findReminderOption<typeof shuttle>(undefined, isBlue)).toBeNull();
  });

  it("null when the option is flagged departed", () => {
    expect(findReminderOption([{ ...shuttle, departed: true }], isBlue)).toBeNull();
  });

  it("null when the option has no live bus ETA (future mode / no bus)", () => {
    expect(findReminderOption([{ ...shuttle, busEtaSec: undefined }], isBlue)).toBeNull();
  });

  it("never follows a walk option even under the armed label", () => {
    expect(findReminderOption([{ ...walkOpt, routeLabel: "Blue Day" }], isBlue)).toBeNull();
  });
});
