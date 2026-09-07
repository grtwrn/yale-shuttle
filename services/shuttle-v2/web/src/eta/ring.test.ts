import { describe, expect, it } from "vitest";

import green from "../__fixtures__/green-published-order.json";
import incidents from "../__fixtures__/anchor-incidents.json";
import { polylineMeters, traceStopLegs, type LatLon } from "../geo";
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

      // The trigger is the bridge and only the bridge: with none, the ring's
      // legs are the tracer's own, so the cells are where they always were.
      const coords = stops.map((id) => otherCoords[id]!);
      const legs = traceStopLegs(path, [...coords, coords[0]!]);
      expect(legs.some((l) => l.bridged)).toBe(false);
      const traced = legs.map((l) => polylineMeters(l.slice));
      expect(Array.from(ring.legM).map((m) => Math.round(m))).toEqual(traced.map((m) => Math.round(Math.max(1, m))));
    });
  }
});
