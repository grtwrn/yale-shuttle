import { describe, expect, it } from "vitest";

import green from "../../web/src/__fixtures__/green-published-order.json";
import pink from "../../web/src/__fixtures__/pink-published-order.json";
import purple from "../../web/src/__fixtures__/purple-published-order.json";
import incidents from "../../web/src/__fixtures__/anchor-incidents.json";

import {
  FOLD_M, MAX_STOP_OFFSET_M, TWIN_LEG_M, TWIN_OFFSET_M,
  alignStopsToPath, alignmentWarranted, legSlicesInOrder, longestFoldMeters, passesAt, repairedStopOrder,
} from "./alignStops.js";
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

// ---------------------------------------------------------------------------
// The second defect: a list that traces and is still not the driven lap.
// ---------------------------------------------------------------------------

function fixtureCoords(fx: { stops: number[]; stopCoords: Record<string, number[]> }): LatLon[] {
  return fx.stops.map((id) => {
    const c = fx.stopCoords[String(id)]!;
    return { lat: c[0]!, lon: c[1]! };
  });
}

const pinkStops = pink.stops as number[];
const pinkPath = pink.path as [number, number][];
const pinkCoords = fixtureCoords(pink as never);
const purpleCoords = fixtureCoords(purple as never);

describe("the fold: which routes double back, measured on the published lines", () => {
  it("is a kilometre or more on an out-and-back and a corner on a plain loop", () => {
    // The gap this constant lives in. Plain loops (the fixtures the repair
    // must never touch): Blue Day, Red and Blue West.
    for (const routeId of Object.keys(others.routes)) {
      expect(longestFoldMeters(others.routes[routeId]!.path)).toBeLessThan(FOLD_M);
    }
    // Out-and-backs.
    expect(longestFoldMeters(pinkPath)).toBeGreaterThan(3_000);
    expect(longestFoldMeters(purple.path as [number, number][])).toBeGreaterThan(4_000);
    expect(longestFoldMeters(greenPath)).toBeGreaterThan(3_000);
  });

  it("is the trigger a route needs when nothing bridges", () => {
    expect(alignmentWarranted(pinkPath, false)).toBe(true);
    for (const routeId of Object.keys(others.routes)) {
      expect(alignmentWarranted(others.routes[routeId]!.path, false)).toBe(false);
      // A bridged leg is still a trigger on its own, fold or no fold.
      expect(alignmentWarranted(others.routes[routeId]!.path, true)).toBe(true);
    }
  });

  it("costs nothing on a line with no vertices to speak of", () => {
    expect(longestFoldMeters(undefined)).toBe(0);
    expect(longestFoldMeters([[41.3, -72.93]])).toBe(0);
  });
});

describe("Pink: twelve published stops for a lap of eighteen passes", () => {
  it("traces without a single bridge, which is why the Green trigger never saw it", () => {
    const legs = traceStopLegs(pinkPath, [...pinkCoords, pinkCoords[0]!]);
    expect(legs.length).toBe(pinkStops.length);
    expect(legs.some((l) => l.bridged)).toBe(false);
  });

  it("names each twin marker once where the line passes both twice", () => {
    const segs: [number, number][][] = [];
    for (let i = 0; i < pinkPath.length - 1; i++) segs.push([pinkPath[i]!, pinkPath[i + 1]!]);
    // Upstream publishes Pink's line closed, so there is no wrap to append.
    expect(polylineMeters([pinkPath[pinkPath.length - 1]!, pinkPath[0]!])).toBeLessThan(1);
    const cm = [0];
    for (const seg of segs) cm.push(cm[cm.length - 1]! + polylineMeters(seg));
    let passes = 0;
    for (const c of pinkCoords) passes += passesAt(segs, cm, c).length;
    expect(pinkStops.length).toBe(12);
    expect(passes).toBe(18);
  });

  it("adds four occurrences and moves none", () => {
    const aligned = alignStopsToPath(pinkPath, pinkCoords)!;
    expect(aligned).not.toBeNull();
    expect(aligned.skips).toBe(0);
    expect(aligned.added).toBe(4);
    expect(aligned.order).toEqual(pink.repairedOrder);
  });

  it("is the order the buses drive, pass for pass", () => {
    const ids = repairedStopOrder(pinkPath, pinkCoords)!.map((i) => pinkStops[i]!);
    // 862 laps of arrivals in the 9/4 snapshot reconstruct exactly this
    // (docs/route-bias.md §3): out past Quigley Inbound and Outbound, in at
    // the VA Entrance Outbound marker before the Inbound one, and the mirror
    // of it coming back.
    expect(ids).toEqual([149, 72, 43, 44, 60, 109, 110, 124, 123, 125, 123, 124, 110, 109, 59, 46]);
  });

  it("corrects the pair the line visits in the opposite order", () => {
    const ids = repairedStopOrder(pinkPath, pinkCoords)!.map((i) => pinkStops[i]!);
    // Published: 123 then 125 then 124. The bus reaches 124 BEFORE 123 on the
    // way in and 123 before 124 on the way out; both are now in the ring, in
    // the order the line makes them.
    expect(ids.slice(6, 12)).toEqual([110, 124, 123, 125, 123, 124]);
  });

  it("draws the loop once, so the legs are slices and not a second lap", () => {
    const aligned = alignStopsToPath(pinkPath, pinkCoords)!;
    const drawn = aligned.legs.reduce((a, l) => a + polylineMeters(l), 0);
    expect(drawn).toBeGreaterThan(polylineMeters(pinkPath) * 0.98);
    expect(drawn).toBeLessThan(polylineMeters(pinkPath) * 1.02);
  });
});

