import type { TransitNetwork } from "../network/TransitNetwork.js";

/**
 * Lightweight geocoder over shuttle stops + a curated Yale landmark list.
 *
 * The v1 server combined this with Mapbox, Nominatim, and Photon for arbitrary
 * NYC-area addresses. That port is queued separately — most rider queries are
 * "Sterling", "SOM", "Peabody", which this covers without any external calls.
 *
 * Scoring is a simple containment match with a small bonus for prefix hits.
 * Results are sorted by score descending, then alphabetically. Empty query
 * returns the full landmark list — handy for "browse" interactions.
 */
export interface GeocodeHit {
  label: string;
  lat: number;
  lon: number;
  /** "stop" for shuttle stops, "landmark" for curated POIs. */
  kind: "stop" | "landmark";
  score: number;
}

/**
 * Yale-area landmarks the rider is likely to type into the trip planner.
 * Keep the list short and high-signal — a long list dilutes the ranking and
 * adds maintenance load.
 *
 * ⚠️ Hand-entered coordinates rot silently. Every entry here was audited on
 * 2026-08-31 against OpenStreetMap/Nominatim (forward AND reverse geocode) and
 * against the live shuttle stop network; seven of the original fourteen were
 * wrong, one by 1.2 km. `geocode.test.ts` now pins each landmark to the shuttle
 * stop that serves it, so the same drift fails the suite instead of sending a
 * rider across town. **If you add or move an entry, cross-check it externally
 * and add its anchor to that test** — do not eyeball it.
 */
export const LANDMARKS: ReadonlyArray<Omit<GeocodeHit, "score" | "kind">> = [
  // -- Weekend grocery runs (report #45 asked for these by name) ------------
  // Coordinates are copied from the serving shuttle stops themselves (ids
  // 119, 169, 170), not hand-entered; the anchor test pins them there.
  { label: "Trader Joe's (Milford)", lat: 41.251375, lon: -73.018082 },
  { label: "ShopRite (Hamden)", lat: 41.36879, lon: -72.92047 },
  { label: "Aldi / Walmart (Hamden)", lat: 41.37512, lon: -72.91709 },

  // -- Central campus / downtown --------------------------------------------
  { label: "Sterling Memorial Library", lat: 41.3115, lon: -72.9282 },
  { label: "Beinecke Library", lat: 41.3115, lon: -72.9272 },
  { label: "Bass Library", lat: 41.3110, lon: -72.9281 },
  { label: "Old Campus", lat: 41.3083, lon: -72.9282 },
  // Was 41.3091,-72.9298 — east of York St, on the Old Campus block, and
  // reverse-geocoding it named no building at all. OSM's Davenport College
  // polygon (248 York St) sits 224 m NW, west of York between Chapel and Elm,
  // which is where the college actually is.
  { label: "Davenport College", lat: 41.3105, lon: -72.9317 },
  { label: "Woolsey Hall", lat: 41.3112, lon: -72.9262 },
  { label: "Schwarzman Center", lat: 41.3118, lon: -72.9264 },
  { label: "Yale Law School", lat: 41.3120, lon: -72.9278 },
  { label: "Yale University Art Gallery", lat: 41.3084, lon: -72.9309 },
  { label: "Yale Center for British Art", lat: 41.3079, lon: -72.9309 },
  // Was 41.3115,-72.9173 — 1.2 km east, which reverse-geocodes to 712 State
  // Street. The gym is 70 Tower Parkway, 44 m from our own "Payne Whitney Gym"
  // shuttle stop.
  { label: "Payne Whitney Gym", lat: 41.3137, lon: -72.9311 },
  // Nominatim has no POI for Yale Health, so the curated list is the only way
  // a rider finds it. 55 Lock St, per the OSM address node.
  { label: "Yale Health Center", lat: 41.3157, lon: -72.9278 },

  // -- Science Hill / Prospect / Whitney ------------------------------------
  // Was 41.3168,-72.9234 — 481 m north, on Kroon Hall. Becton is 15 Prospect,
  // 22 m from the "Becton / 15 Prospect" stop.
  { label: "Becton Center", lat: 41.3127, lon: -72.9251 },
  // Was 41.3098,-72.9259 — 556 m south, on 51 Temple St. Rosenkranz is
  // 115 Prospect St.
  { label: "Rosenkranz Hall", lat: 41.3147, lon: -72.9246 },
  // Was 41.3163,-72.9209 — outside Evans Hall's footprint and reverse-geocoding
  // to the Kline Geology Laboratory next door. SOM is Evans Hall, 165 Whitney,
  // 32 m from the "SOM" stop.
  { label: "School of Management (SOM)", lat: 41.3152, lon: -72.9205 },
  // Was 41.3151,-72.9223 — 145 m SW, outside the museum footprint.
  { label: "Peabody Museum", lat: 41.3160, lon: -72.9211 },
  { label: "Ingalls Rink", lat: 41.3168, lon: -72.9250 },
  // Renamed: the 2023 renovation dropped "Biology" (biology moved to the Yale
  // Science Building) and OSM now maps 219 Prospect as "Kline Tower". The old
  // name stays in the label so riders who still type it get a hit. The old
  // coordinate 41.3199,-72.9223 was ~300 m north, on Edwards Street.
  { label: "Kline Tower (Kline Biology Tower)", lat: 41.3172, lon: -72.9225 },
  { label: "Yale Science Building (YSB)", lat: 41.3174, lon: -72.9218 },
  { label: "Divinity School", lat: 41.3232, lon: -72.9225 },

  // -- Medical campus / south -----------------------------------------------
  // Report #14 got the *matching* fixed but not the coordinate: 41.3162,-72.9367
  // is 1.4 km NW, on Goffe Street. YSPH is 60 College St (LEPH), 52 m from the
  // "LEPH / 60 College" stop.
  { label: "School of Public Health (YSPH)", lat: 41.3037, lon: -72.9322 },
  { label: "School of Medicine (YSM)", lat: 41.3032, lon: -72.9337 },
  { label: "Yale-New Haven Hospital", lat: 41.3035, lon: -72.9358 },
  { label: "Union Station", lat: 41.2974, lon: -72.9266 },
];

