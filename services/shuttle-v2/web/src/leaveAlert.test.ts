import { describe, expect, it } from "vitest";

import {
  AT_STOP_WALK_SEC,
  computeLeaveAlert,
  findReminderOption,
  HEADS_UP_LEAD_SEC,
  LEAVE_BUFFER_SEC,
  leaveAlertMessage,
  liveReminderInput,
  markFired,
  NO_PINGS_FIRED,
  secUntilLeave,
  type FiredPings,
  type LeaveAlertInput,
} from "./leaveAlert";
import { forecastPickupSelection, rawPickupSelection } from './livePickupSelection';
import { attachServerEta, ETA_MAX_AGE_MS } from './etaSource';
import type { BusData } from './map-data';

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

describe('leave for the early end of the selected boarding window', () => {
  it('uses the printed early minute instead of waiting for the point estimate', () => {
    const s = input(600, 180, { busLowSec: 239, busHighSec: 900 });
    expect(secUntilLeave(s)).toBe(-30); // printed3min,3min walk,30s margin
    expect(computeLeaveAlert(s, NO_PINGS_FIRED)).toBe('leave_now');
    expect(leaveAlertMessage('leave_now', 'Red', s))
      .toBe('Time to leave — Red could arrive in 3–15 min, 3 min walk');
  });

  it('reformats aged bounds on every tick, including a minute-boundary crossing', () => {
    const s = input(600, 180, { busLowSec: 240, busHighSec: 900 });
    expect(secUntilLeave(s)).toBe(30);
    expect(secUntilLeave({ ...s, nowMs: NOW + 1000 })).toBe(-30);
    expect(leaveAlertMessage('heads_up', 'Red', s)).toContain('4–15 min');
  });

  it('uses valid narrow, wide and subminute windows rather than hiding their early end', () => {
    expect(secUntilLeave(input(90, 60, { busLowSec: 89, busHighSec: 91 }))).toBe(-30);
    expect(secUntilLeave(input(900, 180, { busLowSec: 239, busHighSec: 2401 }))).toBe(-30);
    expect(secUntilLeave(input(90, 60, { busLowSec: 59, busHighSec: 91 }))).toBe(-90);
  });

  it.each([
    { busLowSec: undefined, busHighSec: 900 },
    { busLowSec: NaN, busHighSec: 900 },
    { busLowSec: 500, busHighSec: 200 },
    { busLowSec: 0, busHighSec: 0 },
    { busLowSec: 700, busHighSec: 900 },
  ])('falls back to the point for an unusable window (%#)', bounds => {
    expect(secUntilLeave(input(600, 180, bounds))).toBe(390);
  });

  it('cannot move leave-time later than the point as bounds age or estimates change', () => {
    for (const point of [0, 59, 60, 239, 600, 1800]) {
      for (const low of [-30, 0, 59, 60, 120, 239, 600, 2000]) {
        for (const age of [0, 1, 30, 61, 500]) {
          const plain = input(point, 180, { nowMs: NOW + age * 1000 });
          const bounded = { ...plain, busLowSec: low, busHighSec: Math.max(low, point) + 300 };
          expect(secUntilLeave(bounded)).toBeLessThanOrEqual(secUntilLeave(plain));
        }
      }
    }
  });

  it.each([NaN, Infinity, -1])('does not notify from an invalid point estimate (%s)', busEtaSec => {
    expect(computeLeaveAlert(input(busEtaSec, 180, { busLowSec: 0, busHighSec: 100 }), NO_PINGS_FIRED)).toBeNull();
  });

  it('keeps one-shot state when the window or selected vehicle changes', () => {
    const initial = input(900, 180, { busLowSec: 480, busHighSec: 1200, busName: '307' });
    const first = computeLeaveAlert(initial, NO_PINGS_FIRED)!;
    expect(first).toBe('heads_up');
    const fired = markFired(NO_PINGS_FIRED, first);
    expect(computeLeaveAlert({ ...initial, busName: '309', busLowSec: 1200, busHighSec: 1800 }, fired)).toBeNull();
    const close = { ...initial, busName: '309', busLowSec: 180, busHighSec: 1000 };
    expect(computeLeaveAlert(close, fired)).toBe('leave_now');
    expect(computeLeaveAlert(close, markFired(fired, 'leave_now'))).toBeNull();
  });
});