describe("Purple: the outbound station call, reached now that the trigger is wider", () => {
  it("adds the return West Haven pass and nothing else", () => {
    const aligned = alignStopsToPath(purple.path as [number, number][], purpleCoords)!;
    expect(aligned.skips).toBe(0);
    expect(aligned.added).toBe(1);
    expect(aligned.order).toEqual(purple.repairedOrder);
    const ids = aligned.order.map((i) => (purple.stops as number[])[i]!);
    expect(ids.slice(-3)).toEqual([26, 127, 72]);
  });
});

describe("what the twin rule refuses", () => {
  // A 3.4 km spur out and back along one road, its two carriageways 22 m
  // apart — Pink's shape, small enough to check by hand. The markers: FAR at
  // the near end, A beside the outbound carriageway and B beside the inbound
  // one 42 m further east (Quigley Inbound / Outbound), and APEX at the far
  // turn (the VA Hospital).
  const south = 41.29, north = 41.2902, west = -72.99, east = -72.95;
  const spur: [number, number][] = [
    [south, west], [south, east], [north, east], [north, west], [south, west],
  ];
  const far = { lat: 41.2901, lon: -72.9890 };
  const a = { lat: south, lon: -72.9700 };
  const b = { lat: north, lon: -72.9695 };
  const apex = { lat: 41.2901, lon: -72.9505 };
  // The list names each of the twins once, and puts one on each carriageway.
  const published = [far, a, apex, b];

  it("fires on the spur, and only where the line drives past a stop it does not name", () => {
    expect(longestFoldMeters(spur)).toBeGreaterThan(FOLD_M);
    const aligned = alignStopsToPath(spur, published)!;
    expect(aligned).not.toBeNull();
    expect(aligned.skips).toBe(0);
    // B's outbound pass and A's inbound one — the two the list left out.
    expect(aligned.added).toBe(2);
    expect(aligned.order).toEqual([0, 1, 3, 2, 3, 1]);
  });

  it("does not fire on the same stops when the line does not double back", () => {
    // The identical list on a plain rectangle whose sides are 400 m apart:
    // no fold, so the aligner is never asked and the ring is the published
    // one. This is the six downtown routes where the line passes College /
    // Wall (S) and (N) both ways and the list is right.
    const loop: [number, number][] = [
      [41.29, -72.99], [41.29, -72.95], [41.2936, -72.95], [41.2936, -72.99], [41.29, -72.99],
    ];
    expect(longestFoldMeters(loop)).toBeLessThan(FOLD_M);
    expect(alignmentWarranted(loop, false)).toBe(false);
  });

  it("never puts two occurrences of one stop side by side", () => {
    for (const [path, coords] of [
      [pinkPath, pinkCoords], [purple.path as [number, number][], purpleCoords], [greenPath, greenCoords],
      [spur, published],
    ] as const) {
      const order = repairedStopOrder(path, coords)!;
      expect(order).not.toBeNull();
      for (let k = 0; k < order.length; k++) {
        const x = coords[order[k]!]!, y = coords[order[(k + 1) % order.length]!]!;
        expect(x.lat === y.lat && x.lon === y.lon).toBe(false);
      }
    }
  });

  it("never stacks two occurrences on one pass", () => {
    for (const [path, coords] of [
      [pinkPath, pinkCoords], [purple.path as [number, number][], purpleCoords], [greenPath, greenCoords],
      [spur, published],
    ] as const) {
      const at = alignStopsToPath(path, coords)!.passes.map((p) => p.m).sort((x, y) => x - y);
      for (let k = 1; k < at.length; k++) expect(at[k]! - at[k - 1]!).toBeGreaterThanOrEqual(1);
    }
  });

  it("declines a pass further from its marker than TWIN_OFFSET_M", () => {
    expect(TWIN_OFFSET_M).toBe(50);
    // A marker set back from the road by more than the bound: the line comes
    // near it twice, and neither approach is a call. This is Gold's Union
    // Station (170 m), Brown's State St (142 m) and Orange East's Nicoll /
    // Edwards (183 m) — the spurious minima MAX_STOP_OFFSET_M lets through.
    const setBack = { lat: south - (TWIN_OFFSET_M * 2) / 111_320, lon: -72.9600 };
    const aligned = alignStopsToPath(spur, [...published, setBack]);
    expect(aligned!.added).toBe(2);
    const back = aligned!.order.filter((i) => i === published.length).length;
    expect(back).toBe(1);
  });

  it("declines a leg shorter than TWIN_LEG_M", () => {
    expect(TWIN_LEG_M).toBe(300);
    // The same spur with one more published stop 130 m east of A. B's
    // outbound pass now sits inside a 130 m leg instead of a 1.6 km one, and
    // the rule leaves it alone — B keeps the single occurrence its list gave
    // it, on the return.
    const c = { lat: south, lon: -72.96845 };
    const order = alignStopsToPath(spur, [far, a, c, apex, b])!.order;
    expect(order.filter((i) => i === 4).length).toBe(1);
    expect(order.indexOf(4)).toBeGreaterThan(order.indexOf(3));
  });

  it("caps what may be added at half the published list", () => {
    expect(alignStopsToPath(pinkPath, pinkCoords)!.added / pinkStops.length).toBeLessThanOrEqual(0.5);
    // Four published stops on the outbound carriageway of the spur: the line
    // drives past three of them again on the way back, so the rule would want
    // to add three to a list of four. The budget refuses the whole repair
    // rather than take part of it.
    const outboundOnly = [
      { lat: south, lon: -72.985 }, { lat: south, lon: -72.975 }, { lat: south, lon: -72.965 }, apex,
    ];
    expect(alignStopsToPath(spur, outboundOnly)).toBeNull();
  });
});
