import { describe, expect, it } from "vitest";

import { type AnchorStore } from "./eta";
import { computeUpcomingArrivals } from "./arrivals";
import { haversineMeters } from "./geo";
import type { LatLon } from "./geo";
import { anchorIndexOnList, anchorKeyFor, resolveAnchorIndex } from "./liveAnchor";
import type { RouteListConfig } from "./routes";
import {
  at, BLUE_WEEKEND, dwellTimes, makeBus, routeStops, segmentTimes, STOP, stopCoords,
} from "./__fixtures__/payload";

const blueWeekend = routeStops[BLUE_WEEKEND.routeId]!;
const BW: RouteListConfig = {
  routeIds: [BLUE_WEEKEND.routeId],
  busRouteIds: [BLUE_WEEKEND.busRouteId],
  label: BLUE_WEEKEND.label,
  color: "#42A5F5",
};

const T0 = 1_700_000_000_000;
const store = (): AnchorStore => new Map();

// The de-duplicated stop list every render site in TransitMap.tsx builds for
// itself. On a route with no repeats it is the canonical list, element for
// element; on Green and Purple it is shorter.
function dedupe(stops: number[]): number[] {
  const seen = new Set<number>();
  const out: number[] = [];
  for (const sid of stops) if (!seen.has(sid)) { seen.add(sid); out.push(sid); }
  return out;
}

describe("a storeless caller keeps nothing", () => {
  // The replay harnesses and every pure test depend on this: no store, no
  // memory. (Until 2026-09-06 the same tests pinned the storeless answer to
  // the retired `findRouteAnchor`; the answer is the ring belief's lead leg
  // now, built from the fix alone.)
  it("answers every stop of the route without a store", () => {
    for (let i = 0; i < blueWeekend.length; i++) {
      const bus = { ...at(blueWeekend[i]!), last_stop_id: blueWeekend[i]!, route_id: BLUE_WEEKEND.busRouteId };
      const idx = resolveAnchorIndex(bus, blueWeekend, stopCoords, "k", T0);
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThan(blueWeekend.length);
      expect(resolveAnchorIndex(bus, blueWeekend, stopCoords, "k", T0, undefined)).toBe(idx);
    }
  });

  it("nothing is written to a store that was not passed", () => {
    const s = store();
    const bus = { ...at(STOP.broadwayYork), route_id: BLUE_WEEKEND.busRouteId };
    resolveAnchorIndex(bus, blueWeekend, stopCoords, "Blue Weekend|#101", T0);
    expect(s.size).toBe(0);
  });

  it("a route with no stops has no anchor", () => {
    const s = store();
    const bus = { ...at(STOP.broadwayYork), route_id: BLUE_WEEKEND.busRouteId };
    expect(resolveAnchorIndex(bus, [], stopCoords, "k", T0, s)).toBe(-1);
    expect(resolveAnchorIndex(bus, [], stopCoords, "k", T0)).toBe(-1);
  });
});

describe("one bus, one poll, one index", () => {
  // The bug: five render sites in TransitMap.tsx called findRouteAnchor with no
  // store, so the "N stops away" line was free to disagree with the countdown
  // beside it. Broadway/York and Elm/York are 22.7 m apart and TWO stops apart
  // in the sequence, so a twitch smaller than a bus flips the stateless anchor
  // 21 <-> 23 — the operator watched the column read 3 / 4 / 4 / 2 / 4 while
  // the ETA held still.
  const A = at(STOP.broadwayYork);
  const B = at(STOP.elmYorkTyco);
  const bus = (c: LatLon, t: number) => ({
    ...makeBus({ route_id: BLUE_WEEKEND.busRouteId, lat: c.lat, lon: c.lon, last_stop_id: STOP.yorkChapel }),
    _t: t,
  });

  it("the fixture really is the pathology: a sub-bus-length twitch, two slots", () => {
    // 22.7 m apart, two slots apart in the sequence. A stateless nearest-leg
    // answer (the retired `findRouteAnchor`) read 21 at A and 23 at B, so it
    // flapped 21 / 23 / 21 / 23 on a twitch smaller than a bus.
    expect(haversineMeters(A, B)).toBeLessThan(30);
    expect(blueWeekend.indexOf(STOP.broadwayYork)).toBe(22);
    expect(blueWeekend.indexOf(STOP.elmYorkTyco)).toBe(24);
  });

  it("against one shared store, it does not flap", () => {
    const s = store();
    const seen = [A, B, A, B, A].map((c, i) =>
      anchorIndexOnList(bus(c, i), BW, routeStops, stopCoords, dedupe(blueWeekend), T0 + i * 5000, s),
    );
    expect(new Set(seen).size).toBe(1);
    // ...and it is the leg the bus is actually on, held across the twitch.
    expect(seen[0]).toBe(blueWeekend.indexOf(STOP.broadwayYork));
  });

  it("every render site in a poll gets the SAME index, arrivals included", () => {
    const s = store();
    // Poll 1 settles the anchor at Broadway/York.
    anchorIndexOnList(bus(A, 0), BW, routeStops, stopCoords, dedupe(blueWeekend), T0, s);
    // Poll 2: the fix twitches, and the five callers run in render order —
    // the overview map's approach line, the card's "stops away", the expanded
    // route's "N stops away", the ride list, the on-bus banner — with
    // computeUpcomingArrivals (the countdown) interleaved among them, all off
    // this one store.
    const now = T0 + 5000;
    const b = bus(B, 1);
    const answers: number[] = [];
    for (let call = 0; call < 5; call++) {
      answers.push(anchorIndexOnList(b, BW, routeStops, stopCoords, dedupe(blueWeekend), now, s));
      computeUpcomingArrivals(
        [STOP.collegeWallN], [b], routeStops, stopCoords, segmentTimes, now, dwellTimes, s,
      );
    }
    expect(new Set(answers).size).toBe(1);
    // And it is the held one, not the twitch's.
    expect(answers[0]).toBe(blueWeekend.indexOf(STOP.broadwayYork));
  });

  it("the countdown and the stops-away line read the same anchor", () => {
    // Not a rendering assertion — the point is that the index the display
    // helper hands back is the one left in the store that arrivals reads.
    const s = store();
    const key = anchorKeyFor(BW.label, "#101");
    const now = T0;
    const b = bus(A, 0);
    computeUpcomingArrivals(
      [STOP.collegeWallN], [b], routeStops, stopCoords, segmentTimes, now, dwellTimes, s,
    );
    const fromArrivals = resolveAnchorIndex(b, blueWeekend, stopCoords, key, now, s);
    expect(anchorIndexOnList(b, BW, routeStops, stopCoords, dedupe(blueWeekend), now, s))
      .toBe(fromArrivals);
  });
});

