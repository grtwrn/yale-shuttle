import { describe, expect, it } from "vitest";

import { distanceMeters } from "../network/geo.js";
import { TransitNetwork } from "../network/TransitNetwork.js";
import type { Route, Stop } from "../schema/api.js";

import { geocode, LANDMARKS } from "./geocode.js";

/**
 * Guards against coordinate rot in the hand-curated landmark list.
 *
 * An audit on 2026-08-31 found seven of fourteen entries pointing at the wrong
 * place — Payne Whitney Gym was 1.2 km east on State Street, the School of
 * Public Health 1.4 km north-west on Goffe Street, Becton Center 481 m away on
 * Kroon Hall. None of that is visible by reading the file: the numbers look
 * plausible, they are all in New Haven, and the ranking tests pass either way.
 * The checks below encode the two things that are actually falsifiable without
 * a network call — the bounding box, and which shuttle stop serves each place.
 */

// A sample of real Downtowner stops, copied from the live /api/buses payload
// (`stop_coords` + `stop_names`) on 2026-08-31. Only the stops that serve a
// landmark are here; the point is to have independent, upstream-sourced
// reference points, not to mirror the whole 172-stop network.
const REFERENCE_STOPS: Stop[] = [
  { id: 4, name: "130 Prospect Street (S)", lat: 41.315161, lon: -72.924729 },
  { id: 119, name: "Trader Joe's", lat: 41.251375, lon: -73.018082 },
  { id: 169, name: "Shop Rite", lat: 41.36879, lon: -72.92047 },
  { id: 170, name: "Aldi/Walmart", lat: 41.37512, lon: -72.91709 },
  { id: 10, name: "333 Cedar", lat: 41.303254, lon: -72.934247 },
  { id: 20, name: "Becton / 15 Prospect", lat: 41.312609, lon: -72.925331 },
  { id: 33, name: "Chapel / York", lat: 41.30842, lon: -72.931341 },
  { id: 40, name: "College / Grove (N)", lat: 41.311805, lon: -72.925425 },
  { id: 42, name: "College / Wall (S)", lat: 41.310836, lon: -72.926148 },
  { id: 47, name: "Divinity / 409 Prospect", lat: 41.323538, lon: -72.923285 },
  { id: 51, name: "Elm / High", lat: 41.310194, lon: -72.928972 },
  { id: 53, name: "Elm / York (TYCO)", lat: 41.31086, lon: -72.93054 },
  { id: 67, name: "Wall / York", lat: 41.312102, lon: -72.928948 },
  { id: 72, name: "LEPH / 60 College", lat: 41.303422, lon: -72.931698 },
  { id: 74, name: "Lot 22 - Whitney / Humphrey", lat: 41.317907, lon: -72.920416 },
  { id: 96, name: "Payne Whitney Gym", lat: 41.313444, lon: -72.930694 },
  { id: 97, name: "Peabody Museum / Whitney / Sachem", lat: 41.315675, lon: -72.920859 },
  { id: 98, name: "Phelps Gate", lat: 41.308356, lon: -72.927978 },
  { id: 107, name: "Prospect / Sachem (S)", lat: 41.315795, lon: -72.924541 },
  { id: 113, name: "SCL", lat: 41.318189, lon: -72.923912 },
  { id: 114, name: "SOM", lat: 41.315224, lon: -72.920887 },
  { id: 121, name: "Union Station (N)", lat: 41.297857, lon: -72.926763 },
  { id: 149, name: "York / Cedar", lat: 41.303784, lon: -72.935017 },
  { id: 162, name: "Ashmun / Lock", lat: 41.31541, lon: -72.92892 },
];

const routes: Route[] = [
  {
    id: 1,
    name: "Reference",
    shortName: "R",
    color: "#000",
    stops: REFERENCE_STOPS.map((s) => s.id),
  },
];

const network = TransitNetwork.build(REFERENCE_STOPS, routes);

function nearestStop(p: { lat: number; lon: number }): { stop: Stop; meters: number } {
  let best: { stop: Stop; meters: number } | null = null;
  for (const stop of REFERENCE_STOPS) {
    const meters = distanceMeters(p, stop);
    if (!best || meters < best.meters) best = { stop, meters };
  }
  return best!;
}

