import { describe, expect, it } from "vitest";

import { distanceMeters } from "../network/geo.js";
import { TransitNetwork } from "../network/TransitNetwork.js";
import type { Route, Stop } from "../schema/api.js";

import { damerauLevenshtein, fuzzyWordMatch, geocode, LANDMARKS } from "./geocode.js";
import type { Landmark } from "./landmarks.js";
import liveStops from "./__fixtures__/stops.json";

// Every live stop (id, name, lat, lon) as served by /api/buses on 2026-09-02.
const LIVE_STOPS: Stop[] = liveStops as Stop[];

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

  // One entry per physical place: the same coordinates under two labels mean
  // somebody pasted the wrong line, or entered a nickname as a second place
  // instead of an alias. Distinct places CAN be metres apart (a cafe in a
  // museum's ground floor, a bookshop next to the Apple Store), so the bound
  // is 'same point', not 'same block'.
  it("has no two landmarks stacked on the same spot", () => {
    for (let i = 0; i < LANDMARKS.length; i++) {
      for (let j = i + 1; j < LANDMARKS.length; j++) {
        const a = LANDMARKS[i]!;
        const b = LANDMARKS[j]!;
        expect(
          distanceMeters(a, b),
          `${a.label} and ${b.label} are on top of each other`,
        ).toBeGreaterThan(5);
      }
    }
  });

  // An alias is another name for the SAME place; the same alias on two
  // entries would make one of them unreachable by that name. A few are
  // shared on purpose ("science hill" spans two buildings, "pharmacy" is
  // three shops) — list them here so an accidental clash still fails.
  it("does not reuse an alias across entries, except the deliberate ones", () => {
    const SHARED = new Set(["science hill", "pharmacy", "new colleges", "drugstore", "grocery", "grocery store", "supermarket"]);
    const owner = new Map<string, string>();
    for (const l of LANDMARKS) {
      for (const a of l.aliases ?? []) {
        const key = a.toLowerCase();
        if (SHARED.has(key)) continue;
        expect(owner.get(key), `alias ${a} is on both ${owner.get(key)} and ${l.label}`).toBeUndefined();
        owner.set(key, l.label);
      }
    }
  });

  /**
   * The sharp check, now for every entry. Each landmark carries the name of
   * the live stop that serves it (`anchorStop`), and the nearest stop in the
   * full 172-stop network (checked-in fixture, captured from /api/buses on
   * 2026-09-02) has to BE that stop, within walking distance. Six of the
   * seven 2026-08 defects moved the landmark next to the *wrong* stop; the
   * seventh (Kline Tower) stayed nearest the right stop but drifted to 233 m,
   * which the distance bound catches.
   */
  const nearestLiveStop = (p: { lat: number; lon: number }): { stop: Stop; meters: number } => {
    let best: { stop: Stop; meters: number } | null = null;
    for (const stop of LIVE_STOPS) {
      const meters = distanceMeters(p, stop);
      if (!best || meters < best.meters) best = { stop, meters };
    }
    return best!;
  };

  it.each(LANDMARKS.map((l) => [l.label, l.anchorStop, l] as const))(
    "%s is served by the %s stop",
    (label, stopName, landmark) => {
      expect(LIVE_STOPS.some((s) => s.name === stopName), `no live stop named ${stopName}`).toBe(true);
      const { stop, meters } = nearestLiveStop(landmark);
      expect(stop.name, `${label} is nearest ${stop.name} (${Math.round(meters)} m), not ${stopName}`).toBe(stopName);
      expect(meters, `${label} is ${Math.round(meters)} m from ${stopName}`).toBeLessThan(500);
    },
  );
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

/**
 * Measured live on 2026-09-02 against GET /api/geocode: "elenas" found
 * nothing while "elena's" did, "stop and shop" found nothing server-side,
 * "kbt"/"commons"/"medical school" found nothing, and "audubon" could not
 * reach the upstream-misspelt "Orange / Audobon". Each case below is one of
 * those, run against fixtures rather than the rider-facing list so the
 * curated landmarks stay verified data.
 */
