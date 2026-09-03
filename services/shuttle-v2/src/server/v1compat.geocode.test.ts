import { describe, expect, it } from "vitest";

import { TransitNetwork } from "../network/TransitNetwork.js";
import type { Stop } from "../schema/api.js";

import fs from "node:fs";
import liveStops from "./__fixtures__/stops.json";
import { LANDMARKS } from "./landmarks.js";
import {
  EXTERNAL_REACH_M,
  createExternalGeocoder,
  geocodeV1,
  looksLikeStreetAddress,
  parseCoordinateQuery,
  parsePhoton,
  rankExternal,
  type GeocodeV1Hit,
} from "./v1compat.js";

/**
 * The external half of /api/geocode — Photon first, Nominatim as fallback —
 * against a stubbed fetch. Nothing here touches the network; the clock and
 * the throttle's sleep are injected so the 1.1 s queue costs no test time.
 */

// Real stops, so "near the shuttle network" means something concrete.
const STOPS: Stop[] = [
  { id: 121, name: "Union Station (N)", lat: 41.297857, lon: -72.926763 },
  { id: 33, name: "Chapel / York", lat: 41.30842, lon: -72.931341 },
  { id: 114, name: "SOM", lat: 41.315224, lon: -72.920887 },
  { id: 79, name: "Orange / Canner", lat: 41.3229, lon: -72.9111 },
];
const network = TransitNetwork.build(STOPS, [
  { id: 1, name: "R", shortName: "R", color: "#000", stops: STOPS.map((s) => s.id) },
]);