describe("landmark coordinates", () => {
  // Generous enough to admit anywhere the Downtowner runs, tight enough that a
  // sign flip, a dropped digit, or a transposition lands outside it.
  // The SERVICE AREA box, not city limits: the weekend grocery runs
  // legitimately leave New Haven (Trader Joe's is in Milford, ShopRite and
  // Aldi/Walmart in Hamden), and their landmark entries sit on those stops.
  const NEW_HAVEN_BBOX = { minLat: 41.24, maxLat: 41.38, minLon: -73.03, maxLon: -72.88 };

  it.each(LANDMARKS.map((l) => [l.label, l] as const))(
    "%s is inside the New Haven bounding box",
    (_label, l) => {
      expect(l.lat).toBeGreaterThan(NEW_HAVEN_BBOX.minLat);
      expect(l.lat).toBeLessThan(NEW_HAVEN_BBOX.maxLat);
      expect(l.lon).toBeGreaterThan(NEW_HAVEN_BBOX.minLon);
      expect(l.lon).toBeLessThan(NEW_HAVEN_BBOX.maxLon);
    },
  );

  it("has no duplicate labels", () => {
    const seen = new Map<string, string>();
    for (const l of LANDMARKS) {
      const key = l.label.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
      expect(seen.get(key), `duplicate label: ${l.label}`).toBeUndefined();
      seen.set(key, l.label);
    }
  });

  // Two rows a rider cannot tell apart are worse than one row: identical
  // coordinates mean somebody pasted the wrong line.
  it("has no two landmarks stacked on the same spot", () => {
    for (let i = 0; i < LANDMARKS.length; i++) {
      for (let j = i + 1; j < LANDMARKS.length; j++) {
        const a = LANDMARKS[i]!;
        const b = LANDMARKS[j]!;
        expect(
          distanceMeters(a, b),
          `${a.label} and ${b.label} are on top of each other`,
        ).toBeGreaterThan(25);
      }
    }
  });

  // Every curated landmark is a place the shuttle exists to reach, so one of
  // its stops has to be walkable. A landmark stranded from the network is
  // either a bad coordinate or a destination this app cannot serve.
  it.each(LANDMARKS.map((l) => [l.label, l] as const))(
    "%s is within walking distance of the shuttle network",
    (_label, l) => {
      const { stop, meters } = nearestStop(l);
      expect(meters, `nearest reference stop is ${stop.name} at ${Math.round(meters)} m`)
        .toBeLessThan(400);
    },
  );

  /**
   * The sharp check. Each landmark is pinned to the stop that serves it —
   * usually the stop named after the place, or after its street address, so
   * the pairing is independently true rather than derived from the coordinate
   * it is testing. Six of the seven 2026-08 defects moved the landmark next to
   * the *wrong* stop; the seventh (Kline Tower) stayed nearest the right stop
   * but drifted to 233 m, which the distance bound catches.
   */
  const ANCHORS: ReadonlyArray<[label: string, stopName: string]> = [
    ["Old Campus", "Phelps Gate"],
    ["Trader Joe's (Milford)", "Trader Joe's"],
    ["ShopRite (Hamden)", "Shop Rite"],
    ["Aldi / Walmart (Hamden)", "Aldi/Walmart"],
    ["Davenport College", "Elm / York (TYCO)"],
    ["Payne Whitney Gym", "Payne Whitney Gym"],
    ["Yale Health Center", "Ashmun / Lock"],
    ["Becton Center", "Becton / 15 Prospect"],
    ["Rosenkranz Hall", "130 Prospect Street (S)"],
    ["School of Management (SOM)", "SOM"],
    ["Peabody Museum", "Peabody Museum / Whitney / Sachem"],
    ["Ingalls Rink", "Prospect / Sachem (S)"],
    ["Kline Tower (Kline Biology Tower)", "SCL"],
    ["Yale Science Building (YSB)", "Lot 22 - Whitney / Humphrey"],
    ["Divinity School", "Divinity / 409 Prospect"],
    ["School of Public Health (YSPH)", "LEPH / 60 College"],
    ["School of Medicine (YSM)", "333 Cedar"],
    ["Yale-New Haven Hospital", "York / Cedar"],
    ["Union Station", "Union Station (N)"],
    ["Yale University Art Gallery", "Chapel / York"],
    ["Yale Center for British Art", "Chapel / York"],
  ];

  it.each(ANCHORS)("%s is served by the %s stop", (label, stopName) => {
    const landmark = LANDMARKS.find((l) => l.label === label);
    expect(landmark, `no landmark labelled ${label}`).toBeDefined();
    const { stop, meters } = nearestStop(landmark!);
    expect(stop.name).toBe(stopName);
    expect(meters, `${label} is ${Math.round(meters)} m from ${stopName}`).toBeLessThan(200);
  });
});

