import { describe, expect, it } from "vitest";

import { CANARY_LINES, MIN_RIDE_M, haversineM } from "./canary-metrics.mjs";
import { readFileSync } from "node:fs";

import {
  BUS_SPEED_M_S, candidateRides, DOMINANCE_MARGIN_SEC, hopSec, MAX_RIDE_SEC, nextInRotation,
  randomTripForLine, WALK_EFFECTIVE_M_S, walkSec,
} from "./canary-rotation.mjs";

/** rideableLines() shape, in CANARY_LINES order, with the named ones rideable. */
const lines = (...rideable) =>
  CANARY_LINES.map((l) => ({ ...l, rideable: rideable.includes(l.label) }));

describe("nextInRotation", () => {
  it("walks the running lines in CANARY_LINES order and wraps", () => {
    const L = lines("Blue Weekend", "Green", "Purple", "Grocery Ham");
    expect(nextInRotation(L, null).label).toBe("Blue Weekend");
    expect(nextInRotation(L, "Blue Weekend").label).toBe("Green");
    expect(nextInRotation(L, "Green").label).toBe("Purple");
    expect(nextInRotation(L, "Purple").label).toBe("Grocery Ham");
    expect(nextInRotation(L, "Grocery Ham").label).toBe("Blue Weekend");
  });

  it("skips a line that has nothing rideable, keeping its place", () => {
    // Green went off-air between Blue Weekend's ride and its own turn.
    const L = lines("Blue Weekend", "Purple");
    expect(nextInRotation(L, "Blue Weekend").label).toBe("Purple");
  });

  it("never rides the dedicated line, even when it is the only one running", () => {
    expect(nextInRotation(lines("Red", "Green"), null).label).toBe("Green");
    expect(nextInRotation(lines("Red"), null)).toBeNull();
    expect(nextInRotation(lines("Red"), "Purple")).toBeNull();
  });

  it("idles when nothing at all is running", () => {
    expect(nextInRotation(lines(), null)).toBeNull();
  });

  it("starts over on a label it does not know", () => {
    expect(nextInRotation(lines("Green", "Purple"), "Blue Weekend").label).toBe("Green");
    expect(nextInRotation(lines("Green", "Purple"), "no such line").label).toBe("Green");
  });

  it("with no dedicated line every running line takes its turn", () => {
    const L = lines("Red", "Green");
    expect(nextInRotation(L, null, null).label).toBe("Red");
    expect(nextInRotation(L, "Red", null).label).toBe("Green");
    expect(nextInRotation(L, "Green", null).label).toBe("Red");
  });
});

/** A 12-stop loop ~400 m between neighbours, ids 100..111, and one bus. */
function loop({ lastStop = 103, routeId = 9, repeat = false } = {}) {
  const ids = Array.from({ length: 12 }, (_, i) => 100 + i);
  const stop_coords = {};
  const stop_names = {};
  ids.forEach((id, i) => {
    // A ring of radius ~760 m: neighbours ~400 m apart by crow-flies, and no
    // straight line folds back on itself the way a lat-only ramp would.
    const a = (i / 12) * 2 * Math.PI;
    stop_coords[id] = { lat: 41.3 + 0.00684 * Math.cos(a), lon: -72.92 + 0.0091 * Math.sin(a) };
    stop_names[id] = `Stop ${id}`;
  });
  const seq = repeat ? [...ids, ...ids.slice(1, -1).reverse()] : ids;
  return {
    buses: [{ bus_id: 1, bus_name: "#40", route_id: routeId, lat: 41.3, lon: -72.92, last_stop_id: lastStop }],
    routes: { [routeId]: seq },
    stop_coords, stop_names,
  };
}
const GREEN = CANARY_LINES.find((l) => l.label === "Green");
const HAM = CANARY_LINES.find((l) => l.label === "Grocery Ham");

/** A deterministic rng: cycles through the given fractions. */
const seq = (...v) => { let i = 0; return () => v[i++ % v.length]; };
const lcg = (s) => { let x = s + 1; return () => { x = (x * 48271) % 2147483647; return x / 2147483647; }; };

/**
 * Grocery Ham as /api/buses served it on 2026-09-06 (route 18: six stops,
 * two 6 km hops out to Hamden and back, calibrated averages verbatim). The
 * loop the false positive happened on.
 */