type Stub = (url: string, init: RequestInit) => Promise<Response> | Response;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A fetch stub that records the URLs it saw and answers per provider. */
function stubFetch(handlers: { photon?: Stub; nominatim?: Stub }) {
  const calls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    const h = url.includes("photon.komoot.io") ? handlers.photon : handlers.nominatim;
    if (!h) throw new Error(`unexpected fetch ${url}`);
    return h(url, init ?? {});
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

/** Fake clock + instant sleep: the throttle's bookkeeping runs, nothing waits. */
function fakeTime() {
  let t = 1_700_000_000_000;
  const sleeps: number[] = [];
  return {
    now: () => t,
    advance: (ms: number) => { t += ms; },
    sleeps,
    sleep: async (ms: number) => { sleeps.push(ms); t += ms; },
  };
}

function photonFeature(props: Record<string, unknown>, lon: number, lat: number) {
  return { type: "Feature", geometry: { type: "Point", coordinates: [lon, lat] }, properties: props };
}

const ELENAS = photonFeature(
  {
    name: "Elena's on Orange",
    street: "Orange Street",
    city: "New Haven",
    postcode: "06511",
    osm_key: "amenity",
    osm_value: "ice_cream",
    type: "house",
  },
  -72.9108,
  41.323,
);

describe("Photon", () => {
  it("parses GeoJSON into the v1 shape with a 'name, street, city' display name", () => {
    const hits = parsePhoton({
      features: [
        ELENAS,
        photonFeature(
          { housenumber: "55", street: "Lock Street", city: "New Haven", osm_key: "building", osm_value: "yes", type: "house" },
          -72.9278,
          41.3157,
        ),
        photonFeature({ name: "Orange Street", city: "New Haven", osm_key: "highway", osm_value: "residential", type: "street" }, -72.92, 41.31),
        photonFeature({ name: "Connecticut", osm_key: "place", osm_value: "state", type: "state" }, -72.7, 41.6),
        { type: "Feature", geometry: null, properties: { name: "no geometry" } },
      ],
    });
    expect(hits).toEqual([
      // The frontend shows the first two comma-parts: "Elena's on Orange, Orange Street".
      { display_name: "Elena's on Orange, Orange Street, New Haven", lat: 41.323, lon: -72.9108, type: "ice_cream", class: "osm" },
      // An address keeps type "house" (the frontend auto-picks on it), and reads as a
      // New Haven address does — number first.
      { display_name: "55 Lock Street, New Haven", lat: 41.3157, lon: -72.9278, type: "house", class: "osm" },
      { display_name: "Orange Street, New Haven", lat: 41.31, lon: -72.92, type: "residential", class: "osm" },
    ]);
  });

  it("tolerates a body that is not GeoJSON", () => {
    expect(parsePhoton(null)).toEqual([]);
    expect(parsePhoton({ error: "nope" })).toEqual([]);
    expect(parsePhoton("html")).toEqual([]);
  });

  it("collapses concurrent lookups that differ only in case or spacing into one request", async () => {
    // Three riders typing one popular destination must cost one slot of the
    // 1.1 s throttle, not three — only ~3 external lookups fit a budget.
    const { fetchImpl, calls } = stubFetch({ photon: () => json({ features: [ELENAS] }) });
    const time = fakeTime();
    const ext = createExternalGeocoder({ fetchImpl, now: time.now, sleep: time.sleep });
    const hits = await Promise.all([
      ext.lookup("Union Station"), ext.lookup("union station"), ext.lookup("  union   station "),
    ]);
    expect(calls).toHaveLength(1);
    expect(hits[1]).toBe(hits[0]);
    expect(hits[2]).toBe(hits[0]);
  });

  it("asks Photon with the New Haven bbox and never Nominatim when Photon answers", async () => {
    const { fetchImpl, calls } = stubFetch({ photon: () => json({ features: [ELENAS] }) });
    const time = fakeTime();
    const ext = createExternalGeocoder({ fetchImpl, now: time.now, sleep: time.sleep });
    const hits = await ext.lookup("elenas");
    expect(hits.map((h) => h.display_name)).toEqual(["Elena's on Orange, Orange Street, New Haven"]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("photon.komoot.io");
    expect(calls[0]).toContain("q=elenas");
    expect(calls[0]).toContain("bbox=-73.05,41.22,-72.83,41.38");
    expect(calls[0]).toContain("lang=en");
  });
});

describe("Nominatim fallback", () => {
  const NOMINATIM_ROW = {
    display_name: "Elena's on Orange, Canner Street, East Rock, New Haven, Connecticut, 06511, United States",
    lat: "41.3230",
    lon: "-72.9108",
    type: "ice_cream",
    class: "amenity",
  };

  it("is used when Photon errors", async () => {
    const { fetchImpl, calls } = stubFetch({
      photon: () => json({ message: "overloaded" }, 503),
      nominatim: () => json([NOMINATIM_ROW]),
    });
    const time = fakeTime();
    const ext = createExternalGeocoder({ fetchImpl, now: time.now, sleep: time.sleep });
    const hits = await ext.lookup("elena's");
    expect(hits).toHaveLength(1);
    expect(hits[0]!.display_name).toContain("Elena's on Orange");
    expect(hits[0]!.class).toBe("amenity");
    expect(calls.map((u) => (u.includes("photon") ? "photon" : "nominatim"))).toEqual(["photon", "nominatim"]);
    // Nominatim keeps its viewbox and the contact User-Agent its policy requires.
    expect(calls[1]).toContain("viewbox=-73.05,41.38,-72.83,41.22");
    expect(calls[1]).toContain("bounded=1");
  });

  it("is used when Photon throws, and when it returns nothing", async () => {
    const thrown = stubFetch({
      photon: () => { throw new TypeError("fetch failed"); },
      nominatim: () => json([NOMINATIM_ROW]),
    });
    const t1 = fakeTime();
    const a = createExternalGeocoder({ fetchImpl: thrown.fetchImpl, now: t1.now, sleep: t1.sleep });
    expect((await a.lookup("elena's")).map((h) => h.display_name)).toHaveLength(1);

    const empty = stubFetch({
      photon: () => json({ features: [] }),
      nominatim: () => json([NOMINATIM_ROW]),
    });
    const t2 = fakeTime();
    const b = createExternalGeocoder({ fetchImpl: empty.fetchImpl, now: t2.now, sleep: t2.sleep });
    expect((await b.lookup("elena's")).map((h) => h.display_name)).toHaveLength(1);
    expect(empty.calls).toHaveLength(2);
  });

  it("takes the second throttle slot, so a cold miss costs one interval, not two timeouts", async () => {
    const { fetchImpl } = stubFetch({
      photon: () => json({ features: [] }),
      nominatim: () => json([NOMINATIM_ROW]),
    });
    const time = fakeTime();
    const ext = createExternalGeocoder({ fetchImpl, now: time.now, sleep: time.sleep });
    await ext.lookup("elena's");
    expect(time.sleeps).toEqual([1100]);
  });

  it("answers [] when both providers fail", async () => {
    const { fetchImpl } = stubFetch({
      photon: () => json({}, 500),
      nominatim: () => json({}, 429),
    });
    const time = fakeTime();
    const ext = createExternalGeocoder({ fetchImpl, now: time.now, sleep: time.sleep });
    expect(await ext.lookup("anything")).toEqual([]);
  });
});

describe("throttle, cache and in-flight collapse", () => {
  it("spaces outbound requests 1.1 s apart across queries", async () => {
    const { fetchImpl, calls } = stubFetch({ photon: () => json({ features: [ELENAS] }) });
    const time = fakeTime();
    const ext = createExternalGeocoder({ fetchImpl, now: time.now, sleep: time.sleep });
    await Promise.all([ext.lookup("one"), ext.lookup("two")]);
    expect(calls).toHaveLength(2);
    expect(time.sleeps).toEqual([1100]);
  });

  it("serves a repeat query from cache, per provider", async () => {
    const { fetchImpl, calls } = stubFetch({
      photon: () => json({ features: [] }),
      nominatim: () => json([]),
    });
    const time = fakeTime();
    const ext = createExternalGeocoder({ fetchImpl, now: time.now, sleep: time.sleep });
    await ext.lookup("nowhere");
    expect(calls).toHaveLength(2); // photon miss, nominatim miss
    await ext.lookup("nowhere");
    expect(calls).toHaveLength(2); // both misses remembered
  });

  it("does not cache a failure", async () => {
    let photonUp = false;
    const { fetchImpl, calls } = stubFetch({
      photon: () => (photonUp ? json({ features: [ELENAS] }) : json({}, 503)),
      nominatim: () => json({}, 503),
    });
    const time = fakeTime();
    const ext = createExternalGeocoder({ fetchImpl, now: time.now, sleep: time.sleep });
    expect(await ext.lookup("elenas")).toEqual([]);
    photonUp = true;
    expect(await ext.lookup("elenas")).toHaveLength(1);
    expect(calls.filter((u) => u.includes("photon"))).toHaveLength(2);
  });

  it("collapses concurrent identical lookups into one request", async () => {
    let resolve!: (r: Response) => void;
    const gate = new Promise<Response>((r) => { resolve = r; });
    const { fetchImpl, calls } = stubFetch({ photon: () => gate });
    const time = fakeTime();
    const ext = createExternalGeocoder({ fetchImpl, now: time.now, sleep: time.sleep });
    const a = ext.lookup("union station");
    const b = ext.lookup("union station");
    resolve(json({ features: [ELENAS] }));
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra).toEqual(rb);
    expect(calls).toHaveLength(1);
  });

  it("sheds a lookup whose queue slot falls outside the budget", async () => {
    const { fetchImpl, calls } = stubFetch({ photon: () => json({ features: [ELENAS] }) });
    const time = fakeTime();
    // The fake sleep advances the clock, so freeze it: slots then stack up
    // from one instant — 0, 1.1, 2.2, 3.3 s — and the fourth is past 2.5 s.
    const ext = createExternalGeocoder({
      fetchImpl,
      now: time.now,
      sleep: async () => {},
    });
    const results = await Promise.all(["a", "b", "c", "d"].map((q) => ext.lookup(q)));
    expect(results.map((r) => r.length)).toEqual([1, 1, 1, 0]);
    expect(calls).toHaveLength(3);
  });
});

describe("rankExternal", () => {
  const hit = (name: string, lat: number, lon: number): GeocodeV1Hit => ({
    display_name: name,
    lat,
    lon,
    type: "place",
    class: "osm",
  });

  it("drops anything past 2.5 km when a closer one exists, keeping the provider's order", () => {
    const far = hit("Branford Green, Branford", 41.2795, -72.8151); // ~10 km from any stop
    const mid = hit("East Rock Park, New Haven", 41.3305, -72.9075); // ~0.9 km from Orange / Canner
    const near = hit("Wooster Square, New Haven", 41.3045, -72.9165); // ~1 km from Chapel / York
    const out = rankExternal(network, [far, near, mid]);
    // Provider order, not distance order: the geocoder ranked by relevance.
    expect(out.map((h) => h.display_name.split(",")[0])).toEqual(["Wooster Square", "East Rock Park"]);
  });

  it("keeps far results when nothing is near — the rider may mean it", () => {
    const a = hit("Milford Green, Milford", 41.2225, -73.0565);
    const b = hit("Branford Green, Branford", 41.2795, -72.8151);
    expect(rankExternal(network, [a, b]).map((h) => h.display_name)).toEqual([a.display_name, b.display_name]);
  });

  it("collapses two hits with the same name within 150 m", () => {
    const node = hit("Stop & Shop, Whalley Avenue", 41.3151, -72.9382);
    const building = hit("Stop & Shop, Whalley Avenue, New Haven", 41.3153, -72.9385);
    // Same chain, different shop, still near the network: not a twin.
    const other = hit("Stop & Shop, Elm Street", 41.3065, -72.925);
    expect(rankExternal(network, [node, building, other])).toHaveLength(2);
  });

  it("is a no-op when the network has no stops yet", () => {
    const empty = TransitNetwork.build([], []);
    const a = hit("A", 41.3, -72.9);
    const b = hit("B", 41.4, -72.8);
    expect(rankExternal(empty, [b, a]).map((h) => h.display_name)).toEqual(["B", "A"]);
  });
});

/**
 * A destination pasted as a coordinate. This shipped broken for part of
 * 2026-09-03: Photon answers nothing for a bare coordinate, Nominatim
 * reverse-geocodes it to the nearest house, and the name-relevance filter
 * added that morning scored that house 0 against a query with no words in it
 * and dropped it — so `/api/geocode?q=41.296105,-72.955812` returned
 * `{"results":[]}` and the rider got no options at all. `walk-fallback-check`
 * (report #35's own regression harness) was red against production and, until
 * this commit, exited 0 while saying so.
 *
 * The fix does not touch the relevance filter — that guard is load-bearing.
 * A coordinate simply never reaches it.
 */
describe("a destination given as a coordinate", () => {
  const REPORT_35_DEST = { q: "41.296105,-72.955812", lat: 41.296105, lon: -72.955812 };

  it("answers the exact point, and asks no provider", async () => {
    let asked = 0;
    const external = { lookup: async () => { asked++; return []; } };
    const results = await geocodeV1(network, REPORT_35_DEST.q, external);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      lat: REPORT_35_DEST.lat,
      lon: REPORT_35_DEST.lon,
      class: "coordinate",
      type: "coordinate",
    });
    // The coordinate IS the answer; spending a throttled external lookup on it
    // would be both slower and less accurate (Nominatim's house was 127 m off).
    expect(asked).toBe(0);
  });

  it("never returns empty for a coordinate, whatever the providers do", async () => {
    for (const q of ["41.296105,-72.955812", "41.31, -72.93", " 41.3163,-72.925 ", "-33.8688,151.2093"]) {
      const results = await geocodeV1(network, q, { lookup: async () => [] });
      expect(results.length, q).toBeGreaterThan(0);
    }
  });

  it("does not hijack a query that merely contains digits", () => {
    // Anything here that parsed as a coordinate would stop reaching the
    // matcher: "800" is Building 800, and "517 Prospect St" is report #59/#69.
    for (const q of ["800", "517 Prospect St", "41.29", "-72.9", "1,2", "130 Prospect",
                     "Chapel / York", "25 Science Park", "41.29,", "abc,def"]) {
      expect(parseCoordinateQuery(q), q).toBeNull();
    }
  });

  it("accepts the spellings a rider actually pastes, and rejects impossible ones", () => {
    expect(parseCoordinateQuery("41.296105,-72.955812")).toEqual({ lat: 41.296105, lon: -72.955812 });
    expect(parseCoordinateQuery(" 41.296105 , -72.955812 ")).toEqual({ lat: 41.296105, lon: -72.955812 });
    expect(parseCoordinateQuery("+41.3,+72.9")).toEqual({ lat: 41.3, lon: 72.9 });
    // Out of range is not a coordinate; let the matcher have it.
    expect(parseCoordinateQuery("91.5,-72.9")).toBeNull();
    expect(parseCoordinateQuery("41.3,-181.2")).toBeNull();
  });

  it("still lets a street address reach the address path", async () => {
    // The address exemption and the coordinate path are separate mechanisms;
    // widening `looksLikeStreetAddress` to cover coordinates would have blurred
    // them, which is why it was not the fix.
    expect(looksLikeStreetAddress(REPORT_35_DEST.q)).toBe(false);
    expect(looksLikeStreetAddress("517 Prospect St")).toBe(true);
  });
});

