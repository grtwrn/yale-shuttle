import { describe, expect, it } from "vitest";

import type { LatLon } from "./geo.js";
import {
  derivePath,
  isBetterThanUpstream,
  simplify,
  stopDistances,
  deadheadExcursionM,
  traceFailures,
  type Sample,
} from "./derivePath.js";

/**
 * A loop with real shape. Deliberately not a rectangle: four corners simplify
 * to four points, which the deriver rightly refuses as too crude to be a route
 * line. Real loops turn a dozen times, so the fixture does too.
 */
const CORNERS: LatLon[] = [
  { lat: 41.3100, lon: -72.9300 },
  { lat: 41.3140, lon: -72.9300 },
  { lat: 41.3140, lon: -72.9260 },
  { lat: 41.3180, lon: -72.9260 },
  { lat: 41.3180, lon: -72.9210 },
  { lat: 41.3200, lon: -72.9210 },
  { lat: 41.3200, lon: -72.9150 },
  { lat: 41.3160, lon: -72.9150 },
  { lat: 41.3160, lon: -72.9190 },
  { lat: 41.3120, lon: -72.9190 },
  { lat: 41.3120, lon: -72.9150 },
  { lat: 41.3100, lon: -72.9150 },
];

/** Walk the loop, emitting a position every `stepFrac` of each side. */
function lap(busId: number, startMs: number, stepFrac = 0.02): Sample[] {
  const out: Sample[] = [];
  let t = startMs;
  for (let i = 0; i < CORNERS.length; i++) {
    const a = CORNERS[i]!;
    const b = CORNERS[(i + 1) % CORNERS.length]!;
    for (let f = 0; f < 1; f += stepFrac) {
      out.push({
        busId,
        lat: a.lat + (b.lat - a.lat) * f,
        lon: a.lon + (b.lon - a.lon) * f,
        collectedAt: t,
      });
      t += 5_000;
    }
  }
  out.push({ busId, ...CORNERS[0]!, collectedAt: t });
  return out;
}

/** Stops sitting on the loop — every other corner, so they are all reachable. */
const STOPS: LatLon[] = CORNERS.filter((_, i) => i % 2 === 0);

describe("simplify", () => {
  it("drops collinear points and keeps the ends", () => {
    const line: [number, number][] = Array.from({ length: 50 }, (_, i) => [41.31 + i * 0.0001, -72.93]);
    const out = simplify(line, 0.00002);
    expect(out.length).toBeLessThan(line.length);
    expect(out[0]).toEqual(line[0]);
    expect(out[out.length - 1]).toEqual(line[line.length - 1]);
  });

  it("keeps a corner, which is the whole point of following roads", () => {
    const bend: [number, number][] = [
      [41.310, -72.930], [41.315, -72.930], [41.320, -72.930], [41.320, -72.920],
    ];
    const out = simplify(bend, 0.00002);
    // The three collinear points collapse; the turn must survive.
    expect(out).toHaveLength(3);
    expect(out).toContainEqual([41.320, -72.930]);
  });

  it("handles degenerate input without throwing", () => {
    expect(simplify([], 0.1)).toEqual([]);
    expect(simplify([[1, 2]], 0.1)).toEqual([[1, 2]]);
  });
});

