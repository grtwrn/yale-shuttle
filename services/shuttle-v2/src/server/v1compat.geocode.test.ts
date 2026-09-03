import { describe, expect, it } from "vitest";

import { TransitNetwork } from "../network/TransitNetwork.js";
import type { Stop } from "../schema/api.js";

import {
  createExternalGeocoder,
  geocodeV1,
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

describe("geocodeV1 merge", () => {
  it("puts local results first and drops an external twin within 60 m of one", async () => {
    // The local hit for "union" is the curated landmark (it absorbs the
    // "Union Station (N)" stop 50 m away); put the external twin 30 m from it.
    const union = STOPS[0]!;
    const external = {
      lookup: async () => [
        { display_name: "Union Station, Union Avenue, New Haven", lat: union.lat - 0.0002, lon: union.lon, type: "station", class: "osm" },
        { display_name: "Elena's on Orange, Orange Street, New Haven", lat: 41.323, lon: -72.9108, type: "ice_cream", class: "osm" },
      ],
    };
    const results = await geocodeV1(network, "union", external);
    expect(results[0]).toMatchObject({ display_name: "Union Station", class: "yale", type: "landmark" });
    expect(results.filter((r) => r.display_name.startsWith("Union Station"))).toHaveLength(1);
    expect(results.at(-1)).toMatchObject({ display_name: "Elena's on Orange, Orange Street, New Haven", class: "osm" });
  });

  it("keeps the v1 class/type vocabulary for local hits", async () => {
    const results = await geocodeV1(network, "SOM", { lookup: async () => [] });
    expect(results[0]).toMatchObject({ display_name: "School of Management (SOM)", type: "landmark", class: "yale" });
    const stop = await geocodeV1(network, "Chapel / York", { lookup: async () => [] });
    expect(stop[0]).toMatchObject({ display_name: "Chapel / York", type: "bus_stop", class: "shuttle" });
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
