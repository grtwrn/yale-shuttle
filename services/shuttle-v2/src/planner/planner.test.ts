import { describe, expect, it } from "vitest";

import { TransitNetwork } from "../network/TransitNetwork.js";
import type { BusPosition, Route, Stop } from "../schema/api.js";

import { etaAlongRoute } from "./eta.js";
import { planTrip } from "./planner.js";
import { expectedWait } from "./wait.js";

// Simple 4-stop loop along a roughly east-west axis.
//
//   1 ── 2 ── 3 ── 4 ── (back to 1)
//
// Stops are ~800 m apart east-west.
const stops: Stop[] = [
  { id: 1, name: "A", lat: 41.31, lon: -72.93 },
  { id: 2, name: "B", lat: 41.31, lon: -72.92 },
  { id: 3, name: "C", lat: 41.31, lon: -72.91 },
  { id: 4, name: "D", lat: 41.31, lon: -72.90 },
];

const routes: Route[] = [
  {
    id: 10,
    name: "Loop",
    shortName: "L",
    color: "#000",
    stops: [1, 2, 3, 4],
  },
];

function buildCalibratedNet(): TransitNetwork {
  const net = TransitNetwork.build(stops, routes);
  // Calibrate every segment to 60s travel + 10s dwell at every stop.
  const segMap = new Map(
    [
      [1, 2],
      [2, 3],
      [3, 4],
      [4, 1],
    ].map(([from, to]) => [
      TransitNetwork.segmentKey(10, from!, to!),
      { mean: 60, stddev: 5, n: 20, source: "specific" as const },
    ]),
  );
  const dwellMap = new Map(
    [1, 2, 3, 4].map((s) => [
      TransitNetwork.dwellKey(10, s),
      { mean: 10, stddev: 3, n: 20 },
    ]),
  );
  net.setCalibration(segMap, dwellMap);
  return net;
}

const T0 = 1_700_000_000_000;

describe("etaAlongRoute", () => {
  it("zero hops between identical stops", () => {
    const net = buildCalibratedNet();
    const eta = etaAlongRoute(net, 10, 2, 2)!;
    expect(eta.meanSec).toBe(0);
    expect(eta.hops).toBe(0);
  });

  it("sums segment + intermediate dwells", () => {
    const net = buildCalibratedNet();
    // Stop 1 → stop 3: two segments (60+60), one intermediate dwell at stop 2 (10).
    // No dwell at stop 3 (the target).
    const eta = etaAlongRoute(net, 10, 1, 3)!;
    expect(eta.meanSec).toBe(60 + 10 + 60);
    expect(eta.hops).toBe(2);
  });

  it("composes variance additively", () => {
    const net = buildCalibratedNet();
    const eta = etaAlongRoute(net, 10, 1, 3)!;
    // Two segment stddevs of 5 + one dwell stddev of 3 → sqrt(25+25+9) ≈ 7.68
    expect(eta.stddevSec).toBeCloseTo(Math.sqrt(25 + 25 + 9), 4);
  });

  it("wraps around the loop", () => {
    const net = buildCalibratedNet();
    // Stop 4 → stop 2: 4→1 (60+dwell10) + 1→2 (60) = 130 over 2 hops.
    const eta = etaAlongRoute(net, 10, 4, 2)!;
    expect(eta.hops).toBe(2);
    expect(eta.meanSec).toBe(130);
  });

  it("returns null when a stop isn't on the route", () => {
    const net = buildCalibratedNet();
    expect(etaAlongRoute(net, 10, 1, 999)).toBeNull();
    expect(etaAlongRoute(net, 999, 1, 2)).toBeNull();
  });
});

