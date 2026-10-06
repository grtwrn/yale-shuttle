import { describe, expect, it } from "vitest";

import { TransitNetwork } from "../network/TransitNetwork.js";
import type { Stop } from "../schema/api.js";
import liveStops from "./__fixtures__/stops.json";
import { LANDMARKS } from "./landmarks.js";
import { geocodeV1 } from "./v1compat.js";

const network = TransitNetwork.build(liveStops as Stop[], []);

// Public OSM objects from the 2026-10-05 cached sweep, not provider responses
// that can disappear when Photon/Nominatim are slow. One pin per destination.
const PLACES = [
  { label: "SHM I-Wing", lat: 41.3036267, lon: -72.9338244, anchorStop: "333 Cedar", queries: ["SHM I-Wing", "shm i wing"] }, // W239527108
  { label: "SHM L-Wing", lat: 41.3030137, lon: -72.933368, anchorStop: "333 Cedar", queries: ["SHM L-Wing", "shm l wing"] }, // W239527109
  { label: "SHM B-Wing", lat: 41.3036061, lon: -72.9332509, anchorStop: "333 Cedar", queries: ["SHM B-Wing", "shm b wing"] }, // W238239207
  { label: "Jordan's Hot Dogs & Mac", lat: 41.3155244, lon: -72.9101408, anchorStop: "Nicoll / Edwards", queries: ["Jordan's Hot Dogs & Mac", "jordans hot dogs and mac"] }, // N2970459335
  { label: "Salon & Spa", lat: 41.3038565, lon: -72.9236838, anchorStop: "Chapel / State Elm City Market", queries: ["Salon & Spa", "salon and spa"] }, // N2441439313
] as const;

describe("verified OSM search gaps (searchgaps20261005)", () => {
  for (const place of PLACES) {
    it.each(place.queries)("%s reaches the requested destination without an external provider", async (query) => {
      const hits = await geocodeV1(network, query, { lookup: async () => [] });
      expect(hits[0]).toMatchObject({ display_name: place.label, lat: place.lat, lon: place.lon, class: "yale" });
      expect(hits.filter((h) => h.display_name === place.label)).toHaveLength(1);
      expect(LANDMARKS.find((l) => l.label === place.label)?.anchorStop).toBe(place.anchorStop);
    });
  }

  // The rejected seven-entry candidate stole rank 1 from both different OSM
  // destinations. Leave the Day/Bubble gaps open rather than reroute riders.
  it.each([
    ["Deli & Grocery", 41.3155255, -72.9376209], // N5889481814, Dickerman St
    ["Bubble And Squeak", 41.3075423, -72.934739], // N2931934371, Park St
  ] as const)("%s still ranks its distinct external destination first", async (query, lat, lon) => {
    const hits = await geocodeV1(network, query, {
      lookup: async () => [{ display_name: query, lat, lon, type: "shop", class: "osm" }],
    });
    expect(hits[0]).toMatchObject({ display_name: query, lat, lon, class: "osm" });
  });

  it.each(["shm", "sterling hall of medicine", "ysm"])("%s still means the school, not a particular wing", async (query) => {
    const hits = await geocodeV1(network, query, { lookup: async () => [] });
    expect(hits[0]?.display_name).toBe("School of Medicine (YSM)");
  });
});