describe("geocodeV1 merge", () => {
  it("puts local results first and drops an external twin within 60 m of one", async () => {
    // "station" is only a word match, so the external lookup still runs (a
    // rider may mean a place we do not list). The curated Union Station
    // absorbs the stop 50 m away; the external twin 30 m from it is noise.
    const union = STOPS[0]!;
    const external = {
      lookup: async () => [
        { display_name: "Union Station, Union Avenue, New Haven", lat: union.lat - 0.0002, lon: union.lon, type: "station", class: "osm" },
        { display_name: "Elena's on Orange, Orange Street, New Haven", lat: 41.323, lon: -72.9108, type: "ice_cream", class: "osm" },
      ],
    };
    const results = await geocodeV1(network, "station", external);
    expect(results.filter((r) => r.display_name.startsWith("Union Station"))).toHaveLength(1);
    expect(results[0]).toMatchObject({ class: "yale" });
    // The ice cream shop is dropped for a different reason — it is no answer
    // to "station" — so assert the dedup on the twin, which is the point here.
    expect(results.every((r) => !r.display_name.startsWith("Elena"))).toBe(true);
  });

  it("keeps the v1 class/type vocabulary for local hits", async () => {
    // `type` carries the place's category so the client can draw an icon;
    // `class` is what the frontend auto-picks on, and it does not move.
    const results = await geocodeV1(network, "SOM", { lookup: async () => [] });
    expect(results[0]).toMatchObject({ display_name: "School of Management (SOM)", type: "college", class: "yale" });
    const pizza = await geocodeV1(network, "pepes", { lookup: async () => [] });
    expect(pizza[0]).toMatchObject({ display_name: "Frank Pepe Pizzeria", type: "pizza", class: "yale" });
    const stop = await geocodeV1(network, "Chapel / York", { lookup: async () => [] });
    expect(stop[0]).toMatchObject({ display_name: "Chapel / York", type: "bus_stop", class: "shuttle" });
  });

  /**
   * Reported by the operator on 2026-09-03, three screenshots in a row:
   * "pepes" answered Frank Pepe Pizzeria AND "Pepe's Lawn Care" in West
   * Haven; "elenas" answered Elena's on Orange and a clothing shop called
   * EbLens; "trader joes" listed the Milford store beside the Hamden one
   * ("are there really two trader Joe's? this is confusing as a user").
   *
   * EVERY fixture below is Photon's real answer to that query, coordinates
   * included, captured on 2026-09-03 and re-measured against the checked-in
   * stop list. That matters: an earlier draft of this file invented a
   * coordinate for the Hamden Trader Joe's (41.372, -72.8985), measured it at
   * 1,590 m and asserted that the reach rule dropped it. Photon's actual node
   * is at 41.37523, -72.91366 — **286 m from the Aldi/Walmart stop**, which
   * route 18 serves. The test was green and the live server disagreed.
   *
   * So two of the three screenshots are answered here, by two rules that are
   * each needed:
   *   - REACH: Pepe's Lawn Care is 1,971 m from the nearest stop and Pepes
   *     Farm Road 2,224 m — past MAX_WALK_M, so no trip can be planned to
   *     them at all.
   *   - NAME: EbLens is 290 m from Elm / Lynwood, entirely reachable, and no
   *     answer to "elenas" under our own matcher. Distance can never catch it.
   *
   * The third is NOT a defect and is left alone: both Trader Joe's are within
   * walking range of a stop a Grocery run serves, so the honest answer to
   * "are there really two" is yes — see the test below.
   *
   * The rule that does NOT work, and was reverted before shipping: skipping
   * the external lookup whenever a local hit matched well. That hides real
   * places behind a curated one — "police" then answers only Yale Police and
   * buries the New Haven Police Department 64 m from the Union Station stop.
   */
  describe("the noise the operator photographed", () => {
    // The whole live network, because these rules are about DISTANCE to a
    // stop: the grocery runs reach Milford and Hamden, which is exactly why
    // "near the network" had to become "within walking range of a stop".
    const liveNetwork = TransitNetwork.build(liveStops as Stop[], [
      { id: 1, name: "Live", shortName: "L", color: "#000", stops: (liveStops as Stop[]).map((st) => st.id) },
    ]);
    const stub = (hits: GeocodeV1Hit[]) => {
      const ext = { calls: 0, lookup: async () => { ext.calls++; return hits; } };
      return ext;
    };
    const osm = (display_name: string, lat: number, lon: number, type = "yes"): GeocodeV1Hit =>
      ({ display_name, lat, lon, type, class: "osm" });

    it("answers 'pepes' with the pizzeria alone", async () => {
      // Photon's real four hits, with their measured distance to the nearest
      // live stop: a street in Orange twice (2,224 m / 1,764 m), the pizzeria
      // (295 m, which then dedups into the curated entry) and a lawn-care
      // business in West Haven (1,971 m). Everything past MAX_WALK_M goes,
      // because a reachable hit exists.
      const ext = stub([
        osm("Pepes Farm Road, Orange", 41.23139, -73.01915, "tertiary"),
        osm("Pepes Farm Road, Orange", 41.23592, -73.01337, "tertiary"),
        osm("Frank Pepe Pizzeria Napoletana, Wooster Street", 41.30296, -72.91696, "restaurant"),
        osm("Pepe's Lawn Care, 71 Lucey Avenue, West Haven", 41.24725, -72.96826, "gardener"),
      ]);
      const results = await geocodeV1(liveNetwork, "pepes", ext);
      expect(ext.calls).toBe(1);
      expect(results.map((r) => r.display_name)).toEqual(["Frank Pepe Pizzeria"]);
    });

    it("drops a clothing shop that merely looks like 'elenas'", async () => {
      // 290 m from Elm / Lynwood — reachable, so only the NAME can rule it
      // out, and "eblens" is no answer to "elenas" under our own matcher.
      const ext = stub([
        osm("Elena's on Orange, Orange Street, New Haven", 41.32295, -72.9108, "ice_cream"),
        osm("EbLens, Whalley Avenue, New Haven", 41.31359, -72.93508, "shoes"),
      ]);
      const results = await geocodeV1(liveNetwork, "elenas", ext);
      expect(ext.calls).toBe(1);
      // One row: the curated shop, with Photon's own node for it deduped away.
      expect(results.map((r) => r.display_name)).toEqual(["Elena's on Orange"]);
    });

    it("keeps the Hamden Trader Joe's, because a Grocery run stops 286 m away", async () => {
      // The screenshot the operator called confusing, and the one this change
      // does NOT make disappear. Photon's real nodes: Milford at 30 m from
      // the "Trader Joe's" stop (route 6 parks at the door) and Hamden at
      // 286 m from Aldi/Walmart (route 18) — a 3.5-minute walk, well inside
      // MAX_WALK_M. Both are plannable destinations, so both are true
      // answers; suppressing the second would need exactly the blanket rule
      // the review rejected. What the rider sees is two rows that name their
      // streets, not two rows reading "Trader Joe's".
      const ext = stub([
        osm("Trader Joe's, Boston Post Road, Milford", 41.25131, -73.01773, "supermarket"),
        osm("Trader Joe's, 46 Skiff Street, Hamden", 41.37523, -72.91366, "supermarket"),
      ]);
      const results = await geocodeV1(liveNetwork, "trader joes", ext);
      // The curated store comes first (local always does) and Photon's node
      // for it is deduped away, so the Milford store is one row, not two.
      expect(results.map((r) => r.display_name)).toEqual([
        "Trader Joe's (Milford)",
        "Trader Joe's, 46 Skiff Street, Hamden",
      ]);
    });

    it("keeps a real alternative that is near a stop and answers the query", async () => {
      // The regression the first attempt at this caused: a curated place must
      // not hide a genuine one. Photon's node for New Haven Police Department
      // is 270 m from the Union Station stop and is exactly what "police" can
      // mean; the shooting range 2,437 m out is not walkable and goes.
      const ext = stub([
        osm("New Haven Police Department, 1 Union Avenue", 41.30005, -72.92533, "police"),
        osm("New Haven Police Substation, Congress Avenue", 41.30014, -72.93882, "police"),
        osm("New Haven Police Shooting Range, New Haven", 41.33477, -72.95458, "yes"),
      ]);
      const results = await geocodeV1(liveNetwork, "police", ext);
      expect(ext.calls).toBe(1);
      // The curated Yale Police office still leads; it no longer hides them.
      expect(results[0]!.display_name).toBe("Yale Police (101 Ashmun)");
      expect(results.some((r) => r.display_name.startsWith("New Haven Police Department"))).toBe(true);
      expect(results.some((r) => r.display_name.includes("Shooting Range"))).toBe(false);
    });

    it("keeps another branch of a chain we curate one of", async () => {
      // Photon returns eight CVS nodes; the Hamden one at 203 m from a stop
      // is reachable and the ones 2–4.6 km out are not.
      const ext = stub([
        osm("CVS Pharmacy, Dixwell Avenue, Hamden", 41.36724, -72.91918, "pharmacy"),
        osm("CVS Pharmacy, Amity Road, Woodbridge", 41.32881, -72.96818, "chemist"),
        osm("CVS Pharmacy, Boston Post Road, East Haven", 41.28029, -72.87543, "chemist"),
      ]);
      const results = await geocodeV1(liveNetwork, "cvs", ext);
      expect(results[0]!.display_name).toBe("CVS (Church St)");
      expect(results.some((r) => r.display_name.includes("Dixwell"))).toBe(true);
      expect(results.some((r) => r.display_name.includes("East Haven"))).toBe(false);
    });

    it("still asks outside for a typo and for a half match", async () => {
      for (const q of ["peobody", "station", "lawn care"]) {
        const ext = stub([]);
        await geocodeV1(liveNetwork, q, ext);
        expect(ext.calls, q).toBe(1);
      }
    });

    it("still resolves a street address the curated list does not hold", async () => {
      // The relevance filter reads the name Photon returns, and an address IS
      // its name: "270 Crown Street" answers "270 crown" at the prefix tier.
      // A house is also what the frontend auto-picks on (type "house"), so
      // dropping one would break typing an address outright.
      const ext = stub([osm("270 Crown Street, New Haven", 41.30636, -72.93079, "house")]);
      const results = await geocodeV1(liveNetwork, "270 crown", ext);
      expect(ext.calls).toBe(1);
      expect(results.some((r) => r.display_name.startsWith("270 Crown Street"))).toBe(true);
    });

    it("keeps everything when nothing at all is within walking range", async () => {
      // The rider may genuinely mean somewhere far out; the filter drops the
      // unreachable only when a reachable answer exists.
      // Photon's real answer: 1,872 m, 1,712 m and 1,642 m from the nearest
      // stop — every one past MAX_WALK_M, and the rider still gets them.
      const ext = stub([
        osm("Yale Bowl, Chapel Street, New Haven", 41.31323, -72.96049, "stadium"),
        osm("Westville Music Bowl, Yale Avenue", 41.31184, -72.95739, "stadium"),
      ]);
      const results = await geocodeV1(liveNetwork, "yale bowl", ext);
      expect(results.some((r) => r.display_name.startsWith("Yale Bowl"))).toBe(true);
    });
  });

  it("skips the external lookup for queries under three characters", async () => {
    let asked = 0;
    await geocodeV1(network, "so", { lookup: async () => { asked++; return []; } });
    expect(asked).toBe(0);
  });

  it("caps the merged list at 12", async () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
      display_name: `Place ${i}, New Haven`,
      lat: 41.31 + i * 0.001,
      lon: -72.93,
      type: "place",
      class: "osm",
    }));
    const results = await geocodeV1(network, "place", { lookup: async () => many });
    expect(results).toHaveLength(12);
  });

  it("answers from local results alone when the provider times out", async () => {
    const { fetchImpl } = stubFetch({
      // Hangs until the budget aborts it; never answers on its own.
      photon: (_url, init) =>
        new Promise<Response>((_, reject) => {
          init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
      nominatim: () => json([]),
    });
    const ext = createExternalGeocoder({ fetchImpl, budgetMs: 40 });
    const started = Date.now();
    const results = await geocodeV1(network, "union station", ext);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => r.class !== "osm")).toBe(true);
  });
});

