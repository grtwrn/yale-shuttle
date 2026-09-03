import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  busPairLine,
  fmtBusPair,
  fmtClock,
  fmtMin,
  fmtWait,
  fmtWalk,
  formatEtaRange,
  remainingSec,
  suggIcon,
  suggLabel,
  type GeocodeResult,
} from "./format";

describe("fmtMin", () => {
  it("says 'now' inside the last ten seconds", () => {
    expect(fmtMin(0)).toBe("now");
    expect(fmtMin(9.9)).toBe("now");
  });

  // Report #48: the old MM:SS branch here ("1:49") implied second-precision
  // the value never had — fed a minute-accurate ETA it read as a frozen
  // stopwatch — and broke the "minutes are spelled min" convention. Sub-minute
  // is a state, not a timer.
  it("says '<1 min' under a minute, never MM:SS", () => {
    expect(fmtMin(10)).toBe("<1 min");
    expect(fmtMin(20)).toBe("<1 min");
    expect(fmtMin(59.9)).toBe("<1 min");
    expect(fmtMin(60)).toBe("1 min");
    expect(fmtMin(109)).toBe("1 min"); // the literal value report #48 saw as "1:49"
    expect(fmtMin(119)).toBe("1 min");
    for (let s = 0; s < 7200; s += 1) expect(fmtMin(s)).not.toMatch(/:/);
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

// Report #48's other half: an ETA is a snapshot taken at `computedAtMs`, and
// the renderer must spend elapsed wall-clock time against it — otherwise the
// displayed wait holds still between recomputes while the bus closes in.
describe("remainingSec", () => {
  const T0 = 1_756_700_000_000;

  it("decreases as time passes between polls", () => {
    expect(remainingSec(109, T0, T0)).toBe(109);
    expect(remainingSec(109, T0, T0 + 5_000)).toBe(104);
    expect(remainingSec(109, T0, T0 + 60_000)).toBe(49);
  });

  it("clamps at zero rather than going negative", () => {
    expect(remainingSec(20, T0, T0 + 60_000)).toBe(0);
  });

  it("passes the value through when there is no timestamp", () => {
    expect(remainingSec(300, undefined, T0)).toBe(300);
  });

  it("ignores a timestamp from the future (clock skew) instead of inflating", () => {
    expect(remainingSec(90, T0 + 10_000, T0)).toBe(90);
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

  it("names the town when the same business appears in two of them", () => {
    // Report #72: the curated Trader Joe's sat above "Trader Joe's, 46 Skiff
    // Street" with nothing saying that second one is up in Hamden.
    const milford = g("Trader Joe's (Milford)");
    const hamden = g("Trader Joe's, 46 Skiff Street, Hamden");
    const siblings = [milford, hamden];
    expect(suggLabel(hamden, siblings)).toBe("Trader Joe's, 46 Skiff Street, Hamden");
    // The one that already carries its town in the name is left alone.
    expect(suggLabel(milford, siblings)).toBe("Trader Joe's (Milford)");
  });

  it("leaves two branches in one town short — the street already tells them apart", () => {
    const a = g("Starbucks, 1 Broadway, New Haven");
    const b = g("Starbucks, 900 Chapel Street, New Haven");
    expect(suggLabel(a, [a, b])).toBe("Starbucks, 1 Broadway");
    expect(suggLabel(b, [a, b])).toBe("Starbucks, 900 Chapel Street");
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
  const hit = (extra: Partial<GeocodeResult>): GeocodeResult =>
    ({ display_name: "x", lat: 0, lon: 0, ...extra });

  it("marks a shuttle stop, a curated place and an address", () => {
    expect(suggIcon(hit({ type: "bus_stop" }))).toBe("🚏");
    expect(suggIcon(hit({ class: "yale" }))).toBe("🏛️");
    expect(suggIcon(hit({}))).toBe("📍");
  });

  // The operator's ask (2026-09-03): "elenas and Pepe's are eateries. elenas
  // is an ice cream shop. could you ice cream / pizza / plate and fork /
  // coffee cup for known places?"
  it.each([
    ["ice_cream", "🍦"],
    ["pizza", "🍕"],
    ["restaurant", "🍽️"],
    ["cafe", "☕"],
    ["fast_food", "🍔"],
    ["bakery", "🥐"],
    ["bar", "🍺"],
    ["supermarket", "🛒"],
    ["pharmacy", "💊"],
    ["library", "📚"],
    ["museum", "🏛️"],
    ["hospital", "🏥"],
    ["college", "🎓"],
    ["park", "🌳"],
    ["theatre", "🎭"],
    ["hotel", "🛏️"],
    ["station", "🚉"],
    ["books", "📖"],
    ["gym", "🏋️"],
  ])("draws a %s as %s", (type, icon) => {
    // Same table for a curated place and an OpenStreetMap result: the server
    // serves OSM's own vocabulary in `type` for both.
    expect(suggIcon(hit({ type, class: "yale" }))).toBe(icon);
    expect(suggIcon(hit({ type, class: "osm" }))).toBe(icon);
  });

  it("falls back rather than drawing nothing for an unknown category", () => {
    expect(suggIcon(hit({ type: "gardener", class: "osm" }))).toBe("📍");
    expect(suggIcon(hit({ type: "landmark", class: "yale" }))).toBe("🏛️");
    // A stop is a stop even if a category ever leaked into its type.
    expect(suggIcon(hit({ type: "bus_stop", class: "shuttle" }))).toBe("🚏");
  });
});

describe("fmtBusPair — the next two buses in one breath", () => {
  it("shares the unit between the two numbers", () => {
    // "in 1 min · next in 11 min" clipped mid-number on the option row at
    // 390px; the operator's shorter form fits at every ETA (2026-09-03).
    expect(fmtBusPair(60, 660)).toBe("in 1, 11 min");
    expect(fmtBusPair(22 * 60, 41 * 60)).toBe("in 22, 41 min");
  });

  it("keeps words when there is no second bus to pair with", () => {
    expect(fmtBusPair(60)).toBe("in 1 min");
    expect(fmtBusPair(22 * 60, null)).toBe("in 22 min");
    expect(fmtBusPair(5)).toBe("arriving now");
    expect(fmtBusPair(60, NaN)).toBe("in 1 min");
  });

  it("does not say \"in now\" when the bus is at the stop", () => {
    expect(fmtBusPair(5, 660)).toBe("now, then 11 min");
  });

  it("keeps the under-a-minute marker", () => {
    expect(fmtBusPair(45, 660)).toBe("in <1, 11 min");
  });
});

describe("busPairLine — the same live readout on every card", () => {
  it("prints the pair behind the bus emoji", () => {
    expect(busPairLine(60, 660)).toBe("🚌 in 1, 11 min");
    expect(busPairLine(60)).toBe("🚌 in 1 min");
  });

  it("says nothing when there is no live bus on the option", () => {
    // Future-mode and schedule-only options have no pinned vehicle; the card
    // falls back to its "⏳ wait N min" summary.
    expect(busPairLine(null)).toBeNull();
    expect(busPairLine(undefined)).toBeNull();
    expect(busPairLine(NaN, 660)).toBeNull();
  });

  it("says nothing once the option has departed", () => {
    // The card runs its "check for the next shuttle" sentence instead —
    // counting down to a bus the rider cannot catch is the misleading case.
    expect(busPairLine(60, 660, { departed: true })).toBeNull();
  });

  it("takes no view state, so an opened card reads like the overview", () => {
    // Report #79: the countdown was rendered only on collapsed rows, so
    // tapping a trip for more detail removed the one live number on it.
    // Whatever the row shows, it shows in both places — same inputs, one
    // string, and no third argument for "is this card open".
    const overview = busPairLine(8 * 60, 20 * 60);
    const details = busPairLine(8 * 60, 20 * 60);
    expect(details).toBe(overview);
    expect(details).toBe("🚌 in 8, 20 min");
  });
});

describe("the option row renders that readout in both of its states", () => {
  // busPairLine cannot enforce this on its own: the row could simply decline
  // to render it when open, which is exactly the bug report #79 describes.
  // This project has no DOM test setup, so — as walk.test.ts does with the
  // server's walking speed — read the source and pin the one condition.
  const source = readFileSync(new URL("./TransitMap.tsx", import.meta.url), "utf8");

  it("gates the live bus line on the bus, not on which card is open", () => {
    const guard = source.match(/\{busLine && \(/);
    expect(guard, "the live bus span should render on `busLine` alone").not.toBeNull();
    expect(source).not.toMatch(/busLine && [^)]*isExpanded/);
    expect(source).not.toMatch(/isExpanded[^)]*&& busLine/);
  });

  it("builds the line once, so the two views cannot word it differently", () => {
    expect(source.match(/busPairLine\(/g)).toHaveLength(1);
  });
});