describe("derivePath", () => {
  it("recovers the loop a bus actually drove", () => {
    const d = derivePath(lap(1, 1_000_000), STOPS);
    expect(d).not.toBeNull();
    expect(d!.stopCount).toBe(STOPS.length);
    // Every stop is on the loop, so the line should hug them closely.
    expect(d!.maxStopM).toBeLessThan(60);
    expect(d!.busId).toBe(1);
    // Simplification must not collapse the rectangle.
    expect(d!.path.length).toBeGreaterThanOrEqual(8);
  });

  it("returns null when the route was never fully covered", () => {
    // Only two sides of the loop: several stops never seen.
    const partial = lap(1, 1_000_000).slice(0, 60);
    expect(derivePath(partial, STOPS)).toBeNull();
  });

  it("returns null for an idle route", () => {
    expect(derivePath([], STOPS)).toBeNull();
  });

  // The reason for a minimal covering window: a bus that sits at the depot, or
  // runs two laps, must still yield ONE lap.
  it("ignores a deadhead before the route starts", () => {
    const depot: Sample[] = Array.from({ length: 80 }, (_, i) => ({
      busId: 2, lat: 41.28, lon: -72.99, collectedAt: 900_000 + i * 5_000,
    }));
    const d = derivePath([...depot, ...lap(2, 1_000_000)], STOPS);
    expect(d).not.toBeNull();
    // The depot is ~4 km away; including it would blow the loop length out.
    expect(d!.lengthM).toBeLessThan(12_000);
    expect(d!.maxStopM).toBeLessThan(60);
  });

  // Real input is always several laps from several buses over six hours, and
  // production derives 12 of 15 routes from exactly that. What must never
  // happen is TWO laps of input yielding two laps of output.
  it("never returns more than one lap", () => {
    const one = derivePath(lap(3, 1_000_000), STOPS);
    expect(one).not.toBeNull();
    const two = derivePath([...lap(3, 1_000_000), ...lap(3, 2_000_000)], STOPS);
    if (two) expect(two.lengthM).toBeLessThan(one!.lengthM * 1.5);
  });
});

describe("traceFailures", () => {
  it("counts nothing when the path follows the stops", () => {
    const d = derivePath(lap(1, 1_000_000), STOPS)!;
    expect(traceFailures(d.path, STOPS)).toBe(0);
  });

  // The measure that decides acceptance, so its shape matters: a ride is a
  // handful of stops boarded anywhere, not a lap from stop 0.
  it("punishes a path whose stops do not fall along it in order", () => {
    // Out-of-order vertices force the tracer to wrap, which is the failure that
    // painted most of a loop and then straight diagonals.
    const scrambled: [number, number][] = [
      [41.3100, -72.9300], [41.3200, -72.9150], [41.3140, -72.9260],
      [41.3100, -72.9150], [41.3180, -72.9210], [41.3160, -72.9190],
    ];
    const d = derivePath(lap(1, 1_000_000), STOPS)!;
    expect(traceFailures(scrambled, STOPS)).toBeGreaterThan(traceFailures(d.path, STOPS));
  });

  // Known limitation, recorded rather than hidden: this counts legs the tracer
  // would have to flatten, so it catches wrap failures — the ones that actually
  // broke the map. It does NOT by itself punish a path that is merely far from
  // every stop; `isBetterThanUpstream` covers that with the stop-distance gate,
  // and the two are used together.
  // Distance to the stops is a SEPARATE gate. A line far from every stop cannot
  // order them meaningfully, so it does score wrap failures — but what actually
  // keeps it out is the stop-distance check, which is why both exist.
  it("leaves judging distance-from-the-stops to the stop-distance gate", () => {
    const far = CORNERS.map((c) => [c.lat + 0.05, c.lon] as [number, number]);
    const d = derivePath(lap(1, 1_000_000), STOPS)!;
    expect(isBetterThanUpstream({ ...d, maxStopM: 400 }, far, STOPS, STOPS)).toBe(false);
  });
});

