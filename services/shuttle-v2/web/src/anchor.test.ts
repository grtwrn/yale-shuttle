import { afterEach, describe, expect, it } from "vitest";

import {
  ANCHOR_GPS_THRESHOLD_M, ANCHOR_HEADING_TOLERANCE_DEG, findRouteAnchor, isBusOnRoute,
  OFF_ROUTE_THRESHOLD_M, registerRoutePaths,
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

describe("findRouteAnchor on an out-and-back with a highway: road legs and heading", () => {
  // A miniature West Campus route (Green/Purple shaped): a downtown hub, a
  // highway out to a campus spur that the bus drives out and back through
  // the same stops, and the highway home to the hub's twin stop 30 m away.
  //
  //   H ──highway (L-shaped road, far from its chord)──> W1 → W2 → W3 → W4
  //   H2 <──highway home (parallel carriageway, 35 m)── W1 ← W2 ← W3 ←┘
  //
  // Stop ids are repeated in the sequence exactly as routes 9 and 10 do.
  const H = { lat: 41.3000, lon: -72.9300 };
  const H2 = { lat: 41.3000, lon: -72.9304 };   // ~34 m west of H (Orange/Bradley N/S)
  const W1 = { lat: 41.2600, lon: -72.9870 };
  const W2 = { lat: 41.2580, lon: -72.9890 };
  const W3 = { lat: 41.2560, lon: -72.9900 };
  const W4 = { lat: 41.2558, lon: -72.9936 };
  const coords = { 1: H, 2: H2, 11: W1, 12: W2, 13: W3, 14: W4 };
  const stops = [1, 11, 12, 13, 14, 13, 12, 11, 2];
  const LEG = { out: 0, w1w2: 1, w2w3: 2, w3w4: 3, w4w3: 4, w3w2: 5, w2w1: 6, home: 7, h2h: 8 };
  // The highway runs south from the hub, then west to the campus: an L whose
  // corner is ~2.5 km from the straight line between H and W1. The way home
  // is the same L on a carriageway 35 m to the north/west.
  const C1 = { lat: 41.2600, lon: -72.9300 };
  const C2 = { lat: 41.2603, lon: -72.9304 };
  const pt = (c: { lat: number; lon: number }): [number, number] => [c.lat, c.lon];
  const path: [number, number][] = [
    pt(H), pt(C1), pt(W1), pt(W2), pt(W3), pt(W4), pt(W3), pt(W2), pt(W1),
    pt({ lat: W1.lat + 0.0003, lon: W1.lon }), pt(C2), pt(H2), pt(H),
  ];
  const ROUTE = 10;
  const onOutboundHighway = { lat: 41.2600, lon: -72.9600, route_id: ROUTE };   // E-W stretch, outbound carriageway
  const onHomewardHighway = { lat: 41.2603, lon: -72.9600, route_id: ROUTE };   // 33 m north, homeward carriageway

  afterEach(() => registerRoutePaths(null));

  it("the fixture really is the pathological shape", () => {
    expect(haversineMeters(H, H2)).toBeLessThan(40);
    // Mid-highway the bus is far from BOTH chords, so without road legs the
    // scan falls through to "globally nearest" and never consults last_stop_id.
    for (const b of [onOutboundHighway, onHomewardHighway]) {
      expect(haversineMeters(b, C1)).toBeGreaterThan(2_000);
      const idx = findRouteAnchor({ ...b, last_stop_id: 1 }, stops, coords);
      // no path registered: chord behaviour, which is the coin flip we are fixing
      expect([LEG.out, LEG.home]).toContain(idx);
    }
  });

  it("anchors a bus on the outbound highway to the outbound leg", () => {
    registerRoutePaths({ [ROUTE]: path });
    const bus = { ...onOutboundHighway, heading: 270, last_stop_id: 1 };
    expect(findRouteAnchor(bus, stops, coords)).toBe(LEG.out);
  });

  it("anchors a bus heading home to the return leg despite a stale last_stop_id from the way out", () => {
    // TransLoc refreshes last_stop_id only at timepoints: the bus still says
    // "last stop: hub" the whole way back. Forward order from the hub prefers
    // the outbound leg; the heading is what says otherwise.
    registerRoutePaths({ [ROUTE]: path });
    const bus = { ...onHomewardHighway, heading: 90, last_stop_id: 1 };
    expect(findRouteAnchor(bus, stops, coords)).toBe(LEG.home);
    // Same position, no heading: the stale hint wins, which is the measured
    // failure mode this test pins the fix against.
    expect(findRouteAnchor({ ...onHomewardHighway, last_stop_id: 1 }, stops, coords)).toBe(LEG.out);
  });

  it("anchors a bus on the return half of the spur to the return-leg occurrence", () => {
    registerRoutePaths({ [ROUTE]: path });
    // Three-quarters of the way from W3 back to W2, driving north-east. (At
    // the midpoint the leg just left is still within 150 m of the bus and the
    // scan's forward-order rule legitimately lags one leg — report #27.)
    const between = { lat: W3.lat + 0.75 * (W2.lat - W3.lat), lon: W3.lon + 0.75 * (W2.lon - W3.lon), route_id: ROUTE };
    const heading = 40;
    // Fresh hint (turnaround just passed) and stale hint (from the way out)
    // both land on the return leg.
    expect(findRouteAnchor({ ...between, heading, last_stop_id: 14 }, stops, coords)).toBe(LEG.w3w2);
    expect(findRouteAnchor({ ...between, heading, last_stop_id: 11 }, stops, coords)).toBe(LEG.w3w2);
  });

  it("anchors a bus on the outbound half of the spur to the outbound occurrence", () => {
    registerRoutePaths({ [ROUTE]: path });
    const between = { lat: W2.lat + 0.75 * (W3.lat - W2.lat), lon: W2.lon + 0.75 * (W3.lon - W2.lon), route_id: ROUTE };
    expect(findRouteAnchor({ ...between, heading: 220, last_stop_id: 11 }, stops, coords)).toBe(LEG.w2w3);
    // and with no path registered at all the chord scan gives the same answer
    registerRoutePaths(null);
    expect(findRouteAnchor({ ...between, heading: 220, last_stop_id: 11 }, stops, coords)).toBe(LEG.w2w3);
  });

  it("at_stop_id at a repeated stop never throws a returning bus back to the first occurrence", () => {
    // Dwelling at W1 on the way home: the feed says at_stop W1, last stop W2.
    // W1's FIRST occurrence is index 1 (outbound); accepting it would send the
    // bus round the spur again — the report #37/#38 guarantee in a new guise.
    registerRoutePaths({ [ROUTE]: path });
    const bus = { ...W1, route_id: ROUTE, heading: 45, last_stop_id: 12, at_stop_id: 11 };
    const idx = findRouteAnchor(bus, stops, coords);
    expect([LEG.w2w1, LEG.home]).toContain(idx);
    expect(idx).not.toBe(LEG.w1w2);
    expect(idx).not.toBe(LEG.out);
  });

  it("ignores the heading while the bus is at a stop", () => {
    // A dwelling bus reports whatever it last drove; the stop-side hints are
    // the fresh signal there. Outbound at W2 with a heading pointing home.
    registerRoutePaths({ [ROUTE]: path });
    const bus = { ...W2, route_id: ROUTE, heading: 45, last_stop_id: 11, at_stop_id: 12 };
    expect(findRouteAnchor(bus, stops, coords)).toBe(LEG.w1w2 + 1); // refined one ahead, onto W2 → W3
  });

  it("keeps the candidate set when every candidate runs against the heading", () => {
    // Triangle: A → B bears 0°, B → C bears ~135°; a bus at B with a heading
    // between 245° and 250° is > 110° from both. The filter must not leave the
    // scan with nothing — forward order from last_stop_id still decides.
    const A = { lat: 41.3000, lon: -72.9300 };
    const B = { lat: 41.3090, lon: -72.9300 };
    const Cc = { lat: 41.3000, lon: -72.9180 };
    const tri = { 1: A, 2: B, 3: Cc };
    const bus = { ...B, heading: 247, last_stop_id: 1 };
    expect(findRouteAnchor(bus, [1, 2, 3], tri)).toBe(0);
    expect(findRouteAnchor({ ...bus, last_stop_id: 2 }, [1, 2, 3], tri)).toBe(1);
  });

  it("is unchanged for a bus with no route_id or no registered path", () => {
    registerRoutePaths({ [ROUTE]: path });
    const noRoute = { lat: onOutboundHighway.lat, lon: onOutboundHighway.lon, heading: 270, last_stop_id: 1 };
    const chordAnswer = findRouteAnchor(noRoute, stops, coords);
    registerRoutePaths(null);
    expect(findRouteAnchor({ ...onOutboundHighway, heading: 270, last_stop_id: 1 }, stops, coords)).toBe(chordAnswer);
  });

  it("re-traces legs after registerRoutePaths replaces the polylines", () => {
    registerRoutePaths({ [ROUTE]: path });
    const bus = { ...onHomewardHighway, heading: 90, last_stop_id: 1 };
    expect(findRouteAnchor(bus, stops, coords)).toBe(LEG.home);
    registerRoutePaths({ [ROUTE]: [pt(H), pt(W1)] }); // a path that supplies no leg usefully
    const after = findRouteAnchor(bus, stops, coords);
    expect(after).toBeGreaterThanOrEqual(0);
    expect(after).toBeLessThan(stops.length);
  });

  it("treats a heading of exactly 0 as unknown", () => {
    // 0 is what a feed emits for "no bearing" (and what the shared fixture's
    // makeBus defaults to); a genuine due-north reading is 22 of 11,867 moving
    // production samples. So 0 must not filter anything: the homeward bus
    // with a stale hint falls back to the forward-order answer, exactly as
    // with no heading at all.
    registerRoutePaths({ [ROUTE]: path });
    const noHeading = findRouteAnchor({ ...onHomewardHighway, last_stop_id: 1 }, stops, coords);
    expect(findRouteAnchor({ ...onHomewardHighway, heading: 0, last_stop_id: 1 }, stops, coords)).toBe(noHeading);
    // whereas 1° is a real heading and does its job
    expect(findRouteAnchor({ ...onHomewardHighway, heading: 89, last_stop_id: 1 }, stops, coords)).toBe(LEG.home);
  });

  it("documents the tolerance the replay measured as flat", () => {
    expect(ANCHOR_HEADING_TOLERANCE_DEG).toBe(110);
  });
});
