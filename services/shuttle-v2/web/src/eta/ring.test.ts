import { describe, expect, it } from "vitest";

import green from "../__fixtures__/green-published-order.json";
import pink from "../__fixtures__/pink-published-order.json";
import purple from "../__fixtures__/purple-published-order.json";
import incidents from "../__fixtures__/anchor-incidents.json";
import { haversineMeters, polylineMeters, traceStopLegs, type LatLon } from "../geo";
import { buildRing } from "./ring";

const greenStops = green.stops as number[];
const greenPath = green.path as [number, number][];
const greenCoords: Record<number, LatLon> = {};
for (const [id, c] of Object.entries(green.stopCoords as unknown as Record<string, number[]>)) {
  greenCoords[Number(id)] = { lat: c[0]!, lon: c[1]! };
}

const others = incidents as unknown as {
  routes: Record<string, { stops: number[]; path: [number, number][] }>;
  stopCoords: Record<string, { lat: number; lon: number }>;
};
const otherCoords: Record<number, LatLon> = {};
for (const [id, c] of Object.entries(others.stopCoords)) otherCoords[Number(id)] = c;

describe("the ring repairs a stop order its own line cannot supply", () => {
  const ring = buildRing("green", greenPath, greenStops, greenCoords)!;

  it("is no longer bridged, so the model no longer declines the route", () => {
    expect(ring).not.toBeNull();
    expect(ring.bridged).toBe(false);
    expect(ring.repaired).toBe(true);
  });

  it("puts Building 900 before the station on the return, and gives the station its outbound pass", () => {
    expect(Array.from(ring.order)).toEqual(green.repairedOrder);
    expect(ring.stops).toEqual((green.repairedOrder as number[]).map((i) => greenStops[i]));
    expect(ring.serviceEligible).toEqual(new Array(ring.N).fill(true));
    // The added outbound station call is service, as are the original
    // repeated building calls; repeated IDs must not be deduplicated.
    expect(ring.stops.filter((id, i) => id === 127 && ring.serviceEligible[i])).toHaveLength(2);
    for (const id of new Set(greenStops)) {
      const publishedCalls = greenStops.filter((sid) => sid === id).length;
      expect(ring.order.filter((p, i) => greenStops[p] === id && ring.serviceEligible[i]).length)
        .toBeGreaterThanOrEqual(publishedCalls);
    }
  });

  it("lays its cells on the published line and nowhere else", () => {
    // The legs of a repaired ring are slices of the published polyline, so
    // they sum to it. The bridged ring did not: it drew 36,270 m of a 29,086 m
    // line, 7 km of that straight through West Haven.
    const loop = polylineMeters(greenPath);
    expect(Math.abs(ring.loopM - loop) / loop).toBeLessThan(0.005);
  });

  it("gives the two highway hops their real road length", () => {
    // Upstream's order priced Bradley (S) -> Building 900 at 14,385 m (it had
    // run past Building 900 to its second pass) and could give the station leg
    // no road at all.
    const legM = Array.from(ring.legM).map(Math.round);
    const long = legM.filter((m) => m > 5_000).sort((a, b) => b - a);
    expect(long.length).toBe(2);
    // Both are now hops the detector can bill; upstream's order made one of
    // them 14,385 m of chord with the station stranded inside it.
    expect(long[0]).toBeLessThan(10_000);
  });
});

it("places Green's outbound Building 800 call at its kerb", () => {
  const ring = buildRing("9|published-green", greenPath, greenStops, greenCoords)!;
  const outbound = ring.stops.findIndex((id, i) => id === 25
    && ring.stops[(i - 1 + ring.N) % ring.N] === 26
    && ring.stops[(i + 1) % ring.N] === 23);
  expect(outbound).toBeGreaterThan(0);
  const cell = ring.stopCell[outbound]!;
  const kerb = greenCoords[25]!;
  expect(haversineMeters({ lat: ring.lat[cell]!, lon: ring.lon[cell]! }, kerb)).toBeLessThan(5);
  expect(ring.nearStop[cell]).toBe(outbound);
});