describe("isBetterThanUpstream", () => {
  const derived = () => derivePath(lap(1, 1_000_000), STOPS)!;
  const coarse: [number, number][] = CORNERS.filter((_, i) => i % 4 === 0).map((c) => [c.lat, c.lon]);

  // A two-point published line: it cannot express the loop at all, so most legs
  // would be drawn as straight diagonals. This is Orange Night's problem in
  // miniature (37 points for a 9.5 km loop).
  const tooCoarse: [number, number][] = [[41.3100, -72.9300], [41.3100, -72.9150]];

  it("accepts a derived path that beats a published one too coarse to trace", () => {
    expect(traceFailures(tooCoarse, STOPS)).toBeGreaterThan(0);
    expect(isBetterThanUpstream(derived(), tooCoarse, STOPS, STOPS)).toBe(true);
  });

  // A tie keeps upstream: replacing the operator's own answer buys nothing.
  // (The identical-path case is covered below; this is the general rule.)
  it("keeps a published path that ties on drawable legs", () => {
    const good = derived().path;
    expect(traceFailures(good, STOPS)).toBe(traceFailures(derived().path, STOPS));
    expect(isBetterThanUpstream(derived(), good, STOPS, STOPS)).toBe(false);
  });

  it("accepts when there is no published path at all", () => {
    expect(isBetterThanUpstream(derived(), undefined, STOPS, STOPS)).toBe(true);
  });

  it("declines to replace a published path that is already good", () => {
    const good = derived().path;
    expect(isBetterThanUpstream(derived(), good, STOPS, STOPS)).toBe(false);
  });

  // The regression that proxy-based acceptance let through: Blue Night's
  // derived path sat closer to every stop yet traced WORSE (80 -> 116 unusable
  // legs). Proximity is not the outcome; traceability is.
  it("rejects a path that is closer to the stops but traces worse", () => {
    const d = derived();
    // Pretend a candidate hugs the stops but cannot be walked in order.
    const scrambled: [number, number][] = [
      [41.310, -72.930], [41.320, -72.915], [41.315, -72.930],
      [41.310, -72.915], [41.320, -72.930], [41.315, -72.915],
    ];
    const fake = { ...d, path: scrambled, medianStopM: 1, p90StopM: 1, maxStopM: 2 };
    expect(traceFailures(scrambled, STOPS)).toBeGreaterThan(traceFailures(d.path, STOPS));
    expect(isBetterThanUpstream(fake, d.path, STOPS, STOPS)).toBe(false);
  });

  it("refuses anything that strands a stop far from the line", () => {
    const d = derived();
    expect(isBetterThanUpstream({ ...d, maxStopM: 400 }, coarse, STOPS, STOPS)).toBe(false);
  });
});

describe("stopDistances", () => {
  it("measures each stop to its nearest point on the line", () => {
    const line: [number, number][] = [[41.310, -72.930], [41.320, -72.930]];
    const [onLine, offLine] = stopDistances(line, [
      { lat: 41.310, lon: -72.930 },   // exactly on an endpoint
      { lat: 41.315, lon: -72.920 },   // ~800 m east of the line
    ]);
    expect(onLine).toBeLessThan(5);
    expect(offLine).toBeGreaterThan(300);
  });
});

describe("deadheadExcursionM", () => {
  const upstream: [number, number][] = CORNERS.map((c) => [c.lat, c.lon]);

  it("is zero for a path that stays on the published route", () => {
    const d = derivePath(lap(1, 1_000_000), STOPS)!;
    expect(deadheadExcursionM(d.path, upstream, STOPS)).toBeLessThan(600);
  });

  // Blue Night: both buses drive 2.1 km north hourly, up to 996 m off the
  // published line, past none of the route's stops. Real driving, not route.
  it("catches a long stretch that is off the line and serves no stop", () => {
    const withRelief: [number, number][] = [
      ...upstream.slice(0, 3),
      [41.3300, -72.9300], [41.3320, -72.9300], [41.3340, -72.9300],
      [41.3340, -72.9260], [41.3300, -72.9260],
      ...upstream.slice(3),
    ];
    expect(deadheadExcursionM(withRelief, upstream, STOPS)).toBeGreaterThan(600);
  });

  it("does not punish a long hop that follows the published line", () => {
    // Routes 9 and 10 run kilometres to West Campus with no stop between; the
    // vertices are far from every stop but sit on the published line.
    const far: LatLon[] = [STOPS[0]!, STOPS[1]!];
    expect(deadheadExcursionM(upstream, upstream, far)).toBe(0);
  });

  it("judges nothing when there is no published path", () => {
    expect(deadheadExcursionM(upstream, undefined, STOPS)).toBe(0);
  });
});

describe("isBetterThanUpstream: the deadhead gate", () => {
  it("refuses a path that beats upstream everywhere but drives off-route", () => {
    const d = derivePath(lap(1, 1_000_000), STOPS)!;
    const upstream: [number, number][] = [[41.3100, -72.9300], [41.3100, -72.9150]];
    expect(isBetterThanUpstream(d, upstream, STOPS, STOPS)).toBe(true);
    const withRelief = {
      ...d,
      path: [
        ...d.path.slice(0, 3),
        [41.3300, -72.9300], [41.3320, -72.9300], [41.3340, -72.9300],
        [41.3340, -72.9260], [41.3300, -72.9260],
        ...d.path.slice(3),
      ] as [number, number][],
    };
    expect(isBetterThanUpstream(withRelief, upstream, STOPS, STOPS)).toBe(false);
  });
});