describe('live reminder boarding identity and feed age', () => {
  const row = (busName: string, eta: number, stopsAhead = 2) => ({
    busName, stopId: 48, stopsAhead, eta, low: Math.max(0, eta - 20), high: eta + 80,
  });
  const first = row('#307', 20), other = row('#309', 300, 4), returned = row('307', 1200, 30);
  const option = (boarding = other) => ({
    mode: 'shuttle', routeLabel: 'Red', busEtaSec: first.eta, busLowSec: first.low, busHighSec: first.high,
    boardStopId: 48, alightStopId: 121, walkToSec: 100, computedAtMs: NOW,
    livePickupSelection: forecastPickupSelection({ match: first, boardable: boarding, departed: false }, NOW),
  });
  const context = () => {
    const buses: BusData[] = [307, 309].map(id => ({ bus_id: id, bus_name: `#${id}`, route_id: 3,
      lat: 41.3, lon: -72.9, heading: 0, last_stop_id: 48 }));
    expect(attachServerEta(buses, { v: 2, at: NOW, servedAt: NOW,
      buses: [['307', 'Red', 0, null], ['309', 'Red', 0, null]],
      rows: [[0, 48, 20, 0, 100, 2, 0, 20, 0], [1, 48, 300, 280, 380, 4, 0, 300, 0]],
    }, NOW)).toBe(true);
    return { buses, busUpdateFailed: false, nowMs: NOW };
  };

  it('uses the actual trip bus instead of spending its final ping on an uncatchable countdown bus', () => {
    const s = liveReminderInput([option()], 'Red', context())!;
    expect(s).toMatchObject({ busName: '309', busEtaSec: 300, busLowSec: 280, busHighSec: 380, computedAtMs: NOW });
    expect(secUntilLeave(s)).toBe(110);
    expect(computeLeaveAlert(s, NO_PINGS_FIRED)).toBe('heads_up');
    expect(leaveAlertMessage('heads_up', 'Red', s)).toContain('Red #309 could arrive in 4–7 min');
  });

  it('keeps the same bus\'s later visit distinct and uses its own clock', () => {
    const o = { ...option(returned), walkToSec: 200, computedAtMs: NOW - 100_000 };
    const s = liveReminderInput([o], 'Red', context())!;
    expect(s).toMatchObject({ busName: '307', busEtaSec: 1200, laterVisit: true, computedAtMs: NOW });
    expect(computeLeaveAlert(s, NO_PINGS_FIRED)).toBeNull();
    expect(leaveAlertMessage('heads_up', 'Red', s)).toContain('Red #307 could return in 19–22 min');
  });

  it('retains the selected raw-current bus at zero without borrowing a later forecast', () => {
    const o = { ...option(), livePickupSelection: rawPickupSelection('#307', 48, NOW) };
    const s = liveReminderInput([o], 'Red', context())!;
    expect(s).toMatchObject({ busName: '307', busEtaSec: 0, busLowSec: 0, busHighSec: 0, atPickup: true });
    expect(computeLeaveAlert(s, NO_PINGS_FIRED)).toBe('leave_now');
    expect(leaveAlertMessage('leave_now', 'Red', s)).toContain('Red #307 is at your stop');
  });

  it('uses the selected boarding point when its bounds are invalid, never the approaching bus point', () => {
    const o = option({ ...other, low: NaN, high: NaN });
    const s = liveReminderInput([o], 'Red', context())!;
    expect(secUntilLeave(s)).toBe(170);
    expect(leaveAlertMessage('heads_up', 'Red', s)).toContain('Red #309 in 5 min');
    expect(liveReminderInput([option({ ...other, eta: Infinity })], 'Red', context())).toBeNull();
  });

  it('expires a feed between React renders even if the option was recomputed just now', () => {
    const c = context();
    expect(liveReminderInput([option()], 'Red', { ...c, nowMs: NOW + ETA_MAX_AGE_MS - 1 })).not.toBeNull();
    const at = NOW + ETA_MAX_AGE_MS;
    const o = option();
    o.computedAtMs = at;
    o.livePickupSelection!.selectedAtMs = at;
    expect(liveReminderInput([o], 'Red', { ...c, nowMs: at })).toBeNull();
  });

  it('disarms when feed fails, planning is future, the visit disappears, or the trip changes', () => {
    const c = context(), o = option();
    expect(liveReminderInput([o], 'Red', { ...c, busUpdateFailed: true })).toBeNull();
    expect(liveReminderInput([o], 'Red', { ...c, targetDateMs: NOW + 60_001 })).toBeNull();
    expect(liveReminderInput([o], 'Red', { ...c, boardStopId: 99 })).toBeNull();
    expect(liveReminderInput([o], 'Red', { ...c, alightStopId: 99 })).toBeNull();
    expect(liveReminderInput([{ ...o, livePickupSelection: undefined }], 'Red', c)).toBeNull();
    expect(liveReminderInput([{ ...o, departed: true }], 'Red', c)).toBeNull();
    expect(liveReminderInput([{ ...o, etaUnavailable: true }], 'Red', c)).toBeNull();
    expect(liveReminderInput([o], 'Red', { ...c, buses: c.buses.slice(0, 1) })).toBeNull();
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

 it('withholds leave reminders when the shared forecast is unavailable', () => {
   expect(findReminderOption([{ mode: 'shuttle', routeLabel: 'Red', busEtaSec: 120, etaUnavailable: true }], 'Red')).toBeNull();
 });
