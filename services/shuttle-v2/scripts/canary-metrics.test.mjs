import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  bucketOf, CANARY_LINES, CANONICAL_MAX_WALK_M, CANONICAL_TRIP, conservativeDrift,
  MAX_WALK_M, MIN_RIDE_M, parseBusEtaText, parseOptions, parseWaitFallback,
  scoreSequence, THRESHOLDS, tripForLine,
} from "./canary-metrics.mjs";

describe("bucketOf", () => {
  it("maps every token fmtMin can print", () => {
    expect(bucketOf("now")).toEqual([0, 10]);
    expect(bucketOf("<1")).toEqual([10, 60]);
    expect(bucketOf("8")).toEqual([480, 540]);
    expect(bucketOf("0")).toEqual([0, 60]);
    expect(bucketOf("banana")).toBeNull();
  });
});

describe("parseBusEtaText", () => {
  it("reads every shape fmtBusPair produces", () => {
    expect(parseBusEtaText("🚌 arriving now").first).toEqual([0, 10]);
    expect(parseBusEtaText("🚌 now, then 16 min").second).toEqual([960, 1020]);
    expect(parseBusEtaText("🚌 in 8, 16 min")).toMatchObject({ first: [480, 540], second: [960, 1020] });
    expect(parseBusEtaText("🚌 in <1, 16 min").first).toEqual([10, 60]);
    expect(parseBusEtaText("🚌 in 8 min")).toMatchObject({ first: [480, 540], second: null });
  });

  it("refuses the card's SENTENCES, which also start with the bus emoji", () => {
    // Mistaking one of these for a countdown would invent a jump on the tick a
    // rider was actually being warned about.
    expect(parseBusEtaText("🚌 You can't catch #40 — showing the next bus:")).toBeNull();
    expect(parseBusEtaText("🚌 The bus is at your stop — you won't arrive in time, check for the next shuttle")).toBeNull();
  });
});

describe("parseWaitFallback", () => {
  it("reads the no-live-bus line", () => {
    expect(parseWaitFallback("⏳ wait 7 min for #40")).toEqual({ waitMin: 7, busName: "40" });
    expect(parseWaitFallback("⏳ wait 12 min for next shuttle")).toEqual({ waitMin: 12, busName: null });
    expect(parseWaitFallback("🚌 in 8 min")).toBeNull();
  });
});

describe("conservativeDrift", () => {
  const min = (n) => [n * 60, n * 60 + 60];

  it("is zero for a countdown ticking down normally", () => {
    expect(conservativeDrift(min(10), min(9), 60)).toBe(0);
    expect(conservativeDrift(min(10), min(10), 15)).toBe(0); // still inside the same minute
  });

  it("never invents a jump out of bucket edges", () => {
    // "8 min" -> "7 min" after only 5 s is entirely possible: the true value
    // could have been 480 (bucket floor) and gone to 479.
    expect(conservativeDrift(min(8), min(7), 5)).toBe(0);
  });

  it("reports the operator's complaint: 10 min to nothing in one tick", () => {
    // "10 min" -> "<1 min" 15 s later. Smallest possible fall is 660 -> 60.
    const drift = conservativeDrift(min(10), [10, 60], 15);
    expect(drift).toBe(-525);
    expect(Math.abs(drift)).toBeGreaterThanOrEqual(THRESHOLDS.catastrophicSec);
  });

  it("reports report #32's reversal: 6 min then 16", () => {
    const drift = conservativeDrift(min(6), min(16), 15);
    expect(drift).toBe(555);
    expect(drift).toBeGreaterThan(0);
    expect(drift).toBeGreaterThanOrEqual(THRESHOLDS.catastrophicSec);
  });

  it("does not call the display's own floor a reversal", () => {
    // "arriving now" is the [0, 10) bucket. A card sitting there cannot fall
    // by the fifteen seconds that pass, so the naive expectation of
    // `prev - dt` is unreachable and every tick scored as a small rise. A Red
    // bus standing at Division/Prospect on 2026-09-04 produced a run of
    // +5..+8 s "reversals" this way — the floor, not a defect.
    const now = [0, 10];
    expect(conservativeDrift(now, now, 15)).toBe(0);
    expect(conservativeDrift(now, now, 60)).toBe(0);
    // A near-floor bucket behaves the same once the clamp bites.
    expect(conservativeDrift([10, 60], now, 60)).toBe(0);
    // But a genuine rise off the floor is still a rise.
    expect(conservativeDrift(now, [600, 660], 15)).toBe(600);
  });

  it("gives +15 s for a bare one-minute step up at a 15 s sample", () => {
    // This is the floor the notable-reversal threshold is set above: a single
    // minute gained is real but common; a whole minute gained ON TOP of the
    // elapsed time is what riders write in about.
    expect(conservativeDrift(min(8), min(9), 15)).toBe(15);
    expect(conservativeDrift(min(8), min(9), 15)).toBeLessThan(THRESHOLDS.notableReversalSec);
    expect(conservativeDrift(min(8), min(10), 15)).toBeGreaterThanOrEqual(THRESHOLDS.notableReversalSec);
  });
});

