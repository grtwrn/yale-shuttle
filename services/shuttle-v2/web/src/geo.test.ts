import { describe, expect, it } from "vitest";

import { distanceToSegmentM, haversineMeters, progressAlongSegment } from "./geo";
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
