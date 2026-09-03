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
 *
 * `aliases` are the other names riders type for the same place — the campus
 * initialism ("KBT", "SOM"), the colloquial name ("the commons", "med
 * school"), the pre-renovation name. They exist because on 2026-09-02 the
 * live geocoder returned nothing for "kbt", "commons" and "medical school":
 * the matcher only saw the label, and "medical" is not a prefix of
 * "medicine". An alias scores exactly like the label (see `geocode.ts`), so
 * put a place's most-typed name here rather than stretching the label.
 */
export type Landmark = {
  label: string;
  lat: number;
  lon: number;
  aliases?: readonly string[];
};

export const LANDMARKS: readonly Landmark[] = [
  // -- Weekend grocery runs (report #45 asked for these by name) ------------
  // Coordinates are copied from the serving shuttle stops themselves (ids
  // 119, 169, 170), not hand-entered; the anchor test pins them there.
  { label: "Trader Joe's (Milford)", lat: 41.251375, lon: -73.018082 },
  { label: "ShopRite (Hamden)", lat: 41.36879, lon: -72.92047 },
  { label: "Aldi / Walmart (Hamden)", lat: 41.37512, lon: -72.91709 },

  // -- Central campus / downtown --------------------------------------------
  { label: "Sterling Memorial Library", lat: 41.3115, lon: -72.9282, aliases: ["sterling", "sml"] },
  { label: "Beinecke Library", lat: 41.3115, lon: -72.9272, aliases: ["beinecke"] },
  { label: "Bass Library", lat: 41.3110, lon: -72.9281 },
  { label: "Old Campus", lat: 41.3083, lon: -72.9282, aliases: ["old campus"] },
  // Was 41.3091,-72.9298 — east of York St, on the Old Campus block, and
  // reverse-geocoding it named no building at all. OSM's Davenport College
  // polygon (248 York St) sits 224 m NW, west of York between Chapel and Elm,
  // which is where the college actually is.
  { label: "Davenport College", lat: 41.3105, lon: -72.9317 },
  { label: "Woolsey Hall", lat: 41.3112, lon: -72.9262 },
  {
    label: "Schwarzman Center",
    lat: 41.3118,
    lon: -72.9264,
    aliases: ["commons", "the commons", "schwarzman"],
  },
  { label: "Yale Law School", lat: 41.3120, lon: -72.9278 },
  {
    label: "Yale University Art Gallery",
    lat: 41.3084,
    lon: -72.9309,
    aliases: ["yuag", "art gallery"],
  },
  {
    label: "Yale Center for British Art",
    lat: 41.3079,
    lon: -72.9309,
    aliases: ["ycba", "british art"],
  },
  // Was 41.3115,-72.9173 — 1.2 km east, which reverse-geocodes to 712 State
  // Street. The gym is 70 Tower Parkway, 44 m from our own "Payne Whitney Gym"
  // shuttle stop.
  {
    label: "Payne Whitney Gym",
    lat: 41.3137,
    lon: -72.9311,
    aliases: ["pwg", "the gym", "payne whitney"],
  },
  // Nominatim has no POI for Yale Health, so the curated list is the only way
  // a rider finds it. 55 Lock St, per the OSM address node.
  {
    label: "Yale Health Center",
    lat: 41.3157,
    lon: -72.9278,
    aliases: ["yale health", "health center"],
  },

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
  {
    label: "School of Management (SOM)",
    lat: 41.3152,
    lon: -72.9205,
    aliases: ["som", "yale som", "business school"],
  },
  // Was 41.3151,-72.9223 — 145 m SW, outside the museum footprint.
  { label: "Peabody Museum", lat: 41.3160, lon: -72.9211, aliases: ["peabody"] },
  { label: "Ingalls Rink", lat: 41.3168, lon: -72.9250 },
  // Renamed: the 2023 renovation dropped "Biology" (biology moved to the Yale
  // Science Building) and OSM now maps 219 Prospect as "Kline Tower". The old
  // name stays in the label so riders who still type it get a hit. The old
  // coordinate 41.3199,-72.9223 was ~300 m north, on Edwards Street.
  // The Marx Library opened inside the renovated tower, so its names land
  // here too.
  {
    label: "Kline Tower (Kline Biology Tower)",
    lat: 41.3172,
    lon: -72.9225,
    aliases: [
      "kbt",
      "kline biology tower",
      "marx library",
      "marx science and social science library",
    ],
  },
  { label: "Yale Science Building (YSB)", lat: 41.3174, lon: -72.9218 },
  { label: "Divinity School", lat: 41.3232, lon: -72.9225, aliases: ["div school", "yds"] },

  // -- Medical campus / south -----------------------------------------------
  // Report #14 got the *matching* fixed but not the coordinate: 41.3162,-72.9367
  // is 1.4 km NW, on Goffe Street. YSPH is 60 College St (LEPH), 52 m from the
  // "LEPH / 60 College" stop.
  {
    label: "School of Public Health (YSPH)",
    lat: 41.3037,
    lon: -72.9322,
    aliases: ["ysph", "public health"],
  },
  {
    label: "School of Medicine (YSM)",
    lat: 41.3032,
    lon: -72.9337,
    aliases: ["med school", "medical school", "ysm", "yale medical school"],
  },
  {
    label: "Yale-New Haven Hospital",
    lat: 41.3035,
    lon: -72.9358,
    aliases: ["ynhh", "hospital", "yale new haven hospital"],
  },
  {
    label: "Union Station",
    lat: 41.2974,
    lon: -72.9266,
    aliases: ["train station", "amtrak", "metro north"],
  },
];
