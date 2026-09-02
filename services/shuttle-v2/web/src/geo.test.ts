import { describe, expect, it } from "vitest";

import { distanceToSegmentM, haversineMeters, progressAlongSegment, buildStopSequencePolyline, polylineMeters, rideStopDots, traceStopLegs } from "./geo";
import { at, STOP } from "./__fixtures__/payload";

describe("haversineMeters", () => {
  it("is zero for a point against itself", () => {
    expect(haversineMeters(at(STOP.phelpsGate), at(STOP.phelpsGate))).toBe(0);
  });

  it("is symmetric", () => {
    const a = at(STOP.phelpsGate), b = at(STOP.cedar333);
    expect(haversineMeters(a, b)).toBeCloseTo(haversineMeters(b, a), 9);
  });

  it("matches a known campus distance", () => {
    // Broadway/York to Elm/York — the near-collision pair, ~23 m apart.
    expect(haversineMeters(at(STOP.broadwayYork), at(STOP.elmYorkTyco)))
      .toBeCloseTo(22.7, 0);
  });

  it("agrees with the flat-earth approximation at campus scale", () => {
    const a = at(STOP.phelpsGate), b = at(STOP.cedar333);
    const flat = Math.hypot((b.lat - a.lat) * 111_000, (b.lon - a.lon) * 84_000);
    expect(haversineMeters(a, b)).toBeCloseTo(flat, -2); // within ~50 m
  });

  it("handles a degree of latitude", () => {
    expect(haversineMeters({ lat: 41, lon: -72 }, { lat: 42, lon: -72 }))
      .toBeCloseTo(111_195, -2);
  });
});

describe("progressAlongSegment", () => {
  const a = { lat: 41.30, lon: -72.93 };
  const b = { lat: 41.31, lon: -72.93 };

  it("reports 0 at the start and 1 at the end", () => {
    expect(progressAlongSegment(a, a, b)).toBeCloseTo(0, 9);
    expect(progressAlongSegment(b, a, b)).toBeCloseTo(1, 9);
  });

  it("reports the midpoint as one half", () => {
    expect(progressAlongSegment({ lat: 41.305, lon: -72.93 }, a, b)).toBeCloseTo(0.5, 6);
  });

  it("goes past 1 beyond the end and below 0 before the start", () => {
    expect(progressAlongSegment({ lat: 41.32, lon: -72.93 }, a, b)).toBeGreaterThan(1);
    expect(progressAlongSegment({ lat: 41.29, lon: -72.93 }, a, b)).toBeLessThan(0);
  });

  // This is the whole reason the anchor projects instead of comparing
  // straight-line distances: jitter across the segment must not move it.
  it("is barely moved by jitter perpendicular to the segment", () => {
    const mid = { lat: 41.305, lon: -72.93 };
    const jittered = { lat: 41.305, lon: -72.93 + 30 / 84_000 };
    expect(progressAlongSegment(jittered, a, b)).toBeCloseTo(
      progressAlongSegment(mid, a, b), 6,
    );
  });

  it("returns 0 for a degenerate zero-length segment", () => {
    expect(progressAlongSegment({ lat: 41.31, lon: -72.93 }, a, a)).toBe(0);
  });
});

describe("distanceToSegmentM", () => {
  const a = { lat: 41.30, lon: -72.93 };
  const b = { lat: 41.31, lon: -72.93 };

  it("is zero on the segment", () => {
    expect(distanceToSegmentM({ lat: 41.305, lon: -72.93 }, a, b)).toBeCloseTo(0, 6);
  });

  it("measures the perpendicular offset in metres", () => {
    const off = { lat: 41.305, lon: -72.93 + 100 / 84_000 };
    expect(distanceToSegmentM(off, a, b)).toBeCloseTo(100, 0);
  });

  // Clamping is what stops a point beyond an endpoint from being credited with
  // an imaginary perpendicular in the wrong direction.
  it("clamps past the endpoints instead of projecting beyond them", () => {
    const beyond = { lat: 41.32, lon: -72.93 };
    expect(distanceToSegmentM(beyond, a, b)).toBeCloseTo(haversineMeters(beyond, b), -1);
    const before = { lat: 41.29, lon: -72.93 };
    expect(distanceToSegmentM(before, a, b)).toBeCloseTo(haversineMeters(before, a), -1);
  });
});

