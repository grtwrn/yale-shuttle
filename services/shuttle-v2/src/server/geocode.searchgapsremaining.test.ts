import { describe, expect, it } from "vitest";

import { TransitNetwork } from "../network/TransitNetwork.js";
import { distanceMeters } from "../network/geo.js";
import type { Stop } from "../schema/api.js";
import liveStops from "./__fixtures__/stops.json";
import { geocode } from "./geocode.js";
import * as catalogue from "./landmarks.js";
import { createExternalGeocoder, geocodeV1, type GeocodeV1Hit } from "./v1compat.js";

const network = TransitNetwork.build(liveStops as Stop[], []);
// Distinct public OSM pins from the archived 2026-10-05 sweep. Street labels
// distinguish the two laundries; no destination is merged by its name alone.
const day = { display_name: "Day Grocery & Deli, Day Street", lat: 41.3088507, lon: -72.9396376, type: "convenience", class: "osm" }; // N7169618452
const willow = { display_name: "Bubble & Squeak, Willow Street", lat: 41.3211922, lon: -72.9094181, type: "laundry", class: "osm" }; // N3099233998
const dickerman = { display_name: "Deli & Grocery, Dickerman Street, New Haven", lat: 41.3155255, lon: -72.9376209, type: "convenience", class: "osm" }; // N5889481814
const park = { display_name: "Bubble And Squeak, Park Street, New Haven", lat: 41.3075423, lon: -72.934739, type: "laundry", class: "osm" }; // N2931934371
const fallbackPark = { ...park, display_name: "Bubble And Squeak, Park Street" };
const externalDay = { ...day, display_name: "Day Grocery & Deli, Day Street, New Haven", class: "osm" };
const externalWillow = { ...willow, display_name: "Bubble & Squeak, Willow Street, New Haven", class: "osm" };

function provider(photonHits: GeocodeV1Hit[], nominatimHits: GeocodeV1Hit[] = []) {
  let time = 0;
  const queries: string[] = [];
  const external = createExternalGeocoder({
    now: () => time, sleep: async (ms) => { time += ms; },
    fetchImpl: (async (input: string | URL | Request) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      queries.push(url.searchParams.get("q")!);
      const body = url.hostname === "photon.komoot.io"
        ? { features: photonHits.map((hit) => ({
            geometry: { coordinates: [hit.lon, hit.lat] },
            properties: { name: hit.display_name.split(",")[0], street: hit.display_name.split(",")[1]?.trim(), city: "New Haven", osm_value: hit.type },
          })) }
        : nominatimHits.map((hit) => ({ ...hit, lat: String(hit.lat), lon: String(hit.lon) }));
      return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    }) as typeof fetch,
  });
  return { external, queries };
}

