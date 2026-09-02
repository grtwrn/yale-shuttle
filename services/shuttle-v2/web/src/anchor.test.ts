import { afterEach, describe, expect, it } from "vitest";

import {
  ANCHOR_GPS_THRESHOLD_M, findRouteAnchor, isBusOnRoute, OFF_ROUTE_THRESHOLD_M,
  registerRoutePaths,
} from "./anchor";
import { haversineMeters } from "./geo";
import { at, routeStops, STOP, stopCoords } from "./__fixtures__/payload";

const blueWeekend = routeStops["4"]!;
const blueDay = routeStops["1"]!;

const IDX = {
  yorkChapel: blueWeekend.indexOf(STOP.yorkChapel),      // 21
  broadwayYork: blueWeekend.indexOf(STOP.broadwayYork),  // 22
  stopAndShop: blueWeekend.indexOf(STOP.stopAndShop),    // 23
  elmYork: blueWeekend.indexOf(STOP.elmYorkTyco),        // 24
};

/** Nudge a coordinate by roughly `m` metres north. */
const nudgeNorth = (c: { lat: number; lon: number }, m: number) =>
  ({ lat: c.lat + m / 111_000, lon: c.lon });

describe("the fixture really does contain the pathological geometry", () => {
  it("Broadway/York and Elm/York are ~23 m apart but two stops apart", () => {
    expect(IDX.broadwayYork).toBe(22);
    expect(IDX.elmYork).toBe(24);
    expect(IDX.elmYork - IDX.broadwayYork).toBe(2);
    const gap = haversineMeters(at(STOP.broadwayYork), at(STOP.elmYorkTyco));
    expect(gap).toBeGreaterThan(15);
    expect(gap).toBeLessThan(30);
    // Both sit comfortably inside the GPS threshold of each other, which is
    // exactly why at_stop_id cannot be trusted to disambiguate them.
    expect(gap).toBeLessThan(ANCHOR_GPS_THRESHOLD_M);
  });
});

describe("findRouteAnchor: at_stop_id refines, never overrides", () => {
  // Reports #37/#38 (and the ETA swing in #32): at_stop_id used to
  // short-circuit the whole GPS scan. A bus physically at Elm/York whose feed
  // still said "at Broadway/York" was relocated TWO STOPS BACKWARDS, throwing
  // the ETA a third of a loop.
  it("does not anchor backwards when at_stop_id disagrees with GPS", () => {
    const bus = {
      ...at(STOP.elmYorkTyco),
      last_stop_id: STOP.stopAndShop,
      at_stop_id: STOP.broadwayYork,
    };
    const idx = findRouteAnchor(bus, blueWeekend, stopCoords);
    expect(idx).not.toBe(IDX.broadwayYork);
    // The GPS scan's own answer stands.
    expect(idx).toBe(IDX.stopAndShop);
  });

  it("does not anchor backwards even with no last_stop_id hint", () => {
    const bus = { ...at(STOP.elmYorkTyco), at_stop_id: STOP.broadwayYork };
    const idx = findRouteAnchor(bus, blueWeekend, stopCoords);
    expect(idx).not.toBe(IDX.broadwayYork);
    expect(idx).toBeGreaterThanOrEqual(IDX.stopAndShop);
  });

  // Report #27's fix, which the refinement must preserve: the segment scan
  // legitimately lags one stop behind at a shared segment endpoint, and
  // at_stop_id is the fresher signal there.
  it("still accepts at_stop_id exactly one stop ahead of the GPS anchor", () => {
    const bus = {
      ...at(STOP.broadwayYork),
      last_stop_id: STOP.yorkChapel,
      at_stop_id: STOP.broadwayYork,
    };
    // Without the hint the scan anchors on the segment ENDING at Broadway/York.
    const withoutHint = findRouteAnchor(
      { ...at(STOP.broadwayYork), last_stop_id: STOP.yorkChapel },
      blueWeekend, stopCoords,
    );
    expect(withoutHint).toBe(IDX.yorkChapel);
    // With it, the bus is correctly advanced by exactly one.
    expect(findRouteAnchor(bus, blueWeekend, stopCoords)).toBe(IDX.broadwayYork);
  });

  it("agrees with at_stop_id when GPS already points at the same stop", () => {
    const bus = { ...at(STOP.elmYorkTyco), at_stop_id: STOP.elmYorkTyco };
    expect(findRouteAnchor(bus, blueWeekend, stopCoords)).toBe(IDX.elmYork);
  });

  it("ignores at_stop_id when the bus is nowhere near that stop", () => {
    // Bus is at Phelps Gate; the feed claims Union Station, ~1.2 km away.
    const gpsOnly = findRouteAnchor(at(STOP.phelpsGate ?? 98), blueWeekend, stopCoords);
    const withBadHint = findRouteAnchor(
      { ...at(98), at_stop_id: 122 }, blueWeekend, stopCoords,
    );
    expect(haversineMeters(at(98), at(122))).toBeGreaterThan(ANCHOR_GPS_THRESHOLD_M);
    expect(withBadHint).toBe(gpsOnly);
  });

  it("ignores an at_stop_id that isn't on this route", () => {
    const gpsOnly = findRouteAnchor(at(STOP.elmYorkTyco), blueWeekend, stopCoords);
    const withOffRouteHint = findRouteAnchor(
      { ...at(STOP.elmYorkTyco), at_stop_id: STOP.peabody }, blueWeekend, stopCoords,
    );
    expect(blueWeekend).not.toContain(STOP.peabody);
    expect(withOffRouteHint).toBe(gpsOnly);
  });
});