describe("the ring adds the passes an out-and-back's list flattens", () => {
  const coordsOf = (fx: { stopCoords: Record<string, number[]> }) => {
    const out: Record<number, LatLon> = {};
    for (const [id, c] of Object.entries(fx.stopCoords)) out[Number(id)] = { lat: c[0]!, lon: c[1]! };
    return out;
  };
  const pinkRing = buildRing("pink", pink.path as [number, number][], pink.stops as number[], coordsOf(pink as never))!;

  it("gives Pink the sixteen occurrences its twelve-stop list names once", () => {
    expect(pinkRing).not.toBeNull();
    expect(pinkRing.repaired).toBe(true);
    expect(pinkRing.bridged).toBe(false);
    expect(pinkRing.N).toBe(16);
    expect(pinkRing.stops).toEqual([149, 72, 43, 44, 60, 109, 110, 124, 123, 125, 123, 124, 110, 109, 59, 46]);
  });

  it("offers twelve service calls without removing the four intermediate drive passes", () => {
    expect(pinkRing.serviceEligible).toEqual([
      true, true, true, true, true, true, false, false,
      true, true, false, true, true, false, true, true,
    ]);
    expect(pinkRing.stops.filter((_, i) => pinkRing.serviceEligible[i])).toEqual(pink.stops);
    expect(pinkRing.stops[6]).toBe(110);
    expect(pinkRing.serviceEligible[6]).toBe(false);
    expect(pinkRing.stops[12]).toBe(110);
    expect(pinkRing.serviceEligible[12]).toBe(true);
    expect(pinkRing.legM).toHaveLength(16);
    expect(pinkRing.stopCell).toHaveLength(16);
    expect(pinkRing.pStop).toHaveLength(16);
  });

  it("splits the hop the model priced at a quarter of its real time", () => {
    // Published, 109 -> 123 is one 1,755 m leg that the calibrator could only
    // sample on the laps where the detector missed Quigley Outbound and VA
    // Entrance Outbound inside it: billed 55 s against a driven 240 s
    // (docs/route-bias.md §3). Repaired, that drive is its own hop.
    const legM = Array.from(pinkRing.legM).map(Math.round);
    expect(legM[5]).toBeLessThan(100);            // 109 -> 110, the twin
    expect(legM[6]).toBeGreaterThan(1_500);       // 110 -> 124, the drive
    expect(legM[7]).toBeLessThan(100);            // 124 -> 123, the twin
  });

  it("still draws the published line once and no more", () => {
    const loop = polylineMeters(pink.path as [number, number][]);
    expect(Math.abs(pinkRing.loopM - loop) / loop).toBeLessThan(0.005);
  });

  it("gives Purple its return call at West Haven station", () => {
    const ring = buildRing("purple", purple.path as [number, number][], purple.stops as number[], coordsOf(purple as never))!;
    expect(ring.repaired).toBe(true);
    expect(ring.N).toBe((purple.stops as number[]).length + 1);
    expect(ring.stops.slice(-3)).toEqual([26, 127, 72]);
    expect(ring.serviceEligible).toEqual(new Array(ring.N).fill(true));
    expect(ring.stops.filter((id, i) => id === 127 && ring.serviceEligible[i])).toHaveLength(2);
    for (const id of new Set(purple.stops)) {
      const publishedCalls = purple.stops.filter((sid) => sid === id).length;
      expect(ring.order.filter((p, i) => purple.stops[p] === id && ring.serviceEligible[i]).length)
        .toBeGreaterThanOrEqual(publishedCalls);
    }
    const loop = polylineMeters(purple.path as [number, number][]);
    expect(Math.abs(ring.loopM - loop) / loop).toBeLessThan(0.005);
  });
});

describe("a route whose published order its line supports is built exactly as before", () => {
  for (const routeId of Object.keys(others.routes)) {
    it(`route ${routeId} is untouched, cell for cell`, () => {
      const stops = others.routes[routeId]!.stops;
      const path = others.routes[routeId]!.path;
      const ring = buildRing(`r${routeId}`, path, stops, otherCoords)!;
      expect(ring).not.toBeNull();
      expect(ring.repaired).toBe(false);
      expect(Array.from(ring.order)).toEqual(stops.map((_, i) => i));
      expect(ring.stops).toEqual(stops);
      expect(ring.serviceEligible).toEqual(new Array(stops.length).fill(true));

      // The trigger is the evidence and only the evidence: with no bridged leg
      // and no fold, the ring's legs are the tracer's own, so the cells are
      // where they always were.
      const coords = stops.map((id) => otherCoords[id]!);
      const legs = traceStopLegs(path, [...coords, coords[0]!]);
      expect(legs.some((l) => l.bridged)).toBe(false);
      const traced = legs.map((l) => polylineMeters(l.slice));
      expect(Array.from(ring.legM).map((m) => Math.round(m))).toEqual(traced.map((m) => Math.round(Math.max(1, m))));
    });
  }
});

it("keeps service eligibility attached to passes on a generic folded route", () => {
  const south = 41.29, north = 41.2902, west = -72.99, east = -72.95;
  const path: [number, number][] = [
    [south, west], [south, east], [north, east], [north, west], [south, west],
  ];
  // Start at the inbound twin, so the sorted/rotated traversal begins with
  // that marker's unserved outbound pass rather than its published call.
  const stops = [1004, 1001, 1002, 1003];
  const coords: Record<number, LatLon> = {
    1001: { lat: 41.2901, lon: -72.9890 },
    1002: { lat: south, lon: -72.9700 },
    1003: { lat: 41.2901, lon: -72.9505 },
    1004: { lat: north, lon: -72.9695 },
  };
  const ring = buildRing("generic-fold", path, stops, coords)!;
  expect(ring.repaired).toBe(true);
  expect(ring.stops).toEqual([1004, 1003, 1004, 1002, 1001, 1002]);
  expect(ring.serviceEligible).toEqual([false, true, true, false, true, true]);
  expect(ring.order.filter((_, i) => ring.serviceEligible[i]).sort((a, b) => a - b)).toEqual([0, 1, 2, 3]);
  expect(ring.N).toBe(6);
  expect(ring.legM).toHaveLength(6);
});
