import { describe, expect, it } from "vitest";

import {
  fmtClock, fmtMin, fmtWait, fmtWalk, formatEtaRange, suggIcon, suggLabel,
  type GeocodeResult,
} from "./format";

describe("fmtMin", () => {
  it("says 'now' inside the last ten seconds", () => {
    expect(fmtMin(0)).toBe("now");
    expect(fmtMin(9.9)).toBe("now");
  });

  it("ticks in MM:SS under two minutes so the countdown visibly moves", () => {
    expect(fmtMin(10)).toBe("0:10");
    expect(fmtMin(65)).toBe("1:05");
    expect(fmtMin(119)).toBe("1:59");
  });

  // Math.round would call 6:31 "7 min" and then jump to "6 min" at 6:30, which
  // reads as a stuck clock. Flooring makes "7 min" mean "at least 7 min".
  it("floors whole minutes from two minutes up", () => {
    expect(fmtMin(120)).toBe("2 min");
    expect(fmtMin(419)).toBe("6 min");
    expect(fmtMin(420)).toBe("7 min");
    expect(fmtMin(479)).toBe("7 min");
  });
});

describe("fmtWalk / fmtWait", () => {
  it("rounds walks to the nearest minute, never below one", () => {
    expect(fmtWalk(0)).toBe("1 min");
    expect(fmtWalk(29)).toBe("1 min");
    expect(fmtWalk(90)).toBe("2 min");
    expect(fmtWalk(150)).toBe("3 min");
  });

  it("floors waits, because the bus will not come early", () => {
    expect(fmtWait(0)).toBe("0 min");
    expect(fmtWait(92)).toBe("1 min");
    expect(fmtWait(599)).toBe("9 min");
  });
});

// A hard project convention: minutes are spelled "min", never "m" — "m" reads
// as miles on a transit screen.
describe("minutes are always spelled 'min'", () => {
  const samples = [0, 10, 45, 119, 120, 300, 3_600, 7_200];
  it("never emits a bare 'm' unit", () => {
    for (const s of samples) {
      for (const out of [fmtMin(s), fmtWalk(s), fmtWait(s)]) {
        expect(out).not.toMatch(/\d\s*m$/);
        if (/\bmin\b/.test(out)) expect(out).toMatch(/\d+ min$/);
      }
    }
  });

  it("formatEtaRange too", () => {
    expect(formatEtaRange({ eta: 30, low: 10, high: 60 })).toBe("<1 min");
    expect(formatEtaRange({ eta: 400, low: 330, high: 470 })).toBe("6 min");
  });
});

describe("fmtClock", () => {
  const base = new Date("2026-08-31T12:00:00");
  it("renders 12-hour times with a compact am/pm marker", () => {
    expect(fmtClock(0, base)).toBe("12:00p");
    expect(fmtClock(90 * 60, base)).toBe("1:30p");
    expect(fmtClock(-12 * 3600, base)).toBe("12:00a");
    expect(fmtClock(-60 * 60, base)).toBe("11:00a");
  });

  it("pads the minutes", () => {
    expect(fmtClock(5 * 60, base)).toBe("12:05p");
  });
});

describe("suggLabel", () => {
  const g = (display_name: string): GeocodeResult => ({ display_name, lat: 0, lon: 0 });

  it("keeps only the two most specific segments", () => {
    expect(suggLabel(g(
      "Indian River, Forest Heights, Fort Trumbull, Milford, Connecticut, United States",
    ))).toBe("Indian River, Forest Heights");
  });

  it("widens only the rows that would otherwise read identically", () => {
    const a = g("Chapel Street, New Haven, Wooster Square, Connecticut");
    const b = g("Chapel Street, New Haven, Dwight, Connecticut");
    const c = g("York Street, New Haven, Connecticut");
    const siblings = [a, b, c];
    expect(suggLabel(a, siblings)).toBe("Chapel Street, New Haven, Wooster Square");
    expect(suggLabel(b, siblings)).toBe("Chapel Street, New Haven, Dwight");
    // The non-colliding row stays short.
    expect(suggLabel(c, siblings)).toBe("York Street, New Haven");
  });

  it("survives a one-segment name", () => {
    expect(suggLabel(g("Phelps Gate"))).toBe("Phelps Gate");
    expect(suggLabel(g("Phelps Gate"), [g("Phelps Gate"), g("Phelps Gate")])).toBe("Phelps Gate");
  });

  it("trims whitespace and drops empty segments", () => {
    expect(suggLabel(g("  Elm Street ,, New Haven , CT "))).toBe("Elm Street, New Haven");
  });
});

describe("suggIcon", () => {
  it("distinguishes stops, Yale places and everything else", () => {
    expect(suggIcon({ display_name: "x", lat: 0, lon: 0, type: "bus_stop" })).toBe("🚏");
    expect(suggIcon({ display_name: "x", lat: 0, lon: 0, class: "yale" })).toBe("🏛️");
    // 📍 is the origin marker throughout the app; 🏁 is the destination.
    expect(suggIcon({ display_name: "x", lat: 0, lon: 0 })).toBe("📍");
  });
});