describe("parseOptions", () => {
  // Captured from the live site, 2026-09-03 16:49 ET, geolocation at
  // Prospect/Canner with School of Public Health as the destination.
  const LIVE = `YALE SHUTTLE
4:49 PM
Trip
Map
Issues
FROM
📍 Current location
TO
🏁 School of Public Health (YSPH)
WHEN
Now
☁️
79°F · no rain · cooling to 70° by 12am
OVERVIEW — TOP 2 OF 4 ROUTES
🚌
🚌 (B) 8 min
 (R) 16 min
🏁 (B) 5:12p
 (R) 5:18p
Blue Day
Red
23 min
🚌 in 8, 16 min
arrive 5:13p
›
🚶 8 min
›
Blue Day
›
🚶 1 min
29 min
🚌 in 16, 40 min
arrive 5:18p
›
🚶 1 min
›
Red
›
🚶 1 min
38 min
arrive 5:27p
›
🚶 Walk
Show 2 more routes
Clear`;

  it("reads each card off the real page text", () => {
    const opts = parseOptions(LIVE);
    expect(opts.map((o) => o.routeLabel)).toEqual(["Blue Day", "Red", "Walk"]);
    expect(opts[0]).toMatchObject({ totalMin: 23, arriveText: "5:13p", walkToMin: 8, walkFromMin: 1 });
    expect(opts[0].eta.first).toEqual([480, 540]);
    expect(opts[1].eta.second).toEqual([2400, 2460]);
    expect(opts[2]).toMatchObject({ mode: "walk", totalMin: 38 });
  });

  it("ignores the map overview's own '16 min', which is not a card", () => {
    // The overview line " (R) 16 min" sits above the list; a card is only a
    // card when it quotes an arrival clock.
    expect(parseOptions(LIVE)).toHaveLength(3);
  });

  // The SAME page after the 2026-09-04 card redesign: the route pill leads
  // the card (top-left) with the countdown beside it, so both now sit ABOVE
  // the duration instead of below it. Captured from a phone-sized browser on
  // a frozen /api/buses payload, Prospect/Canner -> LEPH/60 College.
  const LIVE_LINE_FIRST = `OVERVIEW — ALL 4 ROUTES
▴
🚌
🚌
🚌
🚌
🚌 (O) 15 min
🏁 (B) 10:33a
 (O) 10:39a
 (R) 10:47a
🚌 (B) 3 min
 (R) 25 min
 (B) 36 min
🏁 (B) 11:08a
+
−
 Leaflet | © OpenStreetMap contributors
⛶
Blue Day
Orange Day
Red
Brown
Blue Day
🚌 in 3, 21 min
23 min
arrive 10:33a
›
Orange Day
🚌 in 15, 39 min
29 min
arrive 10:39a
·
🚶 16 min
›
›
Red
🚌 in 25, 31 min
37 min
arrive 10:47a
·
🚶 1 min
›
· most direct
›
🚶 Walk
38 min
arrive 10:48a
›
Brown
🚌 in 36 min
68 min
arrive 11:17a
·
🚶 3 min
›
›
🚶 10 min
›
Clear
💬 Send feedback
Contribute
🧪
In beta — please report any issues
›
Not affiliated with or endorsed by Yale University.`;

  it("reads the redesigned card, whose pill sits above the duration", () => {
    const opts = parseOptions(LIVE_LINE_FIRST);
    expect(opts.map((o) => o.routeLabel)).toEqual(["Blue Day", "Orange Day", "Red", "Walk", "Brown"]);
    expect(opts[0]).toMatchObject({ totalMin: 23, arriveText: "10:33a", walkToMin: 0, walkFromMin: 0 });
    expect(opts[0].eta.raw).toBe("in 3, 21 min");
    expect(opts[1]).toMatchObject({ totalMin: 29, walkToMin: 16 });
    expect(opts[3]).toMatchObject({ mode: "walk", totalMin: 38 });
    // The last card runs into the page footer, and "Contribute" is exactly
    // as label-shaped as a route name.
    expect(opts[4]).toMatchObject({ routeLabel: "Brown", walkToMin: 3, walkFromMin: 10 });
  });

  it("does not take the map overview's legend for the first card's line", () => {
    // The legend lists every drawn route immediately above the first card, so
    // the walk-back that finds the pill must stop after one label.
    expect(parseOptions(LIVE_LINE_FIRST)[0].routeLabel).toBe("Blue Day");
  });

  it("reads a departed card and its missed-bus warning", () => {
    const text = `Departed
🚶 1 min
›
Red
›
🚶 1 min
🚌 The bus will reach your stop before you arrive — check for the next shuttle
Find next bus
14 min
🚌 You can't catch #40 — showing the next bus:
🚌 in 9 min
arrive 5:40p
›
Blue Day
›
🚶 2 min`;
    const opts = parseOptions(text);
    expect(opts[0]).toMatchObject({ departed: true, routeLabel: "Red", totalMin: null });
    expect(opts[1]).toMatchObject({ routeLabel: "Blue Day", missedBus: "40" });
    expect(opts[1].eta.first).toEqual([540, 600]);
  });
});

