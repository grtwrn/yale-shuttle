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
 * Coordinates from public Google Maps lookups. Keep the list short and
 * high-signal — a long list dilutes the ranking and adds maintenance load.
 */
const LANDMARKS: ReadonlyArray<Omit<GeocodeHit, "score" | "kind">> = [
  { label: "Sterling Memorial Library", lat: 41.3115, lon: -72.9282 },
  { label: "Beinecke Library", lat: 41.3115, lon: -72.9272 },
  { label: "Bass Library", lat: 41.3110, lon: -72.9281 },
  { label: "School of Management (SOM)", lat: 41.3163, lon: -72.9209 },
  { label: "School of Public Health (YSPH)", lat: 41.3162, lon: -72.9367 },
  { label: "Peabody Museum", lat: 41.3151, lon: -72.9223 },
  { label: "Rosenkranz Hall", lat: 41.3098, lon: -72.9259 },
  { label: "Becton Center", lat: 41.3168, lon: -72.9234 },
  { label: "Kline Biology Tower", lat: 41.3199, lon: -72.9223 },
  { label: "Yale-New Haven Hospital", lat: 41.3035, lon: -72.9358 },
  { label: "Union Station", lat: 41.2974, lon: -72.9266 },
  { label: "Payne Whitney Gym", lat: 41.3115, lon: -72.9173 },
  { label: "Davenport College", lat: 41.3091, lon: -72.9298 },
  { label: "Old Campus", lat: 41.3083, lon: -72.9282 },
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
  return out.slice(0, MAX_RESULTS);
}

function normalize(s: string): string {
  return s
    .toLowerCase()
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
