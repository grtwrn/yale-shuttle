import { describe, expect, it } from "vitest";

import incidents from "../../web/src/__fixtures__/anchor-incidents.json";
import stopsFixture from "../server/__fixtures__/stops.json";

import { haversineMeters, polylineMeters, routeLegMeters, traceStopLegs, type LatLon, type TracedLeg } from "./legs.js";

// The client's own copy. Loaded through a non-literal specifier so the
// backend's tsc (noUncheckedIndexedAccess) does not type-check web/src/geo.ts,
// which is compiled under web/tsconfig.json; vitest resolves it at run time.
const CLIENT_GEO = "../../web/src/geo.ts";
type ClientGeo = {
  haversineMeters(a: LatLon, b: LatLon): number;
  polylineMeters(pts: readonly [number, number][]): number;
  traceStopLegs(path: [number, number][] | undefined, stops: LatLon[] | undefined): TracedLeg[];
};
const client = (await import(CLIENT_GEO)) as ClientGeo;

// Red's published line and stop sequence, as captured from production for the
// anchor incidents, with the stops' coordinates from the geocode fixture.
const red = (incidents as unknown as { routes: Record<string, { stops: number[]; path: [number, number][] }> }).routes["3"]!;
const coordOf = new Map<number, LatLon>();
for (const s of stopsFixture as Array<{ id: number; lat: number; lon: number }>) coordOf.set(s.id, { lat: s.lat, lon: s.lon });
const redStops: LatLon[] = red.stops.map((id) => {
  const c = coordOf.get(id);
  if (!c) throw new Error(`stop ${id} missing from stops.json`);
  return c;
});

describe("legs.ts mirrors web/src/geo.ts", () => {
  // The server prices pace per road metre and serves `legM`; the client cuts
  // the same leg into cells. Both must measure the same metres, so the copy
  // is pinned to the original output-for-output on a real route.
  it("traces Red's legs identically to the client's tracer", () => {
    const ring = [...redStops, redStops[0]!];
    const ours = traceStopLegs(red.path, ring);
    const theirs = client.traceStopLegs(red.path, ring);
    expect(ours.length).toBe(red.stops.length);
    expect(ours).toEqual(theirs);
    for (const [i, leg] of ours.entries()) {
      expect(polylineMeters(leg.slice)).toBe(client.polylineMeters(theirs[i]!.slice));
    }
  });

  it("measures distance exactly as the client does", () => {
    const a = redStops[0]!, b = redStops[1]!;
    expect(haversineMeters(a, b)).toBe(client.haversineMeters(a, b));
    expect(polylineMeters(red.path)).toBe(client.polylineMeters(red.path));
  });

  // Stops project onto the line a few metres from their pins, so a straight
  // hop can read marginally UNDER its chord; well under is a wrong trace.
  it("gives every hop of Red a road length no shorter than 90% of its chord, none bridged", () => {
    const m = routeLegMeters(red.path, redStops);
    expect(m).toHaveLength(red.stops.length);
    const n = red.stops.length;
    for (let i = 0; i < n; i++) {
      const chord = haversineMeters(redStops[i]!, redStops[(i + 1) % n]!);
      expect(m[i]).not.toBeNull();
      expect(m[i]!).toBeGreaterThanOrEqual(chord * 0.9);
    }
    // The hops sum to (about) one lap: the tracer walks the loop once.
    const total = m.reduce<number>((a, x) => a + (x ?? 0), 0);
    expect(Math.abs(total - polylineMeters(red.path)) / polylineMeters(red.path)).toBeLessThan(0.05);
  });
});

describe("routeLegMeters", () => {
  // A square block: the line goes round three sides between two stops on
  // adjacent corners — road ~3x the chord.
  const sq: [number, number][] = [
    [41.310, -72.930], [41.311, -72.930], [41.311, -72.929], [41.310, -72.929],
  ];
  it("returns road metres per hop of the closed loop, in sequence order", () => {
    const stops: LatLon[] = [
      { lat: 41.310, lon: -72.930 }, // corner 0
      { lat: 41.3105, lon: -72.930 }, // mid-side, before corner 1
      { lat: 41.311, lon: -72.929 }, // corner 2
    ];
    const m = routeLegMeters(sq, stops);
    expect(m).toHaveLength(3);
    const side = haversineMeters({ lat: 41.310, lon: -72.930 }, { lat: 41.311, lon: -72.930 });
    expect(m[0]!).toBeCloseTo(side / 2, 0);
    // corner 2 -> back to corner 0 runs two sides; the chord is one diagonal.
    expect(m[2]!).toBeGreaterThan(haversineMeters(stops[2]!, stops[0]!) * 1.3);
  });

  it("is all null without a usable path or with fewer than two stops", () => {
    expect(routeLegMeters(undefined, [{ lat: 1, lon: 1 }, { lat: 2, lon: 2 }])).toEqual([null, null]);
    expect(routeLegMeters(sq, [{ lat: 41.31, lon: -72.93 }])).toEqual([null]);
    expect(routeLegMeters([sq[0]!], [{ lat: 1, lon: 1 }, { lat: 2, lon: 2 }])).toEqual([null, null]);
  });
});
