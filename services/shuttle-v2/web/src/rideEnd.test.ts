import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  BUS_ABSENT_MS,
  FIX_MAX_AGE_MS,
  OFF_BUS_M,
  OFF_BUS_STRIKES,
  RIDE_MAX_AGE_MS,
  rideEndDecision,
  type RideEndInput,
} from "./rideEnd";

const T0 = Date.parse("2026-09-04T15:15:00Z"); // 11:15 ET, the reported morning

/** A rider sitting on their bus, everything current. */
const onBus = (over: Partial<RideEndInput> = {}): RideEndInput => ({
  now: T0,
  startedAt: T0 - 5 * 60_000,
  bus: { lat: 41.31, lon: -72.93 },
  busLastSeenMs: T0,
  user: { lat: 41.31, lon: -72.93 },
  fixAgeMs: 3_000,
  hidden: false,
  streak: 0,
  distanceM: 12,
  ...over,
});

/** Run N consecutive checks, threading the counters the way the app does. */
function run(checks: Partial<RideEndInput>[], from = onBus()) {
  let streak = from.streak;
  let busLastSeenMs = from.busLastSeenMs;
  let last = rideEndDecision(from);
  for (const c of checks) {
    last = rideEndDecision({ ...from, ...c, streak, busLastSeenMs });
    if (last.end) return last;
    streak = last.streak;
    busLastSeenMs = last.busLastSeenMs;
  }
  return last;
}

describe("a ride survives submitting feedback (report #96)", () => {
  // "I was riding a bus, submitted feedback and then lost my live ride."
  //
  // The rider is on the bus the whole time. They open 💬 Send feedback, type,
  // attach a screenshot — which hands the page to the OS picker — and the tab
  // goes hidden for ninety seconds. The geolocation watch is torn down on
  // `visibilitychange`, so the rider's coordinate freezes while the bus poll
  // keeps running at 30 s. The bus drives on: just past 300 m, then 600 m,
  // then 900 m from where the rider was last seen to be.
  it("does not end while the page is hidden and the fix is frozen", () => {
    const frozenAt = T0;
    const hiddenChecks = [30_000, 60_000, 90_000].map((dt, k) => ({
      now: T0 + dt,
      hidden: true,
      fixAgeMs: dt, // the watch is stopped: the fix ages, it does not update
      distanceM: 301 + 300 * k,
      busLastSeenMs: frozenAt,
    }));
    const d = run(hiddenChecks);
    expect(d.end).toBe(false);
    expect(d.streak).toBe(0);
  });

  // The moment the rider comes back, the poll fires immediately but the
  // restarted watch has not delivered a fix yet — and the stall rescue may
  // hand back one up to two minutes old. That stale coordinate is the same
  // frozen one, and it must not count either.
  it("does not end on a stale fix once the page is visible again", () => {
    const d = run([90_000, 95_000, 100_000].map((dt) => ({
      now: T0 + dt,
      hidden: false,
      fixAgeMs: dt, // older than FIX_MAX_AGE_MS
      distanceM: 900,
    })));
    expect(d.end).toBe(false);
    expect(d.streak).toBe(0);
  });

  // The rule that shipped, in four lines, so the regression is on the record
  // rather than in a commit message: it looked at the distance and nothing
  // else, and the same three hidden polls retired a rider who never moved.
  it("is the case the shipped rule got wrong", () => {
    let streak = 0;
    for (const distanceM of [301, 601, 901]) streak = distanceM > OFF_BUS_M ? streak + 1 : 0;
    expect(streak).toBeGreaterThanOrEqual(OFF_BUS_STRIKES); // the ride ended, mid-ride
  });

  it("keeps the ride once fresh fixes show the rider is still aboard", () => {
    const d = run([
      { now: T0 + 90_000, hidden: true, fixAgeMs: 90_000, distanceM: 900 },
      { now: T0 + 95_000, fixAgeMs: 95_000, distanceM: 900 },
      { now: T0 + 100_000, fixAgeMs: 2_000, distanceM: 15 },
      { now: T0 + 105_000, fixAgeMs: 2_000, distanceM: 15 },
    ]);
    expect(d.end).toBe(false);
    expect(d.streak).toBe(0);
  });
});