describe("supplemental search gaps do not preempt existing destinations", () => {
  it.each(["Day Grocery & Deli", "day grocery and deli", "Day Grocery & Deli, Day Street", "Day Grocery and Deli, Day Street, New Haven"])("%s survives both provider misses", async (query) => {
    const stub = provider([]);
    const hits = await geocodeV1(network, query, stub.external);
    expect(hits).toContainEqual(day);
    expect(stub.queries).toEqual([query, query]); // original spelling, no global 'and' rewrite
  });

  it.each(["Bubble & Squeak", "bubble and squeak", "Bubble & Squeak, Willow Street", "Bubble and Squeak, Willow Street, New Haven"])("%s offers Willow when providers miss", async (query) => {
    expect(await geocodeV1(network, query, provider([]).external)).toContainEqual(willow);
  });

  it.each(["Bubble And Squeak", "bubble and squeak", "Bubble & Squeak"])("%s keeps the Park provider destination ahead of Willow", async (query) => {
    expect(await geocodeV1(network, query, provider([park]).external)).toEqual([park, willow]);
  });

  it.each(["Deli & Grocery", "deli and grocery", "grocery", "deli", "Deli & Grocery, Dickerman Street, New Haven"])("%s retains the Dickerman provider result first", async (query) => {
    const hits = await geocodeV1(network, query, provider([], [dickerman]).external);
    expect(hits[geocode(network, query).length]).toEqual(dickerman);
  });

  it.each([park.display_name, "Bubble & Squeak, Park Street, New Haven"])("%s never guesses Willow for an explicit Park address", async (query) => {
    expect(await geocodeV1(network, query, provider([], [park]).external)).toEqual([park]);
    expect(await geocodeV1(network, query, provider([]).external)).not.toContainEqual(willow);
  });

  it.each([
    ["day grocery and deli", externalDay, day],
    ["bubble and squeak", externalWillow, willow],
  ] as const)("%s keeps a provider hit rather than duplicating it", async (query, hit, supplement) => {
    const hits = await geocodeV1(network, query, provider([hit, hit]).external);
    expect(hits[0]).toEqual(hit);
    expect(hits.filter((h) => h.lat === hit.lat && h.lon === hit.lon)).toHaveLength(1);
    if (query === "bubble and squeak") expect(hits).toEqual([hit, fallbackPark]);
    else expect(hits).toEqual([hit]);
    expect(hits).not.toContainEqual(supplement);
  });

  it("keeps both named branches and collapses only a Willow provider duplicate", async () => {
    expect(await geocodeV1(network, "bubble and squeak", provider([park, externalWillow, externalWillow]).external)).toEqual([park, externalWillow]);
  });

  it("does not deduplicate a different named business merely sharing Willow's pin", async () => {
    const other = { ...externalWillow, display_name: "Bubble And Squeak Tailoring, Willow Street, New Haven" };
    expect(await geocodeV1(network, "bubble and squeak", provider([other]).external)).toEqual([other, fallbackPark, willow]);
  });

  it("leaves generic substrings to the unchanged local/provider ranking", async () => {
    const other = { ...externalWillow, display_name: "Bubble Tea, Willow Street, New Haven" };
    expect(await geocodeV1(network, "bubble", provider([other]).external)).toEqual([other]);
  });

  it.each(["517 Prospect St", "272elm", "t.d. college", "j.e. college", "p&m", "b&n", "shm"])("%s is not a supplemental destination", async (query) => {
    const hits = await geocodeV1(network, query, provider([]).external);
    expect(hits).not.toContainEqual(day);
    expect(hits).not.toContainEqual(willow);
    if (query === "t.d. college") expect(hits[0]?.display_name).toBe("Timothy Dwight College");
  });

  it("offers both street-labelled branches on a bare-name provider miss without high-confidence auto-pick", async () => {
    const hits = await geocodeV1(network, "bubble and squeak", provider([]).external);
    expect(hits).toEqual([fallbackPark, willow]);
    // Both client search call sites auto-pick a single result, yale, house,
    // or bus_stop; these two laundry/OSM options instead show the dropdown.
    expect(hits.length === 1 || hits[0]?.class === "yale" || ["house", "bus_stop"].includes(hits[0]!.type)).toBe(false);
  });

  it.each(["day grocery", "deli", "bubble", "squeak", "street", "and"])("%s does not acquire a speculative supplemental answer", async (query) => {
    const hits = await geocodeV1(network, query, provider([]).external);
    expect(hits).not.toContainEqual(day);
    expect(hits).not.toContainEqual(willow);
    expect(hits).not.toContainEqual(fallbackPark);
  });

  it("keeps the verified Day option even if the injected provider rejects", async () => {
    expect(await geocodeV1(network, "day grocery and deli", { lookup: async () => { throw new Error("provider unavailable"); } })).toEqual([day]);
  });

  it("never trades an existing result for a supplement at the response limit", async () => {
    const twelve = Array.from({ length: 12 }, (_, i) => ({
      ...park, display_name: "Bubble branch " + i, lat: 41.3 + i * 0.002, lon: -72.93,
    }));
    expect(await geocodeV1(network, "bubble", { lookup: async () => twelve })).toEqual(twelve);
  });

  it("uses the independently verified nearest stops, not another branch's stop", () => {
    for (const [hit, anchor, meters] of [[day, "Chapel / Dwight", 232], [willow, "Willow / Foster", 18], [fallbackPark, "129 York", 183]] as const) {
      const nearest = [...network.stops.values()].sort((a, b) => distanceMeters(hit, a) - distanceMeters(hit, b))[0]!;
      expect((catalogue as { SUPPLEMENTAL_LANDMARKS?: readonly { label: string; anchorStop: string }[] }).SUPPLEMENTAL_LANDMARKS?.find((l) => l.label === hit.display_name)?.anchorStop).toBe(anchor);
      expect(nearest.name).toBe(anchor);
      expect(distanceMeters(hit, nearest)).toBeCloseTo(meters, -1);
    }
  });
});
