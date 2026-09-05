import { describe, expect, it } from "vitest";

import type { Route, Stop } from "../schema/api.js";

import { TransitNetwork, WALK_TRANSFER_MAX_M, WALK_M_PER_S, type DwellStats } from "./TransitNetwork.js";

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
    expect(toFour.seconds).toBeCloseTo(toFour.meters / WALK_M_PER_S, 1);
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

  it("nearestStopOnRoute reports the sequence index, not just the id", () => {
    const net = TransitNetwork.build(stops, routes);
    const anchor = net.nearestStopOnRoute(100, { lat: 41.31, lon: -72.92 })!;
    expect(anchor.stopId).toBe(2);
    expect(anchor.index).toBe(1);
  });

  it("nearestStopOnRoute honours a radius cap", () => {
    const net = TransitNetwork.build(stops, routes);
    const far = { lat: 41.5, lon: -72.93 }; // ~21 km north of everything
    expect(net.nearestStopOnRoute(100, far)).not.toBeNull();
    expect(net.nearestStopOnRoute(100, far, 75)).toBeNull();
  });
});

// Out-and-back topology, taken verbatim from upstream route 10 (Purple —
// West Campus): the shuttle runs down to Building 400 and back out the same
// way, so 23, 24, 25 and 26 each appear TWICE in the sequence.
//
//   idx: 0  1  2   3   4   5  6  7  8  9  10 11 12 13 14
//   id:  10 9  1  122 127 26 25 24 23 22 23 24 25 26 72
//                                   └──turnaround──┘
const outAndBackRoute: Route = {
  id: 10,
  name: "Purple - West Campus",
  shortName: "P",
  color: "#000",
  stops: [10, 9, 1, 122, 127, 26, 25, 24, 23, 22, 23, 24, 25, 26, 72],
};

// Laid out west-to-east so "nearest" is well defined and the out and back
// legs retrace the same coordinates, exactly as the real stops do.
const outAndBackStops: Stop[] = [10, 9, 1, 122, 127, 26, 25, 24, 23, 22, 72].map(
  (id, i) => ({ id, name: `S${id}`, lat: 41.29, lon: -72.95 + i * 0.004 }),
);

describe("TransitNetwork with repeated stops (West Campus out-and-back)", () => {
  const net = TransitNetwork.build(outAndBackStops, [outAndBackRoute]);

  it("records every occurrence of a repeated stop", () => {
    expect(net.positionsOnRoute(10, 23)).toEqual([8, 10]);
    expect(net.positionsOnRoute(10, 26)).toEqual([5, 13]);
    expect(net.positionsOnRoute(10, 22)).toEqual([9]); // turnaround, visited once
    expect(net.positionsOnRoute(10, 999)).toEqual([]);
  });

  it("keeps positionOnRoute on the first (pessimistic) occurrence", () => {
    expect(net.positionOnRoute(10, 23)).toBe(8);
    expect(net.positionOnRoute(10, 26)).toBe(5);
  });

  it("hopsForward takes the shortest connecting distance on the return leg", () => {
    // THE BUG: with first-occurrence-only indexing these scored 14 hops each,
    // blew past the detector's MAX_SEGMENT_HOPS of 5, and were discarded —
    // so the entire West Campus return leg had zero calibration samples.
    expect(net.hopsForward(10, 22, 23)).toBe(1);
    expect(net.hopsForward(10, 23, 24)).toBe(1);
    expect(net.hopsForward(10, 24, 25)).toBe(1);
    expect(net.hopsForward(10, 25, 26)).toBe(1);
    expect(net.hopsForward(10, 26, 72)).toBe(1);
  });

  it("hopsForward still measures the outbound leg correctly", () => {
    expect(net.hopsForward(10, 127, 26)).toBe(1);
    expect(net.hopsForward(10, 26, 25)).toBe(1);
    expect(net.hopsForward(10, 23, 22)).toBe(1);
  });

  it("stopIdAtIndex wraps in both directions", () => {
    expect(net.stopIdAtIndex(10, 0)).toBe(10);
    expect(net.stopIdAtIndex(10, 14)).toBe(72);
    expect(net.stopIdAtIndex(10, 15)).toBe(10); // wraps forward
    expect(net.stopIdAtIndex(10, -1)).toBe(72); // wraps backward
    expect(net.stopIdAtIndex(999, 0)).toBeNull();
  });

  it("documents that nextOnRoute cannot walk an out-and-back route", () => {
    // Kept as an executable warning: id-addressed stepping oscillates
    // 23 → 22 → 23 → 22 forever and never reaches 24. This is why
    // etaAlongRoute walks indices instead.
    expect(net.nextOnRoute(10, 23)).toBe(22);
    expect(net.nextOnRoute(10, 22)).toBe(23);
  });

  it("does not emit a segment edge for a stop repeated back-to-back", () => {
    const degenerate = TransitNetwork.build(outAndBackStops, [
      { ...outAndBackRoute, id: 11, stops: [10, 9, 9, 1] },
    ]);
    const fromNine = degenerate.segmentEdges.get(9) ?? [];
    expect(fromNine.map((e) => e.toStopId)).toEqual([1]);
  });
});

