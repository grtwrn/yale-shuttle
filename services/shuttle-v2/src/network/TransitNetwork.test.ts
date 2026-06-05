import { describe, expect, it } from "vitest";

import type { Route, Stop } from "../schema/api.js";

import { TransitNetwork, WALK_TRANSFER_MAX_M } from "./TransitNetwork.js";

// Synthetic 4-stop network: a small loop and a sibling stop ~50 m from stop 1.
//
//          (4) ~50m from (1)
//   (1) ─── (2)
//    │       │
//   (3) ─── (default loop order: 1→2→3→1)
//
const stops: Stop[] = [
  { id: 1, name: "Origin", lat: 41.31, lon: -72.93 },
  { id: 2, name: "East", lat: 41.31, lon: -72.92 }, // ~840 m east
  { id: 3, name: "South", lat: 41.30, lon: -72.93 }, // ~1.1 km south
  { id: 4, name: "Nearby1", lat: 41.31, lon: -72.9294 }, // ~50 m east of stop 1
];

const routes: Route[] = [
  {
    id: 100,
    name: "Loop",
    shortName: "L",
    color: "#000",
    stops: [1, 2, 3],
  },
];

describe("TransitNetwork", () => {
  it("indexes stops and routes", () => {
    const net = TransitNetwork.build(stops, routes);
    expect(net.stops.get(1)?.name).toBe("Origin");
    expect(net.routes.get(100)?.shortName).toBe("L");
  });

  it("builds segment edges as a loop", () => {
    const net = TransitNetwork.build(stops, routes);
    const fromOne = net.segmentEdges.get(1) ?? [];
    expect(fromOne).toHaveLength(1);
    expect(fromOne[0]).toMatchObject({ routeId: 100, fromStopId: 1, toStopId: 2 });

    const fromThree = net.segmentEdges.get(3) ?? [];
    // Loop closes back to stop 1
    expect(fromThree[0]).toMatchObject({ fromStopId: 3, toStopId: 1 });
  });

  it("hopsForward wraps around the loop", () => {
    const net = TransitNetwork.build(stops, routes);
    expect(net.hopsForward(100, 1, 2)).toBe(1);
    expect(net.hopsForward(100, 1, 3)).toBe(2);
    // 3 → 2 going forward is 2 hops (3→1→2), not -1
    expect(net.hopsForward(100, 3, 2)).toBe(2);
    expect(net.hopsForward(100, 1, 1)).toBe(0);
  });

  it("returns null for hops between stops that aren't on the route", () => {
    const net = TransitNetwork.build(stops, routes);
    // Stop 4 is in the network but not on route 100
    expect(net.hopsForward(100, 1, 4)).toBeNull();
    expect(net.hopsForward(999, 1, 2)).toBeNull();
  });

  it("precomputes walking transfers for nearby stops only", () => {
    const net = TransitNetwork.build(stops, routes);
    const fromOne = net.walkTransfers.get(1) ?? [];
    // Stop 4 (~50 m away) should be a transfer; stops 2, 3 (>800 m) shouldn't.
    const transferIds = fromOne.map((t) => t.toStopId);
    expect(transferIds).toContain(4);
    expect(transferIds).not.toContain(2);
    expect(transferIds).not.toContain(3);

    // Distance roughly matches the great-circle truth (~50 m).
    const toFour = fromOne.find((t) => t.toStopId === 4)!;
    expect(toFour.meters).toBeLessThan(WALK_TRANSFER_MAX_M);
    expect(toFour.meters).toBeGreaterThan(30);
    expect(toFour.seconds).toBeCloseTo(toFour.meters / 1.4, 1);
  });

  it("walking transfers are sorted nearest first", () => {
    // Extra stop slightly farther than 4 but still in range
    const extra: Stop[] = [...stops, { id: 5, name: "Far", lat: 41.31, lon: -72.9285 }];
    const net = TransitNetwork.build(extra, routes);
    const fromOne = net.walkTransfers.get(1) ?? [];
    for (let i = 1; i < fromOne.length; i++) {
      expect(fromOne[i]!.meters).toBeGreaterThanOrEqual(fromOne[i - 1]!.meters);
    }
  });

  it("falls back to a distance-based prior when a segment has no samples", () => {
    const net = TransitNetwork.build(stops, routes);
    const stats = net.getSegmentStats(100, 1, 2);
    expect(stats.source).toBe("prior");
    expect(stats.n).toBe(0);
    expect(stats.mean).toBeGreaterThan(0);
    expect(stats.stddev).toBeGreaterThan(0);
  });

  it("uses calibrated stats once set", () => {
    const net = TransitNetwork.build(stops, routes);
    const key = TransitNetwork.segmentKey(100, 1, 2);
    net.setCalibration(
      new Map([[key, { mean: 47, stddev: 8, n: 25, source: "specific" }]]),
      new Map(),
    );
    const stats = net.getSegmentStats(100, 1, 2);
    expect(stats.mean).toBe(47);
    expect(stats.n).toBe(25);
    expect(stats.source).toBe("specific");
  });

  it("stopsNear ranks closest first and respects the radius", () => {
    const net = TransitNetwork.build(stops, routes);
    const near = net.stopsNear({ lat: 41.31, lon: -72.93 }, 500);
    expect(near[0]?.toStopId).toBe(1);
    expect(near.map((t) => t.toStopId)).not.toContain(2); // 2 is ~840 m away
  });
});
