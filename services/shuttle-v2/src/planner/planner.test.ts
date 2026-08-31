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

// Out-and-back planning -------------------------------------------------------
//
// Upstream route 9 (Green — West Campus) verbatim. Stops 23, 24, 25 and 26
// each appear twice because the shuttle drives down to Building 400 and back
// out the same way.
const wcSeq = [
  78, 84, 89, 77, 94, 143, 144, 133, 88, 92, 81, 26, 25, 23, 22, 23, 24, 25,
  127, 26, 80, 91, 87,
];
const wcStopIds = [...new Set(wcSeq)];
const wcStops: Stop[] = wcStopIds.map((id, i) => ({
  id,
  name: `S${id}`,
  lat: 41.29,
  lon: -72.98 + i * 0.003,
}));
const wcRoutes: Route[] = [
  {
    id: 9,
    name: "Green - West Campus",
    shortName: "G",
    color: "#000",
    stops: wcSeq,
  },
];

function wcNet(): TransitNetwork {
  const net = TransitNetwork.build(wcStops, wcRoutes);
  const segMap = new Map<string, ReturnType<TransitNetwork["getSegmentStats"]>>();
  for (let i = 0; i < wcSeq.length; i++) {
    const from = wcSeq[i]!;
    const to = wcSeq[(i + 1) % wcSeq.length]!;
    segMap.set(TransitNetwork.segmentKey(9, from, to), {
      mean: 60,
      stddev: 5,
      n: 20,
      source: "specific",
    });
  }
  const dwellMap = new Map(
    wcStopIds.map((s) => [
      TransitNetwork.dwellKey(9, s),
      { mean: 10, stddev: 3, n: 20 },
    ]),
  );
  net.setCalibration(segMap, dwellMap);
  return net;
}

describe("etaAlongRoute on an out-and-back route", () => {
  it("terminates instead of oscillating between the repeated stops", () => {
    // THE BUG: `nextOnRoute` resolves stop 23 to its FIRST occurrence, so the
    // old id-stepping walk went 23 → 22 → 23 → 22 forever, hit its hop cap,
    // and returned null. Measured against the live feed, that erased 219 of
    // 380 ordered stop pairs on route 9 and 54 of 110 on route 10 — and a
    // null ETA makes `expectedWait` give up, so the planner offered nothing
    // at all for those trips.
    const net = wcNet();
    let nulls = 0;
    for (const a of wcStopIds) {
      for (const b of wcStopIds) {
        if (a === b) continue;
        if (etaAlongRoute(net, 9, a, b) === null) nulls++;
      }
    }
    expect(nulls).toBe(0);
  });

  it("rides the turnaround rather than teleporting across it", () => {
    const net = wcNet();
    // Building 800 (index 12) → Building 750 (index 16) is genuinely
    // 25 → 23 → 22 → 23 → 24: four hops down and back, not one.
    const eta = etaAlongRoute(net, 9, 25, 24)!;
    expect(eta.hops).toBe(4);
    expect(eta.meanSec).toBe(4 * 60 + 3 * 10);
  });

  it("targets the first occurrence a bus will reach", () => {
    const net = wcNet();
    // From Building 400 (the turnaround, index 14), Building 800 is next
    // reached at index 17 — three hops out, not the 21 it would take to come
    // back round to the index-12 occurrence.
    expect(etaAlongRoute(net, 9, 22, 25)!.hops).toBe(3);
  });

  it("keeps hop counts bounded by the route's own length", () => {
    const net = wcNet();
    for (const a of wcStopIds) {
      for (const b of wcStopIds) {
        const eta = etaAlongRoute(net, 9, a, b);
        if (eta) expect(eta.hops).toBeLessThan(wcSeq.length);
      }
    }
  });
});

describe("planTrip on an out-and-back route", () => {
  it("offers a ride across the West Campus turnaround", () => {
    // Before the fix this returned walk-only: every candidate died inside
    // `expectedWait`, because the ETA from the bus to the board stop was null.
    const net = wcNet();
    const board = wcStops.find((s) => s.id === 22)!; // the turnaround
    const alight = wcStops.find((s) => s.id === 127)!; // on the return leg
    const buses: BusPosition[] = [
      busAt(1, "#g", 9, wcStops.find((s) => s.id === 23)!, T0, {
        lastStopId: 23,
      }),
    ];
    const response = planTrip({
      network: net,
      buses,
      from: board,
      to: alight,
      now: T0,
    });
    const ride = response.plans
      .flatMap((p) => p.legs)
      .find((l) => l.mode === "ride");
    expect(ride).toBeDefined();
    if (ride && ride.mode === "ride") {
      expect(ride.routeId).toBe(9);
      expect(ride.boardStopId).toBe(22);
      expect(ride.alightStopId).toBe(127);
    }
  });

  it("never proposes boarding and alighting at the same stop", () => {
    // A repeated stop makes this newly possible to get wrong: stop 26 sits at
    // both index 11 and index 19, so a naive forward scan could offer
    // "board at 26, ride the loop, alight at 26".
    const net = wcNet();
    const at26 = wcStops.find((s) => s.id === 26)!;
    const response = planTrip({
      network: net,
      buses: [busAt(1, "#g", 9, at26, T0, { lastStopId: 26 })],
      from: at26,
      to: at26,
      now: T0,
    });
    for (const plan of response.plans) {
      for (const leg of plan.legs) {
        if (leg.mode === "ride") {
          expect(leg.boardStopId).not.toBe(leg.alightStopId);
        }
      }
    }
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
