import { describe, expect, it } from "vitest";
import { TransitNetwork } from "../network/TransitNetwork.js";
import type { Stop } from "../schema/api.js";
import liveStops from "./__fixtures__/stops.json";
import { geocode } from "./geocode.js";
import { geocodeV1 } from "./v1compat.js";

const network = TransitNetwork.build(liveStops as Stop[], []);

describe("numbered Hillhouse addresses typed as Hill House (searchgaps20261007)", () => {
  it.each([
    ["55 hill house ave", "55 hillhouse ave", "Horchow Hall"],
    ["55 hill house ave new haven ct 06511", "55 hillhouse ave new haven ct 06511", "Horchow Hall"],
    ["55 hill house avenue", "55 hillhouse avenue", "Horchow Hall"],
    ["55 hill house", "55 hillhouse", "Horchow Hall"],
    ["55 Hill House Ave., New Haven, CT", "55 Hillhouse Ave., New Haven, CT", "Horchow Hall"],
    ["38 hill house ave", "38 hillhouse ave", "Undergraduate Admissions (38 Hillhouse)"],
    ["34 hill house avenue", "34 hillhouse avenue", "Luce Hall"],
    ["10 hill house", "10 hillhouse", "Dunham Laboratory"],
  ])("%s finds the same exact address as %s", (query, joined, label) => {
    expect(geocode(network, query)).toEqual(geocode(network, joined));
    expect(geocode(network, query)[0]?.label).toBe(label);
  });

  it("answers the rider-facing pipeline when the provider misses", async () => {
    const queries: string[] = [];
    const hits = await geocodeV1(network, "55 hill house ave", { lookup: async (q) => { queries.push(q); return []; } });
    expect(hits).toEqual([{ display_name: "Horchow Hall", lat: 41.315448, lon: -72.922402, type: "college", class: "yale" }]);
    expect(queries).toEqual(["55 hill house ave"]);
  });

  it.each(["3 hill house ave", "5 hill house ave", "54 hill house ave", "550 hill house avenue", "3 hill house ave new haven ct 06511"])(
    "never prefixes a different house number: %s", async (query) => {
      expect(geocode(network, query)).toEqual([]);
      const queries: string[] = [];
      const other = { display_name: query, lat: 41.312, lon: -72.924, type: "house", class: "osm" };
      expect(await geocodeV1(network, query, { lookup: async (q) => { queries.push(q); return [other]; } })).toEqual([other]);
      expect(queries).toEqual([query]);
    },
  );

  it.each(["hill house", "hill house ave", "55 hill house road", "55 hill house st", "55 hill houses ave", "55 hill house annex", "55 hill house ave boston ma"])(
    "does not guess a bare name or another street: %s", async (query) => {
      expect(geocode(network, query)).toEqual([]);
      const queries: string[] = [];
      await geocodeV1(network, query, { lookup: async (q) => { queries.push(q); return []; } });
      expect(queries).toEqual([query]);
    },
  );

  it("keeps a literal existing place ahead of the address guess", () => {
    const literal = { label: "55 Hill House Ave", lat: 41.32, lon: -72.92, anchorStop: "Sachem / Whitney" };
    expect(geocode(network, "55 hill house ave", [literal])[0]?.label).toBe(literal.label);
  });

  it("does not prefix a longer house number in an injected alias", () => {
    const other = { label: "Other house", aliases: ["550 hillhouse"], lat: 41.32, lon: -72.92, anchorStop: "Sachem / Whitney" };
    expect(geocode(network, "55 hill house ave", [other])).toEqual([]);
  });

  it("requires an exact address alias, never a longer address prefix", () => {
    const annex = { label: "Annex", aliases: ["55 hillhouse annex"], lat: 41.32, lon: -72.92, anchorStop: "Sachem / Whitney" };
    expect(geocode(network, "55 hill house ave", [annex])).toEqual([]);
  });
});
