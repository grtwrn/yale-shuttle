import { describe, expect, it } from "vitest";

import { BERTHS, berthFor } from "./berths";
import { ROUTE_LISTS } from "./routes";
import STOPS from "../../src/server/__fixtures__/stops.json";

/**
 * The table is measured and checked in, so the suite's job is to catch an entry
 * that has drifted from the network it describes — a stop that no longer
 * exists, a line that no longer serves it, a coordinate that has been edited by
 * hand. It cannot re-derive the measurement; `docs/berth-offsets.md` is that.
 */
const byId = new Map((STOPS as { id: number; name: string; lat: number; lon: number }[]).map((s) => [s.id, s]));
const R = 6371000, rad = (d: number) => (d * Math.PI) / 180;
const distM = (aLat: number, aLon: number, bLat: number, bLon: number) => {
  const m = rad((aLat + bLat) / 2);
  return Math.hypot(rad(bLon - aLon) * Math.cos(m), rad(bLat - aLat)) * R;
};

describe("the berth table", () => {
  it("names a real stop in every entry", () => {
    for (const b of BERTHS) expect(byId.get(b.stopId), `stop ${b.stopId}`).toBeTruthy();
  });

  it("names a route that ROUTE_LISTS knows", () => {
    const known = new Set(ROUTE_LISTS.flatMap((c) => c.busRouteIds));
    for (const b of BERTHS) expect(known.has(b.routeId), `route ${b.routeId}`).toBe(true);
  });

  it("keeps every berth clear of the deadband and inside a walk", () => {
    for (const b of BERTHS) {
      // 35 m is the floor the measurement uses: below it the feed's ~30 m
      // deadband alone could produce the offset. 150 m is a sanity ceiling —
      // past that the entry is describing a different stop, not this one's kerb.
      expect(Math.abs(b.offsetM), `${byId.get(b.stopId)?.name}`).toBeGreaterThanOrEqual(35);
      expect(Math.abs(b.offsetM), `${byId.get(b.stopId)?.name}`).toBeLessThan(150);
    }
  });

  it("puts the coordinate where the offset says it is", () => {
    // Straight-line distance can be shorter than the along-route offset where
    // the road bends, never longer — so this catches a coordinate edited apart
    // from its offset without re-deriving the projection.
    for (const b of BERTHS) {
      const s = byId.get(b.stopId)!;
      const d = distM(s.lat, s.lon, b.lat, b.lon);
      expect(d, s.name).toBeLessThanOrEqual(Math.abs(b.offsetM) + 15);
      expect(d, s.name).toBeGreaterThan(20);
    }
  });

  it("holds one entry per (stop, route)", () => {
    const keys = BERTHS.map((b) => `${b.stopId}:${b.routeId}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("reports a majority of visits, which is what the sentence claims", () => {
    // The card says "seen N of the last M times one served this stop".
    for (const b of BERTHS) {
      expect(b.of).toBeGreaterThanOrEqual(20);
      expect(b.seen / b.of).toBeGreaterThanOrEqual(0.75);
    }
  });

  it("answers null for a stop with no measured berth, which is nearly all of them", () => {
    expect(berthFor(11, [3])).toBeNull();      // 344 Winchester, Red
    expect(berthFor(48, [1])).toBeNull();      // Division / Prospect, but Blue Day does not serve it
    expect(berthFor(48, [3])).not.toBeNull();  // Division / Prospect, Red — the operator's case
  });
});