describe("scoreSequence", () => {
  const at = (s) => 1_700_000_000_000 + s * 1000;
  const sample = (t, raw, extra = {}) => ({
    atMs: at(t), present: true, eta: parseBusEtaText(raw), missedBus: null, ...extra,
  });

  it("stays silent on a healthy countdown", () => {
    const r = scoreSequence([
      sample(0, "🚌 in 10 min"), sample(60, "🚌 in 9 min"),
      sample(120, "🚌 in 8 min"), sample(180, "🚌 in 7 min"),
    ]);
    expect(r.transitions).toHaveLength(0);
    expect(r.readings).toBe(4);
    expect(r.worstDriftSec).toBe(0);
  });

  it("catches the drop the operator described", () => {
    const r = scoreSequence([sample(0, "🚌 in 10 min"), sample(15, "🚌 arriving now")]);
    expect(r.catastrophic).toBe(1);
    expect(r.transitions[0].driftSec).toBeLessThan(0);
    expect(r.transitions[0].reversal).toBe(false);
  });

  it("marks a jump the app itself explained by swapping vehicles", () => {
    const r = scoreSequence([
      sample(0, "🚌 in 1 min"),
      sample(15, "🚌 in 12 min", { missedBus: "40" }),
    ]);
    expect(r.transitions[0]).toMatchObject({ reversal: true, pinAnnouncedChange: true });
  });

  it("does not compare across a gap where the option vanished", () => {
    const r = scoreSequence([
      sample(0, "🚌 in 10 min"),
      { atMs: at(15), present: false, eta: null, missedBus: null },
      sample(30, "🚌 in 1 min"),
    ]);
    expect(r.transitions).toHaveLength(0);
  });

  it("does not compare readings further apart than the gap ceiling", () => {
    const r = scoreSequence([sample(0, "🚌 in 10 min"), sample(600, "🚌 in 20 min")]);
    expect(r.transitions).toHaveLength(0);
  });
});