describe("the ride still ends when it should", () => {
  it("ends after three consecutive off-bus checks on fresh fixes", () => {
    const off = { distanceM: OFF_BUS_M + 1, fixAgeMs: 4_000, hidden: false };
    const d = run([
      { ...off, now: T0 + 5_000 },
      { ...off, now: T0 + 10_000 },
      { ...off, now: T0 + 15_000 },
    ]);
    expect(d).toMatchObject({ end: true, reason: "off-bus" });
  });

  it("needs the checks to be CONSECUTIVE", () => {
    const off = { distanceM: OFF_BUS_M + 1, fixAgeMs: 4_000 };
    const d = run([
      { ...off, now: T0 + 5_000 },
      { ...off, now: T0 + 10_000 },
      { now: T0 + 15_000, distanceM: 20, fixAgeMs: 4_000 }, // back beside the bus
      { ...off, now: T0 + 20_000 },
    ]);
    expect(d.end).toBe(false);
    expect(d.streak).toBe(1);
  });

  it("takes exactly OFF_BUS_STRIKES strikes, no fewer", () => {
    for (let n = 1; n < OFF_BUS_STRIKES; n++) {
      const checks = Array.from({ length: n }, (_, k) => ({
        now: T0 + (k + 1) * 5_000,
        distanceM: OFF_BUS_M + 50,
        fixAgeMs: 4_000,
      }));
      expect(run(checks).end).toBe(false);
    }
  });

  it("ends a ride older than the age cap", () => {
    const d = rideEndDecision(onBus({ startedAt: T0 - RIDE_MAX_AGE_MS - 1 }));
    expect(d).toMatchObject({ end: true, reason: "age" });
  });

  it("ends when the pinned bus has been out of the feed for ten minutes", () => {
    const gone = onBus({ bus: null, busLastSeenMs: T0 - BUS_ABSENT_MS - 1 });
    expect(rideEndDecision(gone)).toMatchObject({ end: true, reason: "bus-gone" });
    const brief = onBus({ bus: null, busLastSeenMs: T0 - 60_000 });
    expect(rideEndDecision(brief).end).toBe(false);
  });

  it("does not carry strikes across a gap in the feed", () => {
    // Two off-bus checks, then the bus drops out of one poll. The gap says
    // nothing about the rider, so the third strike has to start over.
    const off = { distanceM: OFF_BUS_M + 1, fixAgeMs: 4_000 };
    const d = run([
      { ...off, now: T0 + 5_000 },
      { ...off, now: T0 + 10_000 },
      { now: T0 + 15_000, bus: null },
      { ...off, now: T0 + 20_000 },
    ]);
    expect(d.end).toBe(false);
    expect(d.streak).toBe(1);
  });

  it("holds the ride when there is no fix at all, rather than guessing", () => {
    const d = run([1, 2, 3, 4].map((k) => ({
      now: T0 + k * 5_000,
      user: null,
      fixAgeMs: null,
      distanceM: null,
    })));
    expect(d.end).toBe(false);
  });

  it("treats a fix exactly at the age limit as usable", () => {
    const at = onBus({ fixAgeMs: FIX_MAX_AGE_MS, distanceM: OFF_BUS_M + 1, streak: OFF_BUS_STRIKES - 1 });
    expect(rideEndDecision(at)).toMatchObject({ end: true, reason: "off-bus" });
    const past = { ...at, fixAgeMs: FIX_MAX_AGE_MS + 1 };
    expect(rideEndDecision(past).end).toBe(false);
  });

  it("ignores a junk distance rather than reading it as far away", () => {
    const d = rideEndDecision(onBus({ distanceM: Number.NaN, streak: OFF_BUS_STRIKES - 1 }));
    expect(d.end).toBe(false);
    expect(d.streak).toBe(0);
  });
});

/**
 * A GHOST MUST NOT REACH THIS DECISION (2026-09-04).
 *
 * `/api/buses` now carries buses that have stopped reporting for up to ten
 * minutes, flagged with `offline_since` and otherwise their last fix verbatim
 * (web/src/ghost.ts). Fed to `rideEndDecision` that is not a harmless extra
 * row — it is report #96 rebuilt from new parts:
 *
 *  - the frozen coordinate keeps `busLastSeenMs` fresh, so `BUS_ABSENT_MS`
 *    never starts counting and a ride outlives the service that ended under
 *    it; and, much worse,
 *  - `distanceM` is measured from the rider to where the bus WAS. A rider
 *    still perfectly happily aboard rides away from that point, clears
 *    `OFF_BUS_M` on three consecutive checks, and the app retires their live
 *    ride — the exact complaint #96 filed ("I was riding a bus … and then lost
 *    my live ride").
 *
 * The decision itself is pure and cannot see the flag, so the guard is at the
 * call site: `TransitMap` derives `reportingBuses` and the ride effect reads
 * that. This asserts the wiring, because no unit test of this module can.
 */
describe("the ride effect never sees a bus that stopped reporting", () => {
  const src = readFileSync(
    fileURLToPath(new URL("./TransitMap.tsx", import.meta.url)), "utf8",
  );

  it("derives reportingBuses by dropping the ghosts", () => {
    expect(src).toContain(
      "const reportingBuses = useMemo(() => buses.filter((b) => b.offline_since == null), [buses]);",
    );
  });

  it("looks the ride's bus up in reportingBuses, not in buses", () => {
    // The line that feeds `rideEndDecision({ bus, busLastSeenMs })`.
    expect(src).toContain(
      "? reportingBuses.find((b) => norm(b.bus_name) === norm(boardedRide.busName)",
    );
  });

  // The same reasoning, one layer out: a rider ABOARD is exactly the case
  // where a frozen coordinate is most convincing and most wrong.
  it("does not offer a ride on a bus that stopped reporting", () => {
    expect(src).toContain("b.offline_since == null\n      );");
  });

  // Sanity on the pure function itself: with the bus absent (which is what the
  // guard produces for a ghost) a rider's own movement earns no strike.
  it("charges no strike on a poll its bus is missing from", () => {
    const d = rideEndDecision({
      now: 1_000_000,
      startedAt: 1_000_000 - 60_000,
      bus: null,
      busLastSeenMs: 1_000_000 - 60_000,
      user: { lat: 41.31, lon: -72.93 },
      fixAgeMs: 1_000,
      hidden: false,
      streak: OFF_BUS_STRIKES - 1,
      distanceM: null,
    });
    expect(d.end).toBe(false);
    expect(d.streak).toBe(0);
  });
});