describe("buildStopSequencePolyline: rejecting an implausible trace", () => {
  // A dense polyline down a straight line, sampled every ~11 m.
  const dense: [number, number][] = Array.from({ length: 60 }, (_, i) => [
    41.31 + i * 0.0001,
    -72.93,
  ]);

  it("traces the ride when the polyline can actually support it", () => {
    const stops = [
      { lat: 41.3105, lon: -72.93 },
      { lat: 41.3115, lon: -72.93 },
      { lat: 41.3125, lon: -72.93 },
    ];
    const line = buildStopSequencePolyline(dense, stops);
    expect(line).toBeDefined();
    // Follows the path rather than cutting straight: more points than stops.
    expect(line!.length).toBeGreaterThan(stops.length);
    // ...and stays close to the straight-line distance through those stops.
    const direct = polylineMeters(stops.map((s) => [s.lat, s.lon] as [number, number]));
    expect(polylineMeters(line!)).toBeLessThan(direct * 2.5);
  });

  // The real defect: Orange Night publishes 37 points for 26 stops, so stops
  // land 380-430 m from the nearest point, the index mapping inverts, and the
  // wrap branch appends most of the loop — drawing the whole route solid in the
  // rider's colour for a short ride.
  it("returns undefined rather than drawing most of the loop", () => {
    // A closed loop sampled so coarsely that stops cannot map monotonically.
    const coarse: [number, number][] = [
      [41.310, -72.930], [41.320, -72.930], [41.330, -72.920],
      [41.330, -72.910], [41.320, -72.900], [41.310, -72.900],
      [41.300, -72.910], [41.300, -72.925],
    ];
    // Two stops that sit near the END of the loop, then one near the START —
    // forcing the wrap that appends nearly the whole ring.
    const stops = [
      { lat: 41.3005, lon: -72.9105 },
      { lat: 41.3005, lon: -72.9245 },
      { lat: 41.3105, lon: -72.9295 },
    ];
    const line = buildStopSequencePolyline(coarse, stops);
    if (line) {
      // If it still returns something, it must not be a wild detour.
      const direct = polylineMeters(stops.map((s) => [s.lat, s.lon] as [number, number]));
      expect(polylineMeters(line)).toBeLessThanOrEqual(direct * 2.5);
    } else {
      expect(line).toBeUndefined();
    }
  });

  it("bails out on input it cannot trace at all", () => {
    expect(buildStopSequencePolyline(undefined, [{ lat: 41.31, lon: -72.93 }])).toBeUndefined();
    expect(buildStopSequencePolyline(dense, undefined)).toBeUndefined();
    expect(buildStopSequencePolyline(dense, [{ lat: 41.31, lon: -72.93 }])).toBeUndefined();
  });
});

describe("buildStopSequencePolyline: per-leg validation", () => {
  // A square loop, coarsely sampled — the shape that made the tracer wrap.
  const loop: [number, number][] = [
    [41.310, -72.930], [41.320, -72.930], [41.330, -72.920],
    [41.330, -72.910], [41.320, -72.900], [41.310, -72.900],
    [41.300, -72.910], [41.300, -72.925],
  ];

  it("bridges only the bad leg, keeping the good ones", () => {
    // A path with real intermediate vertices, so "followed the road" is
    // distinguishable from "drew a straight line between the stops".
    // A modest dogleg — ~1.7x the straight line, which is what a real road
    // going around a block looks like. (A 2.5x excursion is correctly
    // rejected; that is the rule working, not a bug.)
    const withCorners: [number, number][] = [
      [41.3100, -72.9300], [41.3100, -72.9290], [41.3120, -72.9290],
      [41.3120, -72.9300], [41.3140, -72.9300],
    ];
    const stops = [
      { lat: 41.3100, lon: -72.9300 },
      { lat: 41.3120, lon: -72.9300 },
      { lat: 41.3140, lon: -72.9300 },
    ];
    const line = buildStopSequencePolyline(withCorners, stops);
    expect(line).toBeDefined();
    // The dogleg out to -72.9280 must survive: a flattened leg would drop it.
    expect(line!.some(([, lon]) => Math.abs(lon - -72.929) < 1e-9)).toBe(true);
    // ...and the result is not simply the straight stop-to-stop line.
    expect(polylineMeters(line!)).toBeGreaterThan(
      polylineMeters(stops.map((s) => [s.lat, s.lon] as [number, number])),
    );
  });

  it("never lets one leg drag in most of the loop", () => {
    // Walk every consecutive pair around the loop; no leg may exceed the
    // straight-line distance by more than the allowance.
    for (let i = 0; i < loop.length; i++) {
      const a = { lat: loop[i][0], lon: loop[i][1] };
      const b = { lat: loop[(i + 1) % loop.length][0], lon: loop[(i + 1) % loop.length][1] };
      const line = buildStopSequencePolyline(loop, [a, b]);
      if (!line) continue;
      const direct = haversineMeters(a, b);
      expect(polylineMeters(line)).toBeLessThanOrEqual(Math.max(250, direct * 2) + 1);
    }
  });

  it("keeps a short leg's real geometry instead of flattening it", () => {
    // Two stops one block apart, with the road turning a corner between them.
    // The corner must survive: flattening it draws a line through the block.
    const line = buildStopSequencePolyline(loop, [
      { lat: 41.310, lon: -72.930 },
      { lat: 41.330, lon: -72.920 },
    ]);
    expect(line).toBeDefined();
    expect(line!.length).toBeGreaterThan(2); // not flattened to a straight line
  });

  // Stops sit mid-block far more often than on a corner, and a published
  // polyline carries a vertex only where the road turns. Snapping a stop to the
  // nearest VERTEX was the bug behind every straight diagonal: on Orange Night
  // the median stop is 97 m from a vertex but 6 m from the line itself.
  it("starts and ends a leg at the stop's own place on the line, not at a corner", () => {
    const stops = [
      { lat: 41.315, lon: -72.930 }, // mid-block, between two corners
      { lat: 41.330, lon: -72.915 }, // mid-block on another side
    ];
    const line = buildStopSequencePolyline(loop, stops)!;
    expect(line).toBeDefined();
    for (const [i, stop] of stops.entries()) {
      const end = i === 0 ? line[0]! : line[line.length - 1]!;
      expect(haversineMeters({ lat: end[0], lon: end[1] }, stop)).toBeLessThan(30);
    }
  });
});

