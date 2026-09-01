import { describe, expect, it } from "vitest";

import { distanceToSegmentM, haversineMeters, progressAlongSegment, buildStopSequencePolyline, polylineMeters } from "./geo";
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
    // Two stops ~120 m apart: 2x would be 240 m, under the 250 m floor, so the
    // road going around a corner must still be allowed.
    const dense: [number, number][] = [
      [41.3100, -72.9300], [41.3105, -72.9300],
      [41.3105, -72.9310], [41.3110, -72.9310],
    ];
    const stops = [
      { lat: 41.3100, lon: -72.9300 },
      { lat: 41.3110, lon: -72.9310 },
    ];
    const line = buildStopSequencePolyline(dense, stops);
    expect(line).toBeDefined();
    expect(line!.length).toBeGreaterThan(2); // not flattened to a straight line
  });
});