describe("robust matching (2026-09-02 live probe)", () => {
  // Real upstream stop names, typos included — we may not hand-edit them.
  const TYPO_STOPS: Stop[] = [
    { id: 76, name: "Orange / Audobon", lat: 41.310923, lon: -72.920191 },
    { id: 116, name: "Stop & Shop", lat: 41.315041, lon: -72.938202 },
    { id: 131, name: "Whitney / Cold Springs (N)", lat: 41.325918, lon: -72.915845 },
    { id: 115, name: "State St Station", lat: 41.30443, lon: -72.92164 },
    { id: 17, name: "Amistand / Cedar Weekend Blue", lat: 41.300259, lon: -72.932555 },
    { id: 157, name: "Elm / Orange", lat: 41.30742, lon: -72.92249 },
  ];
  const stops = [...REFERENCE_STOPS, ...TYPO_STOPS];
  const typoNetwork = TransitNetwork.build(stops, [
    { id: 1, name: "Reference", shortName: "R", color: "#000", stops: stops.map((s) => s.id) },
  ]);

  const FIXTURE_LANDMARKS: Landmark[] = [
    { label: "Elena's on Orange", lat: 41.323, lon: -72.9108, anchorStop: "" },
    { label: "One 6 Three", lat: 41.32108, lon: -72.90911, aliases: ["one6three", "163", "one six three", "163 pizza", "one 6 three pizza"], anchorStop: "" },
    // Confusables: a three-letter query must never fuzzy-match into these.
    { label: "Sass Hall", lat: 41.31, lon: -72.93, anchorStop: "" },
    { label: "Some Place", lat: 41.312, lon: -72.931, anchorStop: "" },
    // Label and alias share nothing, so a hit on one is provably via that one.
    { label: "Alpha Building", lat: 41.314, lon: -72.929, aliases: ["zeta hall"], anchorStop: "" },
  ];

  const hits = (q: string) => geocode(typoNetwork, q, FIXTURE_LANDMARKS);
  const labels = (q: string) => hits(q).map((h) => h.label);
  const scoreOf = (q: string, label: string) => hits(q).find((h) => h.label === label)?.score;

  it.each(["elenas", "elena's", "elena’s", "élenas", "Elenas on Orange"])(
    "%o finds the apostrophe'd landmark",
    (q) => {
      expect(labels(q)).toContain("Elena's on Orange");
    },
  );

  // Report #69: "can't find one6three pizza, or when written as 163. this
  // should be a landmark". The name is a number spelled three ways and OSM
  // carries only one of them, so the aliases are the whole fix — the curated
  // entry is verified (Photon forward, Nominatim reverse: OSM N3099233997,
  // 43 m from the Willow / Foster stop).
  it.each(["one6three", "163", "one six three", "163 pizza", "One6Three"])(
    "%o finds the pizza place whose name is a number",
    (q) => {
      expect(labels(q)).toContain("One 6 Three");
    },
  );

  it.each(["stop and shop", "stop & shop", "stop&shop", "Stop and Shop"])(
    "%o ranks the Stop & Shop stop first",
    (q) => {
      expect(labels(q)[0]).toBe("Stop & Shop");
    },
  );

  it("reaches the misspelt upstream stop names by their correct spelling", () => {
    expect(labels("audubon")).toContain("Orange / Audobon");
    expect(labels("amistad")).toContain("Amistand / Cedar Weekend Blue");
    expect(labels("cold spring")).toContain("Whitney / Cold Springs (N)");
  });

  it("scores a typo below every prefix tier", () => {
    // "Orange / Audobon" is a fuzzy hit; a candidate that genuinely contains
    // the word sits above it.
    expect(scoreOf("audubon", "Orange / Audobon")).toBe(0.3);
    expect(scoreOf("audubon", "Orange / Audobon")!).toBeLessThan(
      scoreOf("amistand", "Amistand / Cedar Weekend Blue")!,
    );
  });

  it.each([
    ["medical school", "School of Medicine (YSM)"],
    ["commons", "Schwarzman Center"],
    ["the commons", "Schwarzman Center"],
    ["kbt", "Kline Tower (Kline Biology Tower)"],
    ["marx library", "Kline Tower (Kline Biology Tower)"],
    ["ynhh", "Yale-New Haven Hospital"],
    ["new haven hospital", "Yale-New Haven Hospital"],
    ["train station", "Union Station"],
    ["business school", "School of Management (SOM)"],
  ])("%o ranks %o first via an alias", (q, expected) => {
    expect(geocode(network, q)[0]?.label).toBe(expected);
  });

  it("never fuzzy-matches a short token", () => {
    expect(fuzzyWordMatch("sss", "sass")).toBe(false);
    expect(fuzzyWordMatch("som", "some")).toBe(false);
    expect(fuzzyWordMatch("kbt", "kbtx")).toBe(false);
    expect(fuzzyWordMatch("somm", "some")).toBe(false);
    expect(labels("sss")).toEqual([]);
    expect(labels("somm")).toEqual([]);
  });

  it("allows one edit from five letters and two from eight", () => {
    expect(fuzzyWordMatch("audubon", "audobon")).toBe(true);
    expect(fuzzyWordMatch("peobody", "peabody")).toBe(true); // adjacent swap
    expect(fuzzyWordMatch("steling", "sterling")).toBe(true);
    expect(fuzzyWordMatch("biencke", "beinecke")).toBe(false); // 7 letters, 2 edits
    expect(fuzzyWordMatch("shwartzman", "schwarzman")).toBe(true); // 10 letters, 2 edits
    expect(fuzzyWordMatch("shwarzmen", "schwarzman")).toBe(true);
    expect(fuzzyWordMatch("shwarzmenn", "schwarzman")).toBe(false); // 3 edits
    expect(damerauLevenshtein("ca", "abc", 3)).toBe(3); // OSA, not unrestricted
  });

  it("scores an alias exactly like the label", () => {
    expect(scoreOf("zeta hall", "Alpha Building")).toBe(scoreOf("alpha building", "Alpha Building"));
    expect(scoreOf("zeta", "Alpha Building")).toBe(scoreOf("alpha", "Alpha Building"));
    expect(scoreOf("hall zeta", "Alpha Building")).toBe(scoreOf("building alpha", "Alpha Building"));
    expect(scoreOf("zeta hall", "Alpha Building")).toBe(1);
  });

  // "st"/"street" are query stopwords so "orange st" lists the Orange Street
  // stops; that must not cost a stop that spells "St" in its own name.
  it("drops street suffixes from the query without losing street-named stops", () => {
    expect(labels("orange st")).toEqual(expect.arrayContaining(["Orange / Audobon", "Elm / Orange"]));
    expect(labels("orange street")).toContain("Orange / Audobon");
    expect(labels("state st station")[0]).toBe("State St Station");
    expect(labels("state st")[0]).toBe("State St Station");
    expect(labels("State St Station")[0]).toBe("State St Station");
  });

  it("still ranks every fixture stop first when typed verbatim", () => {
    for (const s of stops) {
      const top = geocode(typoNetwork, s.name, FIXTURE_LANDMARKS)[0]!;
      const merged = top.kind === "landmark" &&
        Math.abs(top.lat - s.lat) < 6e-4 && Math.abs(top.lon - s.lon) < 8e-4;
      expect(top.label === s.name || merged, `${s.name} -> ${top.label}`).toBe(true);
    }
  });
});