describe("buildStopSequencePolyline: the drawn line IS the published route", () => {
  const loop: [number, number][] = [
    [41.3100, -72.9300], [41.3120, -72.9300], [41.3140, -72.9300],
    [41.3140, -72.9260], [41.3140, -72.9220], [41.3100, -72.9220],
    [41.3100, -72.9260],
  ];

  /** Distance from a point to the polyline itself — segments, not vertices. */
  const toLine = (lat: number, lon: number): number => {
    let best = Infinity;
    for (let i = 1; i < loop.length; i++) {
      const a = loop[i - 1]!;
      const b = loop[i]!;
      const kx = 111_320 * Math.cos((lat * Math.PI) / 180);
      const ax = a[1] * kx, ay = a[0] * 111_320;
      const bx = b[1] * kx, by = b[0] * 111_320;
      const px = lon * kx, py = lat * 111_320;
      const dx = bx - ax, dy = by - ay;
      const l2 = dx * dx + dy * dy;
      let t = l2 < 1e-9 ? 0 : ((px - ax) * dx + (py - ay) * dy) / l2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
      if (d < best) best = d;
    }
    return best;
  };

  // The invariant that replaced counting diagonals. Measured the same way
  // against production, 99.1% of every drawn metre lands on a published street.
  it("draws no metre that is not on the published line", () => {
    for (let i = 0; i < loop.length; i++) {
      for (const span of [1, 2, 3]) {
        const stops = [
          { lat: loop[i]![0], lon: loop[i]![1] },
          { lat: loop[(i + span) % loop.length]![0], lon: loop[(i + span) % loop.length]![1] },
        ];
        const legs = traceStopLegs(loop, stops);
        for (const leg of legs) {
          if (leg.bridged) continue; // a straight bridge is off-route by design
          for (const [lat, lon] of leg.slice) {
            expect(toLine(lat, lon)).toBeLessThan(25);
          }
        }
      }
    }
  });

  // The guard that remains. A wrap is the one failure projection cannot rule
  // out, and it is bounded by geometry rather than a tuned ratio: no leg
  // between consecutive stops covers the whole loop.
  it("bridges rather than drawing nearly the entire loop for one leg", () => {
    const loopM = polylineMeters(loop);
    for (let i = 0; i < loop.length; i++) {
      for (let j = 0; j < loop.length; j++) {
        const legs = traceStopLegs(loop, [
          { lat: loop[i]![0], lon: loop[i]![1] },
          { lat: loop[j]![0], lon: loop[j]![1] },
        ]);
        for (const leg of legs) {
          expect(polylineMeters(leg.slice)).toBeLessThanOrEqual(loopM * 0.9 + 1);
        }
      }
    }
  });
});

// The stops a rider passes between boarding and getting off. Report #47
// asked to see them on the trip map ("I could see them in the list but no
// dots on the map").
describe("rideStopDots", () => {
  it("is empty when the rider boards and alights with nothing in between", () => {
    expect(rideStopDots([at(STOP.phelpsGate), at(STOP.cedar333)])).toEqual([]);
  });

  it("is empty for a degenerate ride", () => {
    expect(rideStopDots([])).toEqual([]);
    expect(rideStopDots([at(STOP.phelpsGate)])).toEqual([]);
  });

  it("returns the in-between stops, in ride order", () => {
    const ride = [at(STOP.phelpsGate), at(STOP.elmYork), at(STOP.york129), at(STOP.cedar333)];
    expect(rideStopDots(ride)).toEqual([at(STOP.elmYork), at(STOP.york129)]);
  });

  it("drops a stop the ride passes twice — it would sit under the board ring", () => {
    // Routes 9 and 10 repeat stops for the West Campus out-and-back, so the
    // board stop can appear again mid-ride. A faded dot under the board
    // marker just muddies the marker that has to stay dominant.
    const ride = [at(STOP.phelpsGate), at(STOP.elmYork), at(STOP.phelpsGate), at(STOP.cedar333)];
    expect(rideStopDots(ride)).toEqual([at(STOP.elmYork)]);
  });

  it("keeps distinct stops that are only metres apart", () => {
    // College/Wall (N) and (S) are 28 m apart but are two real stops — the
    // endpoint filter must not swallow near neighbours (see CLAUDE.md).
    const collegeWallS = at(42);
    expect(haversineMeters(at(STOP.collegeWallN), collegeWallS)).toBeLessThan(30);
    const ride = [at(STOP.phelpsGate), at(STOP.collegeWallN), collegeWallS, at(STOP.cedar333)];
    expect(rideStopDots(ride)).toEqual([at(STOP.collegeWallN), collegeWallS]);
  });
});