describe("the belief steps once per poll", () => {
  // Arrivals are computed several times per poll off one shared store. A step
  // per call would feed the filter observations that never happened — the
  // review's first finding — so a second call with the same payload and clock
  // is a query of the stored belief, not a step.
  const A = at(STOP.yorkChapel);
  const B = at(STOP.broadwayYork);
  const key = anchorKeyFor(BW.label, "#101");

  it("repeating a poll does not move the answer or the stored belief", () => {
    const s = store();
    const bus = (c: LatLon) =>
      makeBus({ route_id: BLUE_WEEKEND.busRouteId, lat: c.lat, lon: c.lon, last_stop_id: STOP.yorkChapel });
    resolveAnchorIndex(bus(A), blueWeekend, stopCoords, key, T0, s);
    const second = bus(B);
    const idx = resolveAnchorIndex(second, blueWeekend, stopCoords, key, T0 + 5000, s);
    const after = s.get(key)!.belief;
    // Four more callers this same poll, same payload object and clock.
    for (let i = 0; i < 4; i++) {
      expect(resolveAnchorIndex(second, blueWeekend, stopCoords, key, T0 + 5000, s)).toBe(idx);
    }
    expect(s.get(key)!.belief).toBe(after);
  });
});

describe("the index space is the store's, not the caller's", () => {
  // The out-and-back in miniature — the same fixture anchor.test.ts uses for
  // the fold. Canonical sequence [1,2,3,4,3,2] (six slots, stops 2 and 3 twice)
  // against the de-duplicated [1,2,3,4] a render site builds.
  const E = 1 / (111_000 * Math.cos((41.3 * Math.PI) / 180));
  const coords: Record<number, LatLon> = {
    1: { lat: 41.300, lon: -72.930 },
    2: { lat: 41.305, lon: -72.930 },
    3: { lat: 41.310, lon: -72.930 },
    4: { lat: 41.315, lon: -72.930 },
  };
  const fold: RouteListConfig = { routeIds: ["fold"], busRouteIds: [99], label: "Fold", color: "#000" };
  const rs = { fold: [1, 2, 3, 4, 3, 2] };
  const display = dedupe(rs.fold);
  const here = { lat: 41.3075, lon: -72.930 + 20 * E };

  it("the canonical list keeps the repeats the render list drops", () => {
    expect(rs.fold.length).toBe(6);
    expect(display).toEqual([1, 2, 3, 4]);
  });

  it("the store remembers the canonical slot while the caller gets its own", () => {
    const s = store();
    const key = anchorKeyFor("Fold", "#101");
    const bus = (c: LatLon) => makeBus({ route_id: 99, lat: c.lat, lon: c.lon });
    // Turned round at the far end and driving back: from stop 4 to a fix
    // between 3 and 2, which is canonical slot 4 — stop 3 on its SECOND pass.
    anchorIndexOnList(bus(coords[4]!), fold, rs, coords, display, T0, s);
    const idx = anchorIndexOnList(bus(here), fold, rs, coords, display, T0 + 5000, s);
    expect(resolveAnchorIndex(bus(here), rs.fold, coords, key, T0 + 5000, s)).toBe(4);
    expect(rs.fold[4]).toBe(3);
    // The render site's list has one slot for stop 3, and that is what it gets.
    expect(idx).toBe(display.indexOf(3));
    expect(idx).toBe(2);
  });

  it("a caller passing the canonical list gets the canonical index untouched", () => {
    const s = store();
    const bus = (c: LatLon) => makeBus({ route_id: 99, lat: c.lat, lon: c.lon });
    anchorIndexOnList(bus(coords[4]!), fold, rs, coords, rs.fold, T0, s);
    expect(anchorIndexOnList(bus(here), fold, rs, coords, rs.fold, T0 + 5000, s)).toBe(4);
  });

  it("an empty route has no anchor", () => {
    expect(anchorIndexOnList(
      makeBus({ route_id: 99, lat: here.lat, lon: here.lon }),
      { ...fold, routeIds: ["missing"] }, rs, coords, [], T0, store(),
    )).toBe(-1);
  });
});