const MAX_RESULTS = 10;

export function geocode(network: TransitNetwork, rawQuery: string): GeocodeHit[] {
  const q = normalize(rawQuery);
  if (q.length === 0) {
    return LANDMARKS.map((l) => ({ ...l, kind: "landmark" as const, score: 0 }));
  }

  const out: GeocodeHit[] = [];
  for (const l of LANDMARKS) {
    const score = scoreMatch(q, normalize(l.label));
    if (score > 0) out.push({ ...l, kind: "landmark", score });
  }
  for (const stop of network.stops.values()) {
    const score = scoreMatch(q, normalize(stop.name));
    if (score > 0) {
      out.push({
        label: stop.name,
        lat: stop.lat,
        lon: stop.lon,
        kind: "stop",
        score,
      });
    }
  }

  out.sort((a, b) => b.score - a.score || a.label.localeCompare(b.label));

  // A curated landmark that IS a shuttle stop (the grocery destinations sit on
  // the stops' own coordinates) would otherwise appear twice — a rider typing
  // "trader joes" saw two identical options. When a landmark and a stop share
  // a spot, the LANDMARK survives regardless of score: its label carries more
  // information ("Trader Joe's (Milford)" vs "Trader Joe's"), and several
  // curated entries sit on their serving stops by design (SOM, Divinity).
  const near = (a: GeocodeHit, b: GeocodeHit) =>
    Math.abs(a.lat - b.lat) < 6e-4 && Math.abs(a.lon - b.lon) < 8e-4;
  const deduped: GeocodeHit[] = [];
  for (const h of out) {
    const twinIdx = deduped.findIndex((k) => near(k, h));
    if (twinIdx === -1) deduped.push(h);
    else if (h.kind === "landmark" && deduped[twinIdx]!.kind === "stop") deduped[twinIdx] = h;
  }
  return deduped.slice(0, MAX_RESULTS);
}

function normalize(s: string): string {
  return s
    .toLowerCase()
    // Apostrophes are deleted, not collapsed to spaces: "Joe's" must equal
    // "Joes", not "joe s" — a rider typing without the apostrophe found
    // nothing (report #45).
    .replace(/['\u2019]/g, "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Query tokens that carry no signal here — nearly everything a rider can type
 * is Yale's, so "yale school of public health" must match a label that never
 * mentions Yale.
 */
const STOPWORDS = new Set(["yale", "university", "the", "at"]);

/**
 * 1.0 for an exact match, 0.75 for prefix, 0.5 for any-word match, 0.4 when
 * every meaningful query token prefixes some candidate word (superset queries
 * like "yale school of public health"), 0.25 for substring, 0 otherwise.
 * Keeps the dialer simple while still putting `som` ahead of
 * "social some thing" — the more specific the hit, the higher.
 */
function scoreMatch(query: string, candidate: string): number {
  if (candidate === query) return 1;
  if (candidate.startsWith(query)) return 0.75;
  const words = candidate.split(" ");
  if (words.some((w) => w.startsWith(query))) return 0.5;
  const qTokens = query.split(" ").filter((t) => !STOPWORDS.has(t));
  if (
    qTokens.length > 0 &&
    qTokens.every((t) => words.some((w) => w.startsWith(t)))
  ) {
    return 0.4;
  }
  if (candidate.includes(query)) return 0.25;
  return 0;
}