const HAM_PAYLOAD = (lastStop = 170) => ({
  buses: [{ bus_id: 9, bus_name: "#38", route_id: 18, lat: 41.375, lon: -72.917, last_stop_id: lastStop }],
  routes: { 18: [53, 54, 137, 132, 170, 169] },
  stop_coords: {
    53: { lat: 41.31086, lon: -72.93054 }, 54: { lat: 41.309579, lon: -72.927476 },
    137: { lat: 41.317542, lon: -72.919779 }, 132: { lat: 41.321181, lon: -72.918038 },
    170: { lat: 41.37512, lon: -72.91709 }, 169: { lat: 41.36879, lon: -72.92047 },
  },
  stop_names: {
    53: "Elm / York (TYCO)", 54: "Elm / College", 137: "Whitney / Humphrey (N)",
    132: "Whitney / Cottage (N)", 170: "Aldi/Walmart", 169: "Shop Rite",
  },
  segments: { 18: {
    "53-54": { avg: 396.7, n: 7 }, "54-137": { avg: 271.3, n: 8 }, "137-132": { avg: 213, n: 8 },
    "132-170": { avg: 1091.8, n: 0 }, "170-169": { avg: 1092.6, n: 7 }, "169-53": { avg: 1182.4, n: 0 },
  } },
});

describe("the planner's limits are mirrored, not copied", () => {
  const src = (f) => readFileSync(new URL(`../web/src/${f}`, import.meta.url), "utf8");
  it("MAX_RIDE_SEC is the planner's", () => {
    const m = src("planner.ts").match(/export const MAX_RIDE_SEC = (\d+) \* 60;/);
    expect(Number(m[1]) * 60).toBe(MAX_RIDE_SEC);
  });
  it("BUS_SPEED_M_S is the planner's fallback speed", () => {
    const m = src("routes.ts").match(/export const BUS_SPEED_M_S = ([\d.]+);/);
    expect(Number(m[1])).toBe(BUS_SPEED_M_S);
  });
  it("WALK_EFFECTIVE_M_S is the app's walking rate", () => {
    const m = src("walk.ts").match(/export const WALK_EFFECTIVE_M_S = ([\d.]+);/);
    expect(Number(m[1])).toBe(WALK_EFFECTIVE_M_S);
  });
});

describe("hopSec", () => {
  it("uses the calibrated average when it has a sample, else the planner's crow-flies fallback", () => {
    const p = HAM_PAYLOAD();
    expect(hopSec(p, HAM, 137, 132)).toBe(213);
    // 132-170 is served with n: 0 — the planner ignores it, so must we.
    const m = haversineM(p.stop_coords[132], p.stop_coords[170]);
    expect(hopSec(p, HAM, 132, 170)).toBeCloseTo(m / BUS_SPEED_M_S, 6);
    expect(hopSec(p, HAM, 132, 170)).toBeGreaterThan(900);
  });
});

describe("candidateRides on Grocery Ham (the 2026-09-06 false positive)", () => {
  it("never produces Whitney / Humphrey (N) -> Elm / College, the long way round", () => {
    for (const at of [53, 54, 137, 132, 170, 169]) {
      const rides = candidateRides(HAM_PAYLOAD(at), HAM);
      expect(rides.some((r) => r.boardId === 137 && r.alightId === 54)).toBe(false);
      for (const r of rides) {
        expect(r.alight).toBeGreaterThan(r.board);          // one lap, never wrapped
        expect(r.hops).toBeLessThanOrEqual(3);              // half of six
        expect(r.rideSec).toBeLessThanOrEqual(MAX_RIDE_SEC);
        expect(r.rideSec + DOMINANCE_MARGIN_SEC).toBeLessThanOrEqual(r.walkSec);
      }
    }
  });

  it("still finds the sane rides — Whitney -> Aldi, Elm / College -> Whitney", () => {
    const rides = candidateRides(HAM_PAYLOAD(170), HAM);
    const pair = (b, a) => rides.find((r) => r.boardId === b && r.alightId === a);
    expect(pair(137, 170)).toBeTruthy();   // 2 hops, ~22 min ride, 6.4 km walk
    expect(pair(54, 132)).toBeTruthy();    // 2 hops, ~8 min ride, ~1.5 km walk
    expect(pair(53, 54)).toBeUndefined();  // 397 s ride for a 293 m walk: walking wins
    // 3 hops, 24.7 min: the uncalibrated 132-170 hop is priced at crow-flies
    // over BUS_SPEED_M_S (~1000 s), exactly as the planner prices it, so the
    // app DOES offer this one and the picker must agree.
    expect(pair(54, 170)).toBeTruthy();
    expect(pair(54, 170).rideSec).toBeLessThanOrEqual(MAX_RIDE_SEC);
  });

  it("rides the longest dominant leg when no 4..11-hop ride can exist", () => {
    const { trip, reason } = randomTripForLine(HAM_PAYLOAD(170), HAM, seq(0.5));
    expect(reason).toBeNull();
    expect(trip.kind).toBe("longest");
    expect(trip.origin.label).toBe("Elm / College");
    expect(trip.destination.display_name).toBe("Aldi/Walmart");
    expect(trip.estimate.hops).toBe(3);
    expect(trip.estimate.rideSec).toBeLessThanOrEqual(MAX_RIDE_SEC);
    expect(trip.estimate.rideSec + DOMINANCE_MARGIN_SEC).toBeLessThanOrEqual(trip.estimate.walkSec);
  });

  it("skips a line that has no ride the planner would offer, with a reason", () => {
    const p = HAM_PAYLOAD(170);
    // Every hop priced just past MAX_RIDE_SEC: nothing the planner would offer.
    for (const k of Object.keys(p.segments[18])) p.segments[18][k] = { avg: MAX_RIDE_SEC + 1, n: 5 };
    const r = randomTripForLine(p, HAM);
    expect(r.trip).toBeNull();
    expect(r.reason).toMatch(/no forward ride on Grocery Ham/);
  });

  it("skips a line whose bus reports no position", () => {
    const p = HAM_PAYLOAD();
    p.buses[0].last_stop_id = null;
    expect(randomTripForLine(p, HAM).trip).toBeNull();
    expect(randomTripForLine(p, HAM).reason).toMatch(/reports a position/);
  });
});