describe("CANARY_LINES", () => {
  it("agrees with ROUTE_LISTS about which route ids carry each line", async () => {
    // A harness cannot import the .ts source, so the copy is pinned by reading
    // it — the same guard walk.test.ts puts on the walk model.
    const { CANARY_LINES } = await import("./canary-metrics.mjs");
    const src = readFileSync(new URL("../web/src/routes.ts", import.meta.url), "utf8");
    for (const line of CANARY_LINES) {
      const row = src.match(
        new RegExp(`busRouteIds:\\s*\\[([^\\]]*)\\][^\\n]*label:\\s*"${line.label}"`),
      );
      expect(row, `no ROUTE_LISTS row for ${line.label}`).toBeTruthy();
      expect(row[1].split(",").map((s) => Number(s.trim())))
        .toEqual(line.busRouteIds);
    }
  });
});

describe("the catastrophic bar", () => {
  it("is the same number the accuracy gate uses for a lurch", () => {
    // The field bar and the CI bar must not drift apart: a jump the gate would
    // fail on the recorded pass is a jump the canary must name in the wild.
    const gate = readFileSync(
      new URL("../web/src/accuracy-layover.test.ts", import.meta.url), "utf8");
    const m = gate.match(/does not lurch between one poll and the next[\s\S]*?toBeLessThan\((\d+)\)/);
    expect(m, "the lurch assertion moved or was renamed").toBeTruthy();
    expect(THRESHOLDS.catastrophicSec).toBe(Number(m[1]));
  });

  it("would have caught the first live run's 225 s drop", () => {
    // Red #304 at the 344 Winchester layover: "in 7 min" -> "in 2 min", 15 s
    // apart, bus 386 m out and the pin unchanged. The gate skips this moment.
    const drift = conservativeDrift([420, 480], [120, 180], 15);
    expect(drift).toBe(-225);
    expect(Math.abs(drift)).toBeGreaterThanOrEqual(THRESHOLDS.catastrophicSec);
  });
});

