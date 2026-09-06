import { describe, expect, it } from "vitest";

import { CANARY_LINES, MIN_RIDE_M, haversineM } from "./canary-metrics.mjs";
import { nextInRotation, randomTripForLine } from "./canary-rotation.mjs";

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
    // 0.0036° lat ≈ 400 m; the loop is a straight line folded on itself,
    // which is enough for distances to be monotone in position.
    stop_coords[id] = { lat: 41.3 + i * 0.0036, lon: -72.92 };
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

/** A deterministic rng: cycles through the given fractions. */
const seq = (...v) => { let i = 0; return () => v[i++ % v.length]; };

describe("randomTripForLine", () => {
  it("boards 1..6 stops ahead of a bus and alights 4..11 further on", () => {
    for (let s = 0; s < 200; s++) {
      const rng = (() => { let x = s + 1; return () => { x = (x * 48271) % 2147483647; return x / 2147483647; }; })();
      const t = randomTripForLine(loop(), GREEN, rng);
      expect(t).not.toBeNull();
      const stops = loop().routes[9];
      const bus = stops.indexOf(103);
      const i = stops.indexOf(t.origin.stopId);
      const j = stops.indexOf(t.destination.stopId);
      const ahead = (i - bus + 12) % 12;
      const ride = (j - i + 12) % 12;
      expect(ahead).toBeGreaterThanOrEqual(1);
      expect(ahead).toBeLessThanOrEqual(6);
      expect(ride).toBeGreaterThanOrEqual(4);
      expect(ride).toBeLessThanOrEqual(11);
      expect(t.approaching).toEqual({ busName: "#40", stopsAway: ahead });
      expect(haversineM(t.origin, t.destination)).toBeGreaterThanOrEqual(MIN_RIDE_M);
    }
  });

  it("serves the destination in the geocoder's own shape so the app auto-picks it", () => {
    const t = randomTripForLine(loop(), GREEN, seq(0, 0, 0, 0));
    expect(t.kind).toBe("random");
    expect(t.destination).toMatchObject({ type: "bus_stop", class: "shuttle" });
    expect(typeof t.destination.display_name).toBe("string");
    expect(t.origin.label).toMatch(/^Stop /);
  });

  it("is null when no bus on the line reports a last stop", () => {
    const p = loop();
    p.buses[0].last_stop_id = null;
    expect(randomTripForLine(p, GREEN)).toBeNull();
    p.buses = [];
    expect(randomTripForLine(p, GREEN)).toBeNull();
  });

  it("only counts buses on this line", () => {
    const p = loop({ routeId: 9 });
    p.buses[0].route_id = 10; // Purple's bus, on Green's stops
    expect(randomTripForLine(p, GREEN)).toBeNull();
  });

  it("indexes by position, so a repeated stop id on an out-and-back is fine", () => {
    // 22 positions, ids repeat on the way back; the bus's id appears twice.
    const p = loop({ repeat: true, lastStop: 105 });
    for (let s = 0; s < 50; s++) {
      const t = randomTripForLine(p, GREEN, seq(s / 50, 0.5, 0.2, 0.9, 0.1));
      expect(t).not.toBeNull();
      expect(t.origin.stopId).not.toBe(105);
      expect(t.origin.stopId).not.toBe(t.destination.stopId);
    }
  });

  it("refuses a ride shorter than MIN_RIDE_M", () => {
    const p = loop();
    // Collapse the whole loop onto one point: every pair is 0 m apart.
    for (const id of Object.keys(p.stop_coords)) p.stop_coords[id] = { lat: 41.3, lon: -72.92 };
    expect(randomTripForLine(p, GREEN, seq(0.5))).toBeNull();
  });
});
