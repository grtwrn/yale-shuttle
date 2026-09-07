import { describe, expect, it } from "vitest";

import green from "../../web/src/__fixtures__/green-published-order.json";
import incidents from "../../web/src/__fixtures__/anchor-incidents.json";

import { MAX_STOP_OFFSET_M, alignStopsToPath, legSlicesInOrder, passesAt, repairedStopOrder } from "./alignStops.js";
import { polylineMeters, traceStopLegs, type LatLon } from "./legs.js";

const greenStops = green.stops as number[];
const greenPath = green.path as [number, number][];
const greenCoords: LatLon[] = greenStops.map((id) => {
  const c = (green.stopCoords as unknown as Record<string, number[]>)[String(id)]!;
  return { lat: c[0]!, lon: c[1]! };
});
const loopM = polylineMeters(greenPath);

const others = incidents as unknown as {
  routes: Record<string, { stops: number[]; path: [number, number][] }>;
  stopCoords: Record<string, { lat: number; lon: number }>;
};
function coordsOf(routeId: string): LatLon[] {
  return others.routes[routeId]!.stops.map((id) => others.stopCoords[String(id)]!);
}

describe("the evidence: Green's published order does not describe Green's published line", () => {
  it("bridges three legs when the tracer is asked to walk it", () => {
    const legs = traceStopLegs(greenPath, [...greenCoords, greenCoords[0]!]);
    expect(legs.filter((l) => l.bridged).length).toBe(3);
  });

  it("orders the station one slot before the pass the line makes at it", () => {
    const aligned = alignStopsToPath(greenPath, greenCoords)!;
    expect(aligned).not.toBeNull();
    // One move, and it is the transposition of upstream's 18 (West Haven
    // Train Station) and 19 (Building 900).
    expect(aligned.skips).toBe(1);
    // Plus the pass the list never named: the station on the way OUT, which
    // the line makes 9.4 km into the 11.7 km hop from Bradley (S).
    expect(aligned.added).toBe(1);
    expect(aligned.order).toEqual(green.repairedOrder);
  });

  it("puts every stop on a pass the line really makes", () => {
    const aligned = alignStopsToPath(greenPath, greenCoords)!;
    const worst = Math.max(...aligned.passes.map((p) => p.d));
    // Building 800's outbound pass, the furthest legitimate offset on any of
    // the fifteen published lines. Well inside the cap, and two orders of
    // magnitude short of the 2,129 m "pass" the cap exists to refuse.
    expect(worst).toBeLessThan(100);
    expect(worst).toBeLessThan(MAX_STOP_OFFSET_M);
  });

  it("draws the whole published line exactly once", () => {
    const aligned = alignStopsToPath(greenPath, greenCoords)!;
    const drawn = aligned.legs.reduce((a, l) => a + polylineMeters(l), 0);
    expect(Math.abs(drawn - loopM) / loopM).toBeLessThan(0.005);
    // And nothing is left to bridge: the legs of a monotone assignment are
    // slices of the line, never chords through the buildings.
    expect(aligned.legs.length).toBe(aligned.order.length);
    expect(aligned.order.length).toBe(greenStops.length + 1);
  });

  it("leaves the repaired order traceable, so legM comes off the road", () => {
    const repaired = repairedStopOrder(greenPath, greenCoords)!;
    const reordered = repaired.map((i) => greenCoords[i]!);
    const slices = legSlicesInOrder(greenPath, reordered)!;
    expect(slices).not.toBeNull();
    const drawn = slices.reduce((a, l) => a + polylineMeters(l), 0);
    expect(Math.abs(drawn - loopM) / loopM).toBeLessThan(0.005);
    // The two highway runs are now hops the detector can bill: Bradley (S) to
    // the station, and the station back to Bradley (N).
    const byM = slices.map((s) => Math.round(polylineMeters(s)));
    expect(byM.filter((m) => m > 5_000).length).toBe(2);
    expect(Math.max(...byM)).toBeLessThan(10_000);
  });

  it("gives the station the outbound pass the list never named", () => {
    const order = repairedStopOrder(greenPath, greenCoords)!;
    const station = greenStops.indexOf(127);
    expect(order.filter((i) => i === station).length).toBe(2);
    // Once between Bradley (S) and Building 900 on the way out, once between
    // Building 900 and Bradley (N) on the way back.
    const ids = order.map((i) => greenStops[i]!);
    expect(ids.slice(10, 13)).toEqual([81, 127, 26]);
    expect(ids.slice(19, 22)).toEqual([26, 127, 80]);
  });
});

describe("a route whose published order its line supports is never touched", () => {
  for (const routeId of Object.keys(others.routes)) {
    it(`route ${routeId} traces, so there is nothing to repair`, () => {
      const path = others.routes[routeId]!.path;
      const coords = coordsOf(routeId);
      const legs = traceStopLegs(path, [...coords, coords[0]!]);
      expect(legs.some((l) => l.bridged)).toBe(false);
      expect(alignStopsToPath(path, coords)).toBeNull();
      expect(repairedStopOrder(path, coords)).toBeNull();
    });
  }
});

