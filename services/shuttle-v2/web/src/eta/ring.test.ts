import { describe, expect, it } from "vitest";

import green from "../__fixtures__/green-published-order.json";
import pink from "../__fixtures__/pink-published-order.json";
import purple from "../__fixtures__/purple-published-order.json";
import incidents from "../__fixtures__/anchor-incidents.json";
import { distanceToSegmentM, haversineMeters, polylineMeters, traceStopLegs, type LatLon } from "../geo";
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
  });

  it("lays its cells on the published line and nowhere else", () => {
    // The legs of a repaired ring are slices of the published polyline, so
    // they sum to it. The bridged ring did not: it drew 36,270 m of a 29,086 m
    // line, 7 km of that straight through West Haven.
    const loop = polylineMeters(greenPath);
    expect(Math.abs(ring.loopM - loop) / loop).toBeLessThan(0.005);
  });

  it("gives Building 800's outbound occurrence a STANDING point at the stop", () => {
    // The published line serves Building 800's kerb on the RETURN pass only:
    // its outbound pass never comes within 99 m, so occurrence 13's cell is 99 m
    // from the stop and no cell of the ring was inside that marker's zone — the
    // ring had no state for "standing at Building 800 outbound", and a bus
    // parking there was relocated five legs onto the RETURN occurrence of the
    // same stop id, 92.6 m away at the same kerb.
    expect(ring.unreached).toEqual([13]);
    expect(ring.stops[13]).toBe(25);
    const cell = ring.stopCell[13]!;
    // The STANDING point is the kerb ...
    expect(haversineMeters({ lat: ring.standLat[cell]!, lon: ring.standLon[cell]! }, greenCoords[25]!)).toBeLessThan(1);
    // ... and the cell itself stays on the line, 99 m away, because a bus that
    // is DRIVING is on the road. Moving the cell outright cost 413 moving pairs
    // on the gps-replay; see docs/eta-ring-posterior.md.
    expect(haversineMeters({ lat: ring.lat[cell]!, lon: ring.lon[cell]! }, greenCoords[25]!)).toBeGreaterThan(90);
    // And the stand is a state now: some cell claims that occurrence.
    expect(Array.from(ring.nearStop)).toContain(13);
  });

  it("keeps every cell on the published line, and every other stand point on its cell", () => {
    const offLine = (c: number) => {
      const here = { lat: ring.lat[c]!, lon: ring.lon[c]! };
      let best = Infinity;
      for (let k = 1; k < greenPath.length; k++) {
        best = Math.min(best, distanceToSegmentM(here,
          { lat: greenPath[k - 1]![0], lon: greenPath[k - 1]![1] },
          { lat: greenPath[k]![0], lon: greenPath[k]![1] }));
      }
      return best;
    };
    const moved: number[] = [];
    for (let c = 0; c < ring.C; c++) {
      // Every cell, including occurrence 13's, is a point on the line.
      expect(offLine(c), `cell ${c} left the published line`).toBeLessThan(1);
      if (ring.standLat[c] !== ring.lat[c] || ring.standLon[c] !== ring.lon[c]) moved.push(c);
    }
    // Exactly one cell's standing point differs from its cell, and it is the one.
    expect(moved).toEqual([ring.stopCell[13]!]);
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
      // The stand-point correction is evidence-triggered too: these lines reach
      // every stop they serve, so not one standing point leaves its cell.
      expect(ring.unreached).toEqual([]);
      expect(Array.from(ring.standLat)).toEqual(Array.from(ring.lat));
      expect(Array.from(ring.standLon)).toEqual(Array.from(ring.lon));

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