describe("which trip a line is ridden on", () => {
  // A synthetic payload in the shape /api/buses serves. Nothing in the suite
  // touches the network.
  const near = (pt, dLat) => ({ lat: pt.lat + dLat, lon: pt.lon });
  const payload = {
    routes: {
      3: [1, 2, 3, 4],              // reaches both ends of the operator's trip
      9: [10, 11, 12, 13, 14, 15, 16, 17],  // nowhere near either
      15: [20, 21, 22, 23],         // every stop on top of the next
      99: [],
    },
    stop_coords: {
      1: near(CANONICAL_TRIP.origin, 0.0005),        // ~55 m from the origin
      2: { lat: 41.315, lon: -72.927 },
      3: near(CANONICAL_TRIP.destination, 0.0005),   // ~55 m from the destination
      4: { lat: 41.310, lon: -72.930 },
      // A line 20 km east: inside no radius of either end.
      10: { lat: 41.30, lon: -72.68 }, 11: { lat: 41.30, lon: -72.67 },
      12: { lat: 41.30, lon: -72.66 }, 13: { lat: 41.30, lon: -72.65 },
      14: { lat: 41.30, lon: -72.64 }, 15: { lat: 41.30, lon: -72.63 },
      16: { lat: 41.30, lon: -72.62 }, 17: { lat: 41.30, lon: -72.61 },
      // Four stops within a few metres of each other, 20 km away.
      20: { lat: 41.40, lon: -72.60 }, 21: { lat: 41.40001, lon: -72.60 },
      22: { lat: 41.40002, lon: -72.60 }, 23: { lat: 41.40003, lon: -72.60 },
    },
    stop_names: { 1: "A", 3: "B", 10: "E0", 12: "E2", 13: "E3", 17: "E7" },
    buses: [{ route_id: 3, bus_name: "#1" }],
  };
  const line = (id) => CANARY_LINES.find((l) => l.busRouteIds[0] === id);

  it("uses the operator's own trip for a line that reaches both ends", () => {
    const t = tripForLine(payload, line(3));
    expect(t.kind).toBe("canonical");
    expect(t.destination.display_name).toBe("School of Public Health (YSPH)");
  });

  it("derives a trip from the line's own stops when it does not", () => {
    const t = tripForLine(payload, line(9));
    expect(t.kind).toBe("derived");
    expect(t.origin.label).toBe("E0");
    // A quarter of eight stops is index 2.
    expect(t.destination.display_name).toBe("E2");
    // A stop is auto-picked by the frontend the way a curated landmark is.
    expect(t.destination.type).toBe("bus_stop");
  });

  it("walks forward until the two ends are far enough apart to be a ride", () => {
    // Every stop on route 15 is within a few metres, so no pair qualifies.
    expect(tripForLine(payload, line(15))).toBeNull();
  });

  it("skips a line upstream serves no stops for", () => {
    expect(tripForLine({ routes: {}, stop_coords: {} }, line(3))).toBeNull();
  });

  it("does not treat the planner's absolute walk limit as a usable walk", () => {
    // At MAX_WALK_M fourteen of fifteen lines "serve" the operator's trip,
    // including ones the app is right to bury. The canonical radius has to be
    // the walk the app itself would plan, not the one past which it gives up.
    expect(CANONICAL_MAX_WALK_M).toBeLessThan(MAX_WALK_M);
    expect(MIN_RIDE_M).toBeLessThan(CANONICAL_MAX_WALK_M);
  });
});

describe("rideableLines", () => {
  it("rides only a line with live buses AND a trip", async () => {
    const { rideableLines } = await import("./rider-canary.mjs");
    const payload = {
      routes: { 3: [1, 2], 9: [] },
      stop_coords: { 1: CANONICAL_TRIP.origin, 2: CANONICAL_TRIP.destination },
      stop_names: {},
      buses: [{ route_id: 3, bus_name: "#1" }, { route_id: 9, bus_name: "#2" }],
    };
    const byLabel = Object.fromEntries(rideableLines(payload).map((l) => [l.label, l]));
    expect(byLabel.Red.rideable).toBe(true);
    // Green has a bus but upstream lists no stops for it — nothing to ride.
    expect(byLabel.Green.rideable).toBe(false);
    // Blue Day has the trip but no bus on the road.
    expect(byLabel["Blue Day"].rideable).toBe(false);
  });
});

describe("the destination the canary serves to the app", () => {
  it("is written in the geocoder's own response shape, display_name and all", () => {
    // The canary fulfils /api/geocode with this object verbatim. The frontend
    // calls display_name.split() to build the suggestion row, so an object
    // that carries `label` instead takes the whole app down through its error
    // boundary — "Cannot read properties of undefined (reading 'split')",
    // which is exactly what happened live on 2026-09-03 the first time a
    // derived trip was passed straight through.
    const payload = {
      routes: { 9: [10, 11, 12, 13] },
      stop_coords: {
        10: { lat: 41.30, lon: -72.68 }, 11: { lat: 41.30, lon: -72.67 },
        12: { lat: 41.30, lon: -72.66 }, 13: { lat: 41.30, lon: -72.65 },
      },
      stop_names: { 10: "E0", 11: "E1" },
    };
    const line = CANARY_LINES.find((l) => l.busRouteIds[0] === 9);
    for (const dest of [CANONICAL_TRIP.destination, tripForLine(payload, line).destination]) {
      expect(typeof dest.display_name).toBe("string");
      expect(dest.display_name.length).toBeGreaterThan(0);
      expect(dest).not.toHaveProperty("label");
      expect(typeof dest.lat).toBe("number");
      expect(typeof dest.lon).toBe("number");
    }
  });
});