describe("landmark search", () => {
  const labels = (q: string) => geocode(network, q).map((h) => h.label);

  it("returns the whole list for an empty query", () => {
    expect(geocode(network, "").length).toBe(LANDMARKS.length);
  });

  // Report #14: "yale school of public health" found nothing while
  // "school of public health" worked.
  it.each([
    ["peabody museum", "Peabody Museum"],
    ["yale peabody museum", "Peabody Museum"],
    ["payne whitney", "Payne Whitney Gym"],
    ["school of public health", "School of Public Health (YSPH)"],
    ["yale school of public health", "School of Public Health (YSPH)"],
    ["ysph", "School of Public Health (YSPH)"],
    ["som", "School of Management (SOM)"],
    ["yale som", "School of Management (SOM)"],
    ["med school", "School of Medicine (YSM)"],
    ["sterling", "Sterling Memorial Library"],
    ["art gallery", "Yale University Art Gallery"],
    ["british art", "Yale Center for British Art"],
    ["law school", "Yale Law School"],
    ["yale health", "Yale Health Center"],
    ["divinity", "Divinity School"],
    // The building lost "Biology" in the 2023 renovation; riders have not.
    ["kline tower", "Kline Tower (Kline Biology Tower)"],
    ["kline biology tower", "Kline Tower (Kline Biology Tower)"],
  ])("%o finds %o", (query, expected) => {
    expect(labels(query)).toContain(expected);
  });

  it("sends a rider searching the gym to Tower Parkway, not State Street", () => {
    const hit = geocode(network, "payne whitney gym").find(
      (h) => h.kind === "landmark" && h.label === "Payne Whitney Gym",
    );
    expect(hit).toBeDefined();
    // The "Payne Whitney Gym" shuttle stop is the ground truth for this one.
    expect(distanceMeters(hit!, REFERENCE_STOPS.find((s) => s.id === 96)!)).toBeLessThan(200);
  });

  it("still ranks the stop's location first on an exact stop-name match", () => {
    // Since the landmark/stop dedup, a stop that hosts a curated landmark is
    // one merged entry: the stop's RANK (first, for an exact name hit) with
    // the landmark's more informative label.
    const hits = geocode(network, "SOM");
    expect(hits[0]?.label).toBe("School of Management (SOM)");
    // The place itself is still the stop's coordinates.
    const stop = [...network.stops.values()].find((st) => st.name === "SOM")!;
    expect(Math.abs(hits[0]!.lat - stop.lat)).toBeLessThan(6e-4);
  });
});

describe("apostrophe-insensitive matching (report #45)", () => {
  it("finds Trader Joe's without the apostrophe", () => {
    const hits = geocode(network, "trader joes");
    expect(hits.some((h) => h.label.startsWith("Trader Joe's"))).toBe(true);
  });

  it("still finds it with the apostrophe, and with the curly variant", () => {
    for (const q of ["trader joe's", "trader joe\u2019s"]) {
      const hits = geocode(network, q);
      expect(hits.some((h) => h.label.startsWith("Trader Joe's"))).toBe(true);
    }
  });

  it("finds the Hamden groceries by store name", () => {
    expect(geocode(network, "shoprite").some((h) => h.label === "ShopRite (Hamden)")).toBe(true);
    expect(geocode(network, "aldi").some((h) => h.label === "Aldi / Walmart (Hamden)")).toBe(true);
  });
});

describe("landmark/stop dedup", () => {
  it("returns one entry when a landmark sits on its serving stop", () => {
    for (const q of ["trader joes", "shoprite", "aldi"]) {
      const hits = geocode(network, q);
      for (const h of hits) {
        const twins = hits.filter((k) =>
          Math.abs(k.lat - h.lat) < 6e-4 && Math.abs(k.lon - h.lon) < 8e-4);
        expect(twins).toHaveLength(1);
      }
    }
  });
});