describe("nearestStopAheadOnRoute", () => {
  // Route that doubles back within metres of itself, as route 1 does at
  // College/Wall: `(S)` at index 1 and `(N)` at index 3 are 28 m apart.
  // Sequence: 1 → 2 (Wall S) → 3 → 5 → 4 (Wall N). The twin sits at index 4,
  // ten stops downstream in the real route 1 and well outside any sane
  // lookahead window — but 28 m away on the ground.
  const twinStops: Stop[] = [
    { id: 1, name: "Start", lat: 41.31, lon: -72.93 },
    { id: 2, name: "College / Wall (S)", lat: 41.315, lon: -72.925 },
    { id: 3, name: "Phelps Gate", lat: 41.318, lon: -72.928 },
    { id: 5, name: "Elm / York", lat: 41.32, lon: -72.94 },
    { id: 4, name: "College / Wall (N)", lat: 41.31525, lon: -72.925 },
  ];
  const twinRoute: Route = {
    id: 1,
    name: "Doubles back",
    shortName: "D",
    color: "#000",
    stops: [1, 2, 3, 5, 4],
  };
  const net = TransitNetwork.build(twinStops, [twinRoute]);

  it("ignores a physically-closer stop that is out of sequence", () => {
    // Southbound bus stopped at College/Wall, nudged a few metres north by
    // GPS noise — enough to land closer to the (N) twin than to its own stop.
    const atCollegeWall = { lat: 41.3152, lon: -72.925 };
    // A global scan picks the wrong twin — that is the defect.
    expect(net.nearestStopOnRoute(1, atCollegeWall)!.stopId).toBe(4);
    // Windowed from index 1, only indices 1..3 are eligible.
    const ahead = net.nearestStopAheadOnRoute(1, atCollegeWall, 1, 2)!;
    expect(ahead.stopId).toBe(2);
    expect(ahead.index).toBe(1);
  });

  it("lets a bus that has not moved stay where it is", () => {
    const anchor = net.nearestStopAheadOnRoute(
      1,
      { lat: 41.31, lon: -72.93 },
      0,
      2,
    )!;
    expect(anchor.index).toBe(0);
  });

  it("wraps the window past the end of the sequence", () => {
    const anchor = net.nearestStopAheadOnRoute(
      1,
      { lat: 41.31, lon: -72.93 },
      4,
      2,
    )!;
    // From index 4 the window is {4, 0, 1}; stop 1 (index 0) is the closest.
    expect(anchor.index).toBe(0);
  });

  it("never returns a candidate outside the window", () => {
    // Even standing exactly on the (N) twin at index 4, a window starting at
    // index 0 with a span of 2 can only answer with indices 0, 1 or 2.
    const anchor = net.nearestStopAheadOnRoute(1, twinStops[4]!, 0, 2)!;
    expect(anchor.index).toBeLessThanOrEqual(2);
  });
});

describe("TransitNetwork leg metres and per-pass dwell keys", () => {
  // A rectangle: stops 1 and 2 on the bottom side, 3 on the top. 1→2 runs
  // straight (road ≈ chord); 2→3 goes round the corner; 3→1 round the other.
  const path: [number, number][] = [
    [41.31, -72.93], [41.31, -72.91], [41.312, -72.91], [41.312, -72.93],
  ];
  const rectStops: Stop[] = [
    { id: 1, name: "A", lat: 41.31, lon: -72.93 },
    { id: 2, name: "B", lat: 41.31, lon: -72.92 },
    { id: 3, name: "C", lat: 41.312, lon: -72.92 },
  ];

  it("measures each hop along the published line, keyed like the segment stats", () => {
    const net = TransitNetwork.build(rectStops, [
      { id: 3, name: "Red", shortName: "R", color: "#c00", stops: [1, 2, 3], path },
    ]);
    const ab = net.getLegMeters(3, 1, 2)!;
    const bc = net.getLegMeters(3, 2, 3)!;
    const ca = net.getLegMeters(3, 3, 1)!;
    expect(ab).toBeCloseTo(837, -1); // one straight block east
    expect(bc).toBeGreaterThan(1800); // east to the corner, up, and back west: ~837 + 222 + 837
    expect(ca).toBeGreaterThan(1000); // west along the top and down: ~837 + 222
    expect(net.getLegMeters(3, 2, 1)).toBeUndefined(); // not a hop of the route
    expect(net.getLegMeters(4, 1, 2)).toBeUndefined();
  });

  it("has no leg metres without a path or with a stop it cannot place", () => {
    const noPath = TransitNetwork.build(rectStops, [
      { id: 3, name: "Red", shortName: "R", color: "#c00", stops: [1, 2, 3] },
    ]);
    expect(noPath.getLegMeters(3, 1, 2)).toBeUndefined();
    const missingStop = TransitNetwork.build(rectStops, [
      { id: 3, name: "Red", shortName: "R", color: "#c00", stops: [1, 2, 99], path },
    ]);
    expect(missingStop.getLegMeters(3, 1, 2)).toBeUndefined();
  });

  it("keys one pass of a repeated stop as route:stop#index and reads it back", () => {
    expect(TransitNetwork.occurrenceDwellKey(10, 25, 6)).toBe("10:25#6");
    const net = TransitNetwork.build(rectStops, [
      { id: 10, name: "Purple", shortName: "P", color: "#808", stops: [1, 2, 3, 2] },
    ]);
    const pass = { mean: 100, stddev: 5, n: 2, q: [90, 110], qn: 2 };
    net.setCalibration(new Map(), new Map<string, DwellStats>([["10:2#1", pass], ["10:2", { mean: 15, stddev: 10, n: 0 }]]));
    expect(net.getOccurrenceDwellStats(10, 2, 1)).toEqual(pass);
    expect(net.getOccurrenceDwellStats(10, 2, 3)).toBeUndefined();
    expect(net.getDwellStats(10, 2).n).toBe(0); // the pooled entry, untouched
  });
});
