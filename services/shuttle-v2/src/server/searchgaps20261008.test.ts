import { describe, expect, it } from "vitest";
import { TransitNetwork } from "../network/TransitNetwork.js";
import type { Stop } from "../schema/api.js";
import stops from "./__fixtures__/stops.json";
import { geocode } from "./geocode.js";
import { geocodeV1 } from "./v1compat.js";

const network = TransitNetwork.build(stops as Stop[], []);
const offline = { lookup: async () => [] };

describe("verified public-place search gaps (2026-10-08)", () => {
  it.each([
    ["195 church", "195 Church Street", 41.307916, -72.9242369],
    ["195 church st", "195 Church Street", 41.307916, -72.9242369],
    ["195 church street", "195 Church Street", 41.307916, -72.9242369],
    ["rosenfield", "Rosenfeld Hall", 41.3110976, -72.9232544],
    ["ro senf ie l d", "Rosenfeld Hall", 41.3110976, -72.9232544],
    ["rosenfeld hall", "Rosenfeld Hall", 41.3110976, -72.9232544],
    ["the anlaun", "The Anlyan Center (TAC)", 41.30118, -72.934072],
    ["anlaun", "The Anlyan Center (TAC)", 41.30118, -72.934072],
    ["twentyfair", "Twenty Fair", 41.3024326, -72.9215411],
    ["twenty fair", "Twenty Fair", 41.3024326, -72.9215411],
    ["biolabs", "101 College Street", 41.3035877, -72.9305618],
    ["bio labs", "101 College Street", 41.3035877, -72.9305618],
  ])("%s finds %s when providers return nothing", async (q, label, lat, lon) => {
    const [first] = await geocodeV1(network, q, offline);
    expect(first?.display_name).toBe(label);
    expect(first?.lat).toBe(lat);
    expect(first?.lon).toBe(lon);
  });

  it("ranks the downtown tower before the other city's same-number address", async () => {
    const westHaven = {
      display_name: "195, Church Street, Savin Rock, West Haven, Connecticut",
      lat: 41.2689029, lon: -72.956148, type: "house", class: "osm",
    };
    const results = await geocodeV1(network, "195 church st", {
      lookup: async () => [westHaven],
    });
    expect(results[0]?.display_name).toBe("195 Church Street");
    expect(results).toContainEqual(westHaven);
  });

  it.each(["194 church", "195 church street south", "195 church st west haven", "195 churchill"])(
    "%s does not guess the downtown tower",
    (q) => expect(geocode(network, q).some((h) => h.label === "195 Church Street")).toBe(false),
  );

  it.each([
    ["20 fair st wallingford", "Twenty Fair"],
    ["109 grove st west haven", "Rosenfeld Hall"],
  ])("%s does not become a new numbered alias for %s", (q, label) => {
    expect(geocode(network, q).some((h) => h.label === label)).toBe(false);
  });

  it("keeps the short optional typo outside fuzzy guessing", () => {
    expect(geocode(network, "luon")).toEqual([]);
  });
});