describe("the mechanism, on geometry small enough to check by hand", () => {
  // A 400 m square, four stops, one on each side.
  const square: [number, number][] = [
    [41.3000, -72.9000], [41.3000, -72.8952], [41.2964, -72.8952], [41.2964, -72.9000], [41.3000, -72.9000],
  ];
  const north = { lat: 41.3001, lon: -72.8976 };
  const east = { lat: 41.2982, lon: -72.8951 };
  const south = { lat: 41.2963, lon: -72.8976 };
  const west = { lat: 41.2982, lon: -72.9001 };

  it("returns null when the stops are already in travel order", () => {
    expect(alignStopsToPath(square, [north, east, south, west])).toBeNull();
  });

  it("repairs a transposed pair back into travel order", () => {
    // The list says north, SOUTH, EAST, west; the line drives north, east,
    // south, west.
    const aligned = alignStopsToPath(square, [north, south, east, west])!;
    expect(aligned).not.toBeNull();
    expect(aligned.skips).toBeGreaterThan(0);
    expect(aligned.order).toEqual([0, 2, 1, 3]);
  });

  it("finds one pass per side and no more", () => {
    const cum = [0];
    for (let i = 1; i < square.length; i++) cum.push(i);
    // passesAt needs the real cumulative metres; rebuild them properly.
    const segs: [number, number][][] = [];
    for (let i = 0; i < square.length - 1; i++) segs.push([square[i]!, square[i + 1]!]);
    const cm = [0];
    for (const s of segs) cm.push(cm[cm.length - 1]! + polylineMeters(s));
    for (const stop of [north, east, south, west]) {
      expect(passesAt(segs, cm, stop).length).toBe(1);
    }
  });
});

describe("a bridged leg is the trigger, not the licence", () => {
  it("declines an out-and-back whose return leg bridges but whose order is right", () => {
    // The app-test rectangle: stops 1 (bottom-left corner), 2 (bottom middle),
    // 3 (top middle), run 1 -> 2 -> 3 -> 2. The last hop 2 -> 1 covers 78% of
    // this small loop, so the tracer bridges it — and the published order is
    // still exactly right. The line passes stop 2 ONCE, so a repair could only
    // stack both of its occurrences on that pass, i.e. a hop from a stop to
    // itself.
    const path: [number, number][] = [
      [41.31, -72.93], [41.31, -72.91], [41.312, -72.91], [41.312, -72.93],
    ];
    const a = { lat: 41.31, lon: -72.93 }, b = { lat: 41.31, lon: -72.92 }, c = { lat: 41.312, lon: -72.92 };
    const legs = traceStopLegs(path, [a, b, c, b, a]);
    expect(legs.some((l) => l.bridged)).toBe(true);
    expect(alignStopsToPath(path, [a, b, c, b])).toBeNull();
    expect(repairedStopOrder(path, [a, b, c, b])).toBeNull();
  });

  it("declines a line published counter to its stop list", () => {
    // Eight stops evenly round a 500 m circle, and a six-point polyline of the
    // same circle drawn the OTHER way — the "whole route painted solid" defect
    // a rider once reported. Every leg bridges, but here the LIST is right and
    // the LINE is wrong: reversing the list would run the estimator round the
    // route backwards, so the repair refuses and derivePath.ts is the remedy.
    const centre = { lat: 41.31, lon: -72.93 };
    const rLat = 500 / 111_320, rLon = 500 / (111_320 * Math.cos((centre.lat * Math.PI) / 180));
    const on = (frac: number) => ({
      lat: centre.lat + Math.cos(frac * 2 * Math.PI) * rLat,
      lon: centre.lon + Math.sin(frac * 2 * Math.PI) * rLon,
    });
    const stops = Array.from({ length: 8 }, (_, i) => on(i / 8));
    const backwards = Array.from({ length: 6 }, (_, i) => {
      const p = on(i / 6);
      return [p.lat, p.lon] as [number, number];
    }).reverse();
    expect(traceStopLegs(backwards, [...stops, stops[0]!]).some((l) => l.bridged)).toBe(true);
    expect(alignStopsToPath(backwards, stops)).toBeNull();
  });
});

describe("the file the two builds share", () => {
  it("imports nothing, so the web image needs only this one file", async () => {
    // `web/src/eta/ring.ts` reaches across to this module, and the Docker web
    // stage copies exactly `src/network/alignStops.ts` (plus src/schema). An
    // import added here would build locally and break the image, which is the
    // failure mode this test exists to stop.
    const fs = await import("node:fs");
    const url = await import("node:url");
    const here = url.fileURLToPath(new URL("./alignStops.ts", import.meta.url));
    const src = fs.readFileSync(here, "utf8");
    expect(src.match(/^\s*import[\s{*]/gm)).toBeNull();
  });
});