/**
 * Two invariants that span the server/client boundary, in the style this repo
 * already uses for the walk model and route colours: a value that drifts here
 * fails silently in front of a rider rather than loudly in CI.
 */
describe("what the server serves and the client can draw", () => {
  const clientSource = fs.readFileSync(
    new URL("../../web/src/format.ts", import.meta.url),
    "utf8",
  );

  it("has an icon for every category the landmark list ships", () => {
    // A `poi` with no entry in PLACE_ICONS falls back to the generic building
    // glyph — the very state the categories were added to remove, and
    // invisible unless somebody searches for that one place.
    const table = clientSource.match(/PLACE_ICONS[^{]*\{([\s\S]*?)\n\};/)![1]!;
    const iconKeys = new Set([...table.matchAll(/([a-z_]+):\s*"/g)].map((m) => m[1]!));
    expect(iconKeys.size).toBeGreaterThan(20);
    const unmapped = [...new Set(LANDMARKS.map((l) => l.poi).filter(Boolean))]
      .filter((poi) => !iconKeys.has(poi!));
    expect(unmapped, `no icon for: ${unmapped.join(", ")}`).toEqual([]);
  });

  it("keeps the external reach equal to the planner's walking limit", () => {
    // Past MAX_WALK_M the planner cannot offer a shuttle trip to the place at
    // all, so listing it only invites a rider to pick a destination the
    // shuttle does not serve.
    const walkSource = fs.readFileSync(
      new URL("../../web/src/walk.ts", import.meta.url),
      "utf8",
    );
    const maxWalk = Number(walkSource.match(/export const MAX_WALK_M = ([\d_]+)/)![1]!.replace(/_/g, ""));
    expect(maxWalk).toBeGreaterThan(0);
    expect(EXTERNAL_REACH_M).toBe(maxWalk);
  });
});

describe("a street address with a suffix (operator, 2026-09-03)", () => {
  // "destination lookup is broken I cant enter a street address like 517
  // Prospect". Measured against the live providers that day:
  //
  //   query              Photon                              Nominatim
  //   517 Prospect       (nothing)                           the house
  //   517 Prospect St    Prospect Hill, Prospect Hill        the house
  //                      Historic District, Prospect Hill
  //                      (a peak), Prospect Beach, two
  //                      Prospect Street centrelines
  //
  // Photon's answer to the suffixed query is non-empty and contains no
  // house, so the Nominatim fallback never fired and the rider got a beach.
  // Adding the suffix most people type broke the lookup.

  /** Photon's real reply to "517 Prospect St": places, no address. */
  const photonNoHouse = () => json({
    features: [
      photonFeature({ name: "Prospect Hill", city: "New Haven", osm_key: "place", osm_value: "neighbourhood", type: "locality" }, -72.9219, 41.3260),
      photonFeature({ name: "Prospect Beach", city: "West Haven", osm_key: "natural", osm_value: "beach", type: "other" }, -72.9600, 41.2500),
      photonFeature({ name: "Prospect Street", city: "New Haven", osm_key: "highway", osm_value: "secondary", type: "street" }, -72.9255, 41.3120),
    ],
  });

  /** Nominatim's real reply: the house, first try. */
  const nominatimHouse = () => json([
    {
      lat: "41.3264183",
      lon: "-72.9223693",
      display_name: "517, Prospect Street, Prospect Hill, East Rock, New Haven, Connecticut, 06511, United States",
      type: "house",
      class: "place",
    },
  ]);

  const geocoderFor = (photon: () => Response, nominatim: () => Response) => {
    const clock = fakeTime();
    const { fetchImpl, calls } = stubFetch({ photon: () => photon(), nominatim: () => nominatim() });
    return {
      calls,
      geocoder: createExternalGeocoder({ fetchImpl, now: clock.now, sleep: clock.sleep }),
    };
  };

  it("asks the other provider when an address query comes back with no address", async () => {
    const { geocoder, calls } = geocoderFor(photonNoHouse, nominatimHouse);
    const hits = await geocoder.lookup("517 Prospect St");
    // Both providers were asked, even though Photon answered.
    expect(calls.some((u) => u.includes("photon"))).toBe(true);
    expect(calls.some((u) => u.includes("nominatim"))).toBe(true);
    // The house the rider typed leads.
    expect(hits[0]!.type).toBe("house");
    expect(hits[0]!.display_name).toContain("517");
  });

  it("puts the house ahead of the places that merely share the street's words", async () => {
    const { geocoder } = geocoderFor(photonNoHouse, nominatimHouse);
    const network2 = network;
    const results = await geocodeV1(network2, "517 Prospect St", geocoder);
    const first = results[0]!;
    expect(first.display_name).toContain("517");
    // Photon's street centreline survives behind it — the beach does not,
    // because rankExternal drops what is out of reach of the network, which
    // is its job and not this fix's.
    expect(results.some((r) => r.display_name.includes("Prospect Street"))).toBe(true);
    expect(results.some((r) => r.display_name.includes("Beach"))).toBe(false);
  });

  it("does NOT spend a second request when Photon already found the address", async () => {
    const photonWithHouse = () => json({
      features: [
        photonFeature({ housenumber: "517", street: "Prospect Street", city: "New Haven", osm_key: "building", osm_value: "yes", type: "house" }, -72.9223693, 41.3264183),
      ],
    });
    const { geocoder, calls } = geocoderFor(photonWithHouse, nominatimHouse);
    const hits = await geocoder.lookup("517 Prospect St");
    expect(hits[0]!.type).toBe("house");
    expect(calls.some((u) => u.includes("nominatim"))).toBe(false);
  });

  it("leaves a place-name query on the single-provider path", async () => {
    // "elenas" is exactly why Photon is primary — it must not start costing
    // two outbound requests and two rate-limit slots.
    const photonElenas = () => json({ features: [ELENAS] });
    const { geocoder, calls } = geocoderFor(photonElenas, nominatimHouse);
    const hits = await geocoder.lookup("elenas");
    expect(hits[0]!.display_name).toContain("Elena");
    expect(calls.some((u) => u.includes("nominatim"))).toBe(false);
  });

  it("keeps Photon's places when neither provider finds the address", async () => {
    const emptyNominatim = () => json([]);
    const { geocoder } = geocoderFor(photonNoHouse, emptyNominatim);
    const hits = await geocoder.lookup("999999 Nowhere St");
    // Degrades to what there is rather than to nothing.
    expect(hits.length).toBeGreaterThan(0);
  });

  it("recognises what riders actually type as an address", () => {
    for (const q of ["517 Prospect", "517 Prospect St", "517 Prospect St.", "1 Prospect Street New Haven", "85 Howe"]) {
      expect(looksLikeStreetAddress(q)).toBe(true);
    }
    // A bare number is Building 800, a stop — the local matcher owns those.
    for (const q of ["800", "prospect", "trader joes", "  "]) {
      expect(looksLikeStreetAddress(q)).toBe(false);
    }
  });
});