/**
 * The rider-facing list against the whole live network. The fixture tests
 * above use a handful of stops, which is how a 2026-09-02 review found that
 * with 148 landmarks most sit inside some stop's dedup box and a landmark
 * could take the stop's row whatever its score: "howe" returned only
 * Mamoun's (alias "85 howe") and the frontend auto-picked it.
 */
describe("the real list against every live stop", () => {
  const live = TransitNetwork.build(LIVE_STOPS, [
    { id: 1, name: "Live", shortName: "L", color: "#000", stops: LIVE_STOPS.map((s) => s.id) },
  ]);
  const top = (q: string) => geocode(live, q)[0];
  const norm = (s: string) => s.toLowerCase();

  it.each([
    "howe", "broadway", "crown", "york", "chapel", "cottage", "munson", "ashmun", "howard",
    "cedar", "orange st", "college st", "temple", "winchester", "whitney", "prospect",
  ])("%o ranks a stop on that street first", (q) => {
    const hit = top(q)!;
    const word = q.split(" ")[0]!;
    // A landmark placed ON one of those stops may carry the merged row
    // (Blue State Coffee sits on the 300 Cedar stop); a landmark elsewhere
    // may not.
    const stopUnder = LIVE_STOPS.find((st) =>
      norm(st.name).includes(word) &&
      Math.abs(st.lat - hit.lat) < 3.6e-4 && Math.abs(st.lon - hit.lon) < 4.8e-4);
    expect(hit.kind === "stop" || stopUnder !== undefined, `${q} -> ${hit.label}`).toBe(true);
    expect(norm(hit.label)).toContain(word);
  });

  it("a bare number is a stop, not an address alias", () => {
    // "800" used to resolve to the Yale Physicians Building (alias "800
    // howard") ahead of the Building 800 stop, 6.6 km away, and the
    // frontend auto-picks a landmark on Enter.
    expect(top("800")?.label).toBe("Building 800");
    expect(top("60")?.label).toBe("Building 600");
    expect(top("800 howard")?.label).toBe("Yale Physicians Building");
  });

  it("a match on the label outranks the same score through an alias", () => {
    // Mid-typing "sterlin": two LABELS start with it (the library and the
    // chemistry lab); Divinity School, YSM and friends only have an alias
    // that does, and used to tie with them alphabetically.
    const labels = geocode(live, "sterlin").map((h) => h.label);
    expect(labels.slice(0, 2)).toEqual(expect.arrayContaining(["Sterling Memorial Library"]));
    expect(labels.indexOf("Divinity School")).toBeGreaterThan(labels.indexOf("Sterling Memorial Library"));
  });

  it("a street word alone does not reach an address alias", () => {
    // "1000 chapel" is an alias of Claire's; "chapel" must not surface it.
    expect(geocode(live, "chapel").some((h) => h.label.startsWith("Claire"))).toBe(false);
    // ...but the address itself does.
    expect(geocode(live, "1000 chapel")[0]?.label.startsWith("Claire")).toBe(true);
  });

  it.each([
    ["phelps", "Phelps Gate"],
    ["mamouns", "Mamoun's Falafel"],
    ["union station", "Union Station"],
    ["bf", "Benjamin Franklin College"],
    ["mc", "Morse College"],
    ["peabody", "Peabody Museum"],
    ["stop and shop", "Stop & Shop (Whalley Ave)"],
  ])("%o -> %o", (q, label) => {
    expect(top(q)?.label).toBe(label);
  });

  /**
   * The queries riders actually type, against the real list and the real
   * network. This is the check the operator asked for after finding "pepes"
   * answering with a lawn-care business: it is the top ROW of the dropdown,
   * so a landmark that quietly loses its query to a stop, an alias clash or
   * a new entry shows up here rather than in a screenshot.
   */
  it.each([
    // eateries — the icon vocabulary hangs off these too
    ["pepes", "Frank Pepe Pizzeria"],
    ["frank pepe", "Frank Pepe Pizzeria"],
    ["sallys", "Sally's Apizza"],
    ["modern apizza", "Modern Apizza"],
    ["yorkside", "Yorkside Pizza"],
    ["elenas", "Elena's on Orange"],
    ["ashleys", "Ashley's Ice Cream"],
    ["insomnia", "Insomnia Cookies"],
    ["shake shack", "Shake Shack"],
    ["louis lunch", "Louis' Lunch"],
    ["junzi", "Junzi Kitchen"],
    ["mamouns", "Mamoun's Falafel"],
    ["claires", "Claire's Corner Copia"],
    ["atticus", "Atticus Bookstore Cafe"],
    ["blue state", "Blue State Coffee (Cedar St)"],
    ["koffee", "Koffee?"],
    ["book trader", "Book Trader Cafe"],
    ["toads", "Toad's Place"],
    ["archies", "Archie Moore's"],
    // shops and groceries
    ["stop and shop", "Stop & Shop (Whalley Ave)"],
    ["trader joes", "Trader Joe's (Milford)"],
    ["elm city market", "Elm City Market"],
    ["nicas", "Nica's Market"],
    ["cvs", "CVS (Church St)"],
    ["walgreens", "Walgreens (York St)"],
    ["apple store", "Apple Store (Broadway)"],
    ["yale bookstore", "Yale Bookstore"],
    // libraries, museums, campus
    ["sterling", "Sterling Memorial Library"],
    ["bass library", "Bass Library"],
    ["beinecke", "Beinecke Library"],
    ["kbt", "Kline Tower (Kline Biology Tower)"],
    ["marx library", "Kline Tower (Kline Biology Tower)"],
    ["peabody", "Peabody Museum"],
    ["art gallery", "Yale University Art Gallery"],
    ["british art", "Yale Center for British Art"],
    ["commons", "Schwarzman Center"],
    ["payne whitney", "Payne Whitney Gym"],
    ["ingalls", "Ingalls Rink"],
    ["old campus", "Old Campus"],
    ["cross campus", "Cross Campus"],
    ["branford", "Branford College"],
    ["pauli murray", "Pauli Murray College"],
    ["sss", "Sheffield-Sterling-Strathcona Hall (SSS)"],
    ["wlh", "William L. Harkness Hall (WLH)"],
    ["hgs", "Humanities Quadrangle (HQ)"],
    ["becton", "Becton Center"],
    ["evans hall", "School of Management (SOM)"],
    ["som", "School of Management (SOM)"],
    ["med school", "School of Medicine (YSM)"],
    ["law school", "Yale Law School"],
    ["ysb", "Yale Science Building (YSB)"],
    // health, transit, outdoors, venues
    ["yale health", "Yale Health Center"],
    ["ynhh", "Yale-New Haven Hospital"],
    ["smilow", "Smilow Cancer Hospital"],
    ["union station", "Union Station"],
    ["state street station", "State Street Station"],
    ["new haven green", "New Haven Green"],
    ["wooster square", "Wooster Square"],
    ["grove street cemetery", "Grove Street Cemetery"],
    ["shubert", "Shubert Theatre"],
    ["criterion", "Criterion Cinemas"],
    ["omni", "Omni New Haven Hotel"],
    ["the study", "The Study at Yale"],
    ["city hall", "New Haven City Hall"],
    ["public library", "New Haven Free Public Library"],
    ["slifka", "Slifka Center"],
    ["dwight hall", "Dwight Hall"],
    ["admissions", "Undergraduate Admissions (38 Hillhouse)"],
  ])("a rider typing %o gets %o first", (q, expected) => {
    expect(top(q)?.label).toBe(expected);
  });

  it("every curated place carries a category for its icon", () => {
    // `poi` is what `suggIcon` turns into 🍕 / 🍦 / 📚; an entry without one
    // falls back to the generic building glyph, which is the state this
    // replaced.
    const missing = LANDMARKS.filter((l) => !l.poi).map((l) => l.label);
    expect(missing).toEqual([]);
  });

  it("carries the category through to the hit", () => {
    expect(top("pepes")?.poi).toBe("pizza");
    expect(top("elenas")?.poi).toBe("ice_cream");
    expect(top("koffee")?.poi).toBe("cafe");
    expect(top("bass library")?.poi).toBe("library");
    // A stop is a stop; the bus-stop icon does not come from this field.
    expect(top("phelps gate")?.poi).toBeUndefined();
  });

  it("ranks every live stop name first when typed verbatim", () => {
    for (const s of LIVE_STOPS) {
      const hit = top(s.name)!;
      const merged = hit.kind === "landmark" &&
        Math.abs(hit.lat - s.lat) < 6e-4 && Math.abs(hit.lon - s.lon) < 8e-4;
      expect(hit.label === s.name || merged, `${s.name} -> ${hit.label}`).toBe(true);
    }
  });
});