describe("randomTripForLine on a 12-stop loop", () => {
  it("boards 1..6 stops ahead of a bus, rides 4..6 (half the loop) further, and beats walking", () => {
    for (let s = 0; s < 200; s++) {
      const p = loop();
      const { trip: t } = randomTripForLine(p, GREEN, lcg(s));
      expect(t).not.toBeNull();
      expect(t.kind).toBe("random");
      const stops = p.routes[9];
      const bus = stops.indexOf(103);
      const i = stops.indexOf(t.origin.stopId);
      const j = stops.indexOf(t.destination.stopId);
      const ahead = (i - bus + 12) % 12;
      expect(ahead).toBeGreaterThanOrEqual(1);
      expect(ahead).toBeLessThanOrEqual(6);
      expect(j).toBeGreaterThan(i);                    // same lap
      expect(j - i).toBeGreaterThanOrEqual(4);
      expect(j - i).toBeLessThanOrEqual(6);            // half of twelve
      expect(t.approaching).toEqual({ busName: "#40", stopsAway: ahead });
      expect(haversineM(t.origin, t.destination)).toBeGreaterThanOrEqual(MIN_RIDE_M);
      expect(t.estimate.rideSec + DOMINANCE_MARGIN_SEC).toBeLessThanOrEqual(walkSec(t.origin, t.destination));
    }
  });

  it("serves the destination in the geocoder's own shape so the app auto-picks it", () => {
    const { trip: t } = randomTripForLine(loop(), GREEN, seq(0));
    expect(t.destination).toMatchObject({ type: "bus_stop", class: "shuttle" });
    expect(typeof t.destination.display_name).toBe("string");
    expect(t.origin.label).toMatch(/^Stop /);
  });

  it("only counts buses on this line", () => {
    const p = loop({ routeId: 9 });
    p.buses[0].route_id = 10; // Purple's bus, on Green's stops
    expect(randomTripForLine(p, GREEN).trip).toBeNull();
  });

  it("indexes by position, so a repeated stop id on an out-and-back is fine", () => {
    const p = loop({ repeat: true, lastStop: 105 });
    for (let s = 0; s < 50; s++) {
      const { trip: t } = randomTripForLine(p, GREEN, lcg(s));
      expect(t).not.toBeNull();
      expect(t.origin.stopId).not.toBe(105);
      expect(t.origin.stopId).not.toBe(t.destination.stopId);
    }
  });

  it("refuses a ride shorter than MIN_RIDE_M", () => {
    const p = loop();
    // Collapse the whole loop onto one point: every pair is 0 m apart.
    for (const id of Object.keys(p.stop_coords)) p.stop_coords[id] = { lat: 41.3, lon: -72.92 };
    expect(randomTripForLine(p, GREEN, seq(0.5)).trip).toBeNull();
  });
});
