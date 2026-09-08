import { afterEach, describe, expect, it } from "vitest";

import { isBusOnRoute, OFF_ROUTE_THRESHOLD_M, registerRoutePaths } from "./anchor";
import { haversineMeters } from "./geo";
import { at, routeStops, STOP, stopCoords } from "./__fixtures__/payload";
import incidents from "./__fixtures__/anchor-incidents.json";
import { resolveAnchorIndex } from "./liveAnchor";
import type { AnchorStore } from "./eta";

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
    // Two stops one ring cell apart: the emission cannot separate them on
    // position alone, which is why the belief carries both and the sequence
    // decides. (Until 2026-09-06 the same fact was stated against the retired
    // anchor's 150 m candidate threshold.)
    expect(gap).toBeLessThan(30);
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



// ---------------------------------------------------------------------------
// The two recorded incidents. Everything below runs on production feed rows
// and the operator's own published geometry — `__fixtures__/anchor-incidents.json`,
// written by `scripts/eta-replay/make-incident-fixture.ts` — so a regression
// fails here with the real coordinates rather than a contrived pair of stops.
// ---------------------------------------------------------------------------

const INC = incidents as unknown as {
  routes: Record<string, { label: string; stops: number[]; path: [number, number][] }>;
  stopCoords: Record<string, { lat: number; lon: number }>;
  stopNames: Record<string, string>;
  incidents: Record<string, {
    route_id: number; bus_name: string;
    polls: Array<{ et: string; collected_at: number; lat: number; lon: number; last_stop_id: number }>;
  }>;
};
const incCoords: Record<number, { lat: number; lon: number }> = {};
for (const [k, v] of Object.entries(INC.stopCoords)) incCoords[Number(k)] = v;
const incPaths: Record<string, [number, number][]> = {};
for (const [k, v] of Object.entries(INC.routes)) incPaths[k] = v.path;
const pollAt = (id: string, et: string) => {
  const p = INC.incidents[id]!.polls.find((x) => x.et === et);
  if (!p) throw new Error(`no poll ${et} in ${id}`);
  return p;
};


describe("the anchor on screen walks the incident forward (report #95)", () => {
  // Red #316, 2026-09-04. Upstream froze `last_stop_id` at Whitney / Audubon
  // (index 9) from 11:34:56 to 11:41:57 — seven minutes, five stops. The rule
  // that read that field, and the candidate sort it fed, are gone with the
  // retired anchor; what a rider sees is `resolveAnchorIndex`, which reads the
  // belief on the ring. It must still walk this recording forward.
  const red = INC.routes["3"]!;
  const stops = red.stops;

  afterEach(() => registerRoutePaths(null));

  it("the anchor walks the incident forward, one leg at a time", () => {
    // Poll by poll on the real geometry, through the sequence a rider sees:
    // `resolveAnchorIndex` steps the belief and reads its lead. Over seven
    // minutes of a frozen feed the anchor advances and never retreats, and
    // never skips a stop.
    registerRoutePaths(incPaths);
    const store: AnchorStore = new Map();
    const N = stops.length;
    let prev = -1;
    const visited: string[] = [];
    for (const p of INC.incidents["red316"]!.polls) {
      const idx = resolveAnchorIndex(
        { lat: p.lat, lon: p.lon, last_stop_id: p.last_stop_id, route_id: 3 },
        stops, incCoords, "Red|#316", p.collected_at, store,
      );
      if (prev >= 0) {
        const forward = (idx - prev + N) % N;
        expect(
          forward,
          `${p.et}: ${INC.stopNames[String(stops[prev]!)]} -> ${INC.stopNames[String(stops[idx]!)]}`,
        ).toBeLessThanOrEqual(1);
      }
      if (idx !== prev) visited.push(INC.stopNames[String(stops[idx]!)]!);
      prev = idx;
    }
    // and it walked the whole Winchester loop rather than stalling behind it.
    // The retired gate ended this trace at Canal / Munson, two stops short,
    // with the 344 Winchester layover still in front of every rider downstream.
    expect(visited).toContain("Canal / Munson");
    expect(visited).toContain("344 Winchester");
    expect(stops.indexOf(3 /* 130 Prospect (N) */)).toBeLessThan(prev);
    // The retired gate ended this trace at Winchester / Division. The ring
    // estimator (web/src/eta/, which answers for every route now) is a leg further on
    // at 11:46:58 — the bus is 221 m past 344 Winchester and the hop to
    // Winchester / Division is 112 m — so the bound is "at or past it".
    expect(prev).toBeGreaterThanOrEqual(stops.indexOf(146 /* Winchester / Division */));
  });
});