describe("findRouteAnchor: GPS scan", () => {
  it("uses last_stop_id only to break ties among GPS candidates", () => {
    // Blue Day passes College/Wall twice — (S) at idx 18 and (N) at idx 28.
    const sIdx = blueDay.indexOf(42);
    const nIdx = blueDay.indexOf(41);
    expect(sIdx).toBeGreaterThanOrEqual(0);
    expect(nIdx).toBeGreaterThan(sIdx);
    // A bus sitting between them with a fresh southbound last_stop_id should
    // pick the leg that follows that stop, not the far one.
    const fromSouth = findRouteAnchor(
      { ...at(42), last_stop_id: 118 }, blueDay, stopCoords,
    );
    expect(fromSouth).toBeGreaterThanOrEqual(blueDay.indexOf(118));
    expect(fromSouth).toBeLessThanOrEqual(sIdx + 1);
  });

  it("falls back to last_stop_id when there is no GPS at all", () => {
    const idx = findRouteAnchor(
      { lat: 0, lon: 0, last_stop_id: STOP.elmYorkTyco }, blueWeekend, stopCoords,
    );
    expect(idx).toBe(IDX.elmYork);
  });

  it("returns 0 with neither GPS nor a usable last_stop_id", () => {
    expect(findRouteAnchor({ lat: 0, lon: 0 }, blueWeekend, stopCoords)).toBe(0);
    expect(findRouteAnchor({ lat: 0, lon: 0, last_stop_id: 99_999 }, blueWeekend, stopCoords)).toBe(0);
  });

  it("returns -1 for an empty stop list", () => {
    expect(findRouteAnchor(at(STOP.elmYorkTyco), [], stopCoords)).toBe(-1);
  });

  it("still produces an anchor for a bus far off the route", () => {
    // 5 km north of everything — no segment is within threshold, so the
    // globally-nearest one is used rather than crashing downstream code.
    const idx = findRouteAnchor(nudgeNorth(at(STOP.elmYorkTyco), 5_000), blueWeekend, stopCoords);
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(idx).toBeLessThan(blueWeekend.length);
  });

  it("is unmoved by GPS jitter perpendicular to the segment", () => {
    const base = { ...at(STOP.phelpsGate), last_stop_id: 42 };
    const anchor = findRouteAnchor(base, blueWeekend, stopCoords);
    for (const m of [-30, -10, 10, 30]) {
      expect(findRouteAnchor({ ...nudgeNorth(base, m), last_stop_id: 42 }, blueWeekend, stopCoords))
        .toBe(anchor);
    }
  });
});

describe("isBusOnRoute", () => {
  it("accepts a bus sitting on the route", () => {
    expect(isBusOnRoute(at(STOP.elmYorkTyco), blueWeekend, stopCoords)).toBe(true);
  });

  it("rejects a depot ghost far from every stop", () => {
    // ~2 km north, the Hamden-yard case that produced phantom arrivals.
    const parked = nudgeNorth(at(STOP.elmYorkTyco), 2_000);
    expect(isBusOnRoute(parked, blueWeekend, stopCoords)).toBe(false);
  });

  it("tolerates drift up to the threshold", () => {
    const near = nudgeNorth(at(STOP.elmYorkTyco), OFF_ROUTE_THRESHOLD_M - 50);
    const far = nudgeNorth(at(STOP.elmYorkTyco), OFF_ROUTE_THRESHOLD_M + 50);
    expect(isBusOnRoute(near, blueWeekend, stopCoords)).toBe(true);
    expect(isBusOnRoute(far, blueWeekend, stopCoords)).toBe(false);
  });

  it("does not filter a bus with no GPS", () => {
    expect(isBusOnRoute({ lat: 0, lon: 0 }, blueWeekend, stopCoords)).toBe(true);
  });
});

describe("isBusOnRoute measures against the road polyline when one is registered", () => {
  // Purple's Building 900 → LEPH leg is 6.7 km with no stop in between: a
  // bus honestly on the highway sits > 500 m from every stop for half its
  // lap. Model that with a two-stop route and a path that detours 3 km out.
  const a = at(STOP.elmYorkTyco);
  const far = { lat: a.lat + 0.03, lon: a.lon + 0.03 }; // ~4.4 km away
  const apex = { lat: a.lat + 0.03, lon: a.lon };       // 3.3 km north of `a`
  const coords = { 1: a, 2: far };
  const stops = [1, 2];
  const path: [number, number][] = [[a.lat, a.lon], [apex.lat, apex.lon], [far.lat, far.lon]];
  const onHighway = { lat: a.lat + 0.015, lon: a.lon, route_id: 10 }; // halfway up the first leg

  afterEach(() => registerRoutePaths(null));

  it("keeps a bus on a long stopless leg that the stop test would drop", () => {
    expect(isBusOnRoute(onHighway, stops, coords)).toBe(false); // the old behaviour
    registerRoutePaths({ "10": path });
    expect(isBusOnRoute(onHighway, stops, coords)).toBe(true);
  });

  it("still rejects a depot ghost far from the polyline", () => {
    registerRoutePaths({ "10": path });
    const ghost = { lat: a.lat + 0.015, lon: a.lon - 0.03, route_id: 10 }; // 2.5 km west of the leg
    expect(isBusOnRoute(ghost, stops, coords)).toBe(false);
  });

  it("falls back to the stop test for a route with no registered path", () => {
    registerRoutePaths({ "10": path });
    expect(isBusOnRoute({ ...onHighway, route_id: 3 }, stops, coords)).toBe(false);
    expect(isBusOnRoute({ ...a, route_id: 3 }, stops, coords)).toBe(true);
  });
});