describe("expectedWait", () => {
  it("returns null with no live buses on the route", () => {
    const net = buildCalibratedNet();
    expect(expectedWait(net, [], 10, 2, T0)).toBeNull();
  });

  it("picks the soonest of multiple buses", () => {
    const net = buildCalibratedNet();
    const buses: BusPosition[] = [
      // Bus A: 2 stops away (~130 s away from stop 3)
      busAt(1, "#a", 10, stops[0]!, T0, { lastStopId: 1 }),
      // Bus B: dwelling at stop 2 — 1 hop away from stop 3 (60 s)
      busAt(2, "#b", 10, stops[1]!, T0, { lastStopId: 2, atStopId: 2, atStopSince: T0 }),
    ];
    const wait = expectedWait(net, buses, 10, 3, T0)!;
    expect(wait.busName).toBe("#b");
    // Bus B dwelling at stop 2 since just now → still 60s to stop 3.
    expect(wait.meanSec).toBeCloseTo(60, 0);
  });

  it("discounts elapsed dwell at the anchor stop", () => {
    const net = buildCalibratedNet();
    // Bus has been dwelling at stop 2 for 8 s — typical dwell there is 10 s,
    // so the effective wait to stop 3 should drop a touch from the raw 60 s.
    const buses: BusPosition[] = [
      busAt(1, "#a", 10, stops[1]!, T0, {
        lastStopId: 2,
        atStopId: 2,
        atStopSince: T0 - 8_000,
      }),
    ];
    const wait = expectedWait(net, buses, 10, 3, T0)!;
    expect(wait.meanSec).toBeGreaterThan(50);
    expect(wait.meanSec).toBeLessThan(60);
  });

  it("subtracts position staleness", () => {
    const net = buildCalibratedNet();
    const buses: BusPosition[] = [
      busAt(1, "#a", 10, stops[1]!, T0 - 15_000, { lastStopId: 2 }),
    ];
    const wait = expectedWait(net, buses, 10, 3, T0)!;
    expect(wait.meanSec).toBeCloseTo(60 - 15, 0);
  });
});

describe("planTrip", () => {
  it("always offers a direct walk when it's short", () => {
    const net = buildCalibratedNet();
    const response = planTrip({
      network: net,
      buses: [],
      from: stops[0]!,
      to: { lat: stops[0]!.lat + 0.0005, lon: stops[0]!.lon }, // ~55 m
      now: T0,
    });
    expect(response.plans).toHaveLength(1);
    expect(response.plans[0]!.legs.every((l) => l.mode === "walk")).toBe(true);
    expect(response.plans[0]!.badge).toBe("walk-only");
  });

  it("prefers a bus over a long walk when one is live", () => {
    const net = buildCalibratedNet();
    const buses: BusPosition[] = [
      busAt(1, "#a", 10, stops[0]!, T0, { lastStopId: 1 }),
    ];
    const response = planTrip({
      network: net,
      buses,
      from: stops[0]!,
      to: stops[2]!,
      now: T0,
    });
    // Top plan should ride from 1 → 3, not walk ~1.7 km.
    const top = response.plans[0]!;
    const ride = top.legs.find((l) => l.mode === "ride");
    expect(ride?.mode).toBe("ride");
    if (ride && ride.mode === "ride") {
      expect(ride.boardStopId).toBe(1);
      expect(ride.alightStopId).toBe(3);
    }
    expect(top.badge).toBe("fastest");
    expect(top.totalSec).toBeLessThan(900); // way less than walking
  });

  it("drops the walk-only option when direct walk exceeds an hour", () => {
    const net = buildCalibratedNet();
    const buses: BusPosition[] = [
      busAt(1, "#a", 10, stops[0]!, T0, { lastStopId: 1 }),
    ];
    // Destination ~7 km north → direct walk ≈ 83 min, over the 60-min cutoff.
    const response = planTrip({
      network: net,
      buses,
      from: stops[0]!,
      to: { lat: stops[0]!.lat + 0.063, lon: stops[0]!.lon },
      now: T0,
    });
    const hasWalkOnly = response.plans.some((p) =>
      p.legs.every((l) => l.mode === "walk"),
    );
    expect(hasWalkOnly).toBe(false);
  });

  it("surfaces potential routes even with no live buses", () => {
    const net = buildCalibratedNet();
    const response = planTrip({
      network: net,
      buses: [],
      from: stops[0]!,
      to: stops[2]!,
      now: T0,
    });
    // No live buses → no ride plans, but the route 10 is still potential.
    expect(response.plans.every((p) => p.legs.every((l) => l.mode === "walk"))).toBe(true);
    expect(response.potentialRoutes.some((r) => r.routeId === 10)).toBe(true);
  });
});

// Helpers --------------------------------------------------------------------

function busAt(
  busId: number,
  busName: string,
  routeId: number,
  pos: { lat: number; lon: number },
  collectedAt: number,
  extra: Partial<BusPosition> = {},
): BusPosition {
  return {
    busId,
    busName,
    routeId,
    lat: pos.lat,
    lon: pos.lon,
    heading: 90,
    lastStopId: null,
    atStopId: null,
    atStopSince: null,
    collectedAt,
    ...extra,
  };
}
