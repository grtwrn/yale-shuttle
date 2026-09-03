import type { TransitNetwork } from "../network/TransitNetwork.js";
import { LANDMARKS, type Landmark } from "./landmarks.js";

// The curated list moved to landmarks.ts (it is replaced wholesale by a
// verified list); callers that imported it from here keep working.
export { LANDMARKS };
export type { Landmark };

/**
 * Lightweight geocoder over shuttle stops + a curated Yale landmark list.
 *
 * Most rider queries are "Sterling", "SOM", "Peabody", which this answers
 * without any external call; `v1compat.ts` appends Photon/Nominatim results
 * for everything else. Results are sorted by score descending, then
 * alphabetically. Empty query returns the full landmark list — handy for
 * "browse" interactions.
 */
export interface GeocodeHit {
  label: string;
  lat: number;
  lon: number;
  /** "stop" for shuttle stops, "landmark" for curated POIs. */
  kind: "stop" | "landmark";
  score: number;
}

const MAX_RESULTS = 10;

/**
 * `landmarks` is injectable so the matcher can be tested against fixtures
 * (an apostrophe'd shop, a deliberately confusable name) without adding
 * entries to the rider-facing list.
 */
export function geocode(
  network: TransitNetwork,
  rawQuery: string,
  landmarks: readonly Landmark[] = LANDMARKS,
): GeocodeHit[] {
  const query = parseQuery(rawQuery);
  if (query === null) {
    return landmarks.map((l) => ({
      label: l.label,
      lat: l.lat,
      lon: l.lon,
      kind: "landmark" as const,
      score: 0,
    }));
  }

  const out: GeocodeHit[] = [];
  for (const l of landmarks) {
    // A landmark answers to its label AND every alias, and the best of them
    // counts: "kbt" must rank Kline Tower exactly as "kline tower" does.
    let score = 0;
    for (const name of [l.label, ...(l.aliases ?? [])]) {
      score = Math.max(score, scoreMatch(query, candidate(name)));
      if (score === 1) break;
    }
    if (score > 0) out.push({ label: l.label, lat: l.lat, lon: l.lon, kind: "landmark", score });
  }
  for (const stop of network.stops.values()) {
    const score = scoreMatch(query, candidate(stop.name));
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

// -- Normalisation ------------------------------------------------------------

/**
 * Both sides of every comparison go through this, so a rider's spelling and
 * the upstream name only have to agree after the noise is gone.
 */
export function normalizeName(s: string): string {
  return (
    s
      .toLowerCase()
      // Apostrophes are deleted, not collapsed to spaces: "Joe's" must equal
      // "Joes", not "joe s" — a rider typing without the apostrophe found
      // nothing (report #45), and the operator hit the same wall with
      // "elenas" on 2026-09-02.
      .replace(/['‘’]/g, "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      // The upstream stop is "Stop & Shop"; riders type "stop and shop".
      .replace(/&/g, " and ")
      .replace(/[^a-z0-9]+/g, " ")
      .trim()
  );
}

/**
 * Query tokens that carry no signal here — nearly everything a rider can
 * type is Yale's, in New Haven, so "yale school of public health" must match
 * a label that never mentions Yale (report #14) and "stop and shop" must
 * survive its conjunction. "st"/"street" are here because upstream names
 * spell streets three ways ("130 Prospect Street", "State St Station",
 * "Orange / Audobon") and a rider typing "orange st" found nothing: no stop
 * has a word beginning with "st" after "orange". Dropping them from the QUERY
 * only is safe — every one of the 172 live stop names typed verbatim still
 * ranks itself first (the exact/prefix tiers see the untouched query).
 */
const STOPWORDS = new Set([
  "yale", "university", "the", "at", "of", "on", "in", "and", "new", "haven", "st", "street",
]);

interface Query {
  /** The full normalised query. */
  text: string;
  /** The query with stopwords removed, as text ("" when nothing survives). */
  stripped: string;
  /** Tokens the tiers below must account for, stopwords removed. */
  tokens: string[];
}

function parseQuery(raw: string): Query | null {
  const text = normalizeName(raw);
  if (text.length === 0) return null;
  const all = text.split(" ");
  const meaningful = all.filter((t) => !STOPWORDS.has(t));
  // "new haven" alone is all stopwords; better to match on them than on
  // nothing.
  const tokens = meaningful.length > 0 ? meaningful : all;
  const stripped = meaningful.join(" ");
  return { text, stripped, tokens };
}

interface Candidate {
  text: string;
  words: string[];
}

function candidate(name: string): Candidate {
  const text = normalizeName(name);
  return { text, words: text.split(" ") };
}

// -- Scoring ------------------------------------------------------------------

/**
 * Tiers, highest first. Each is tried against the whole query and, where it
 * differs, the stopword-stripped one, so "the commons" and "commons" score
 * alike:
 *
 *  1.0  exact        — the candidate is the query
 *  0.75 prefix       — the candidate starts with the query ("state st" →
 *                      "State St Station")
 *  0.5  word-prefix  — some candidate word starts with the query ("peabody"
 *                      → "Peabody Museum / Whitney / Sachem")
 *  0.4  token-prefix — every meaningful query token prefixes some candidate
 *                      word, any order ("yale peabody museum")
 *  0.3  fuzzy        — as token-prefix, but a token may instead be a typo of
 *                      a candidate word; see {@link fuzzyWordMatch} for the
 *                      length rule. This is how "audubon" reaches the
 *                      upstream-misspelt "Orange / Audobon" (which we may not
 *                      edit) and "peobody" reaches the museum.
 *  0.25 substring    — the query appears anywhere in the candidate
 *
 * The more specific the hit, the higher, which keeps `som` ahead of
 * "social some thing".
 */
function scoreMatch(q: Query, c: Candidate): number {
  const forms = q.stripped.length > 0 && q.stripped !== q.text ? [q.text, q.stripped] : [q.text];
  if (forms.some((f) => c.text === f)) return 1;
  if (forms.some((f) => c.text.startsWith(f))) return 0.75;
  if (forms.some((f) => c.words.some((w) => w.startsWith(f)))) return 0.5;
  if (q.tokens.every((t) => c.words.some((w) => w.startsWith(t)))) return 0.4;
  if (q.tokens.every((t) => c.words.some((w) => w.startsWith(t) || fuzzyWordMatch(t, w)))) {
    return 0.3;
  }
  if (c.text.includes(q.text)) return 0.25;
  return 0;
}

/**
 * A query token counts as a typo of a candidate word when it is long enough
 * that one slip is unlikely to turn it into a different word: 5+ letters
 * within one edit, 8+ letters within two. Never for short tokens — campus
 * initialisms are three letters apart from each other ("som"/"sml"/"sss"),
 * so "sss" must not become "sass" and "som" must not become "some".
 */
export function fuzzyWordMatch(token: string, word: string): boolean {
  if (token.length < 5) return false;
  const maxEdits = token.length >= 8 ? 2 : 1;
  if (Math.abs(token.length - word.length) > maxEdits) return false;
  return damerauLevenshtein(token, word, maxEdits) <= maxEdits;
}

/**
 * Optimal-string-alignment distance (insert, delete, substitute, and swap two
 * adjacent letters — the typo "peobody" is one swap from "peabody"). Returns
 * early with `limit + 1` once no alignment can come in under `limit`.
 */
export function damerauLevenshtein(a: string, b: string, limit: number): number {
  const n = a.length;
  const m = b.length;
  if (n === 0) return m;
  if (m === 0) return n;
  let prev2: number[] = [];
  let prev: number[] = Array.from({ length: m + 1 }, (_, j) => j);
  for (let i = 1; i <= n; i++) {
    const cur: number[] = new Array<number>(m + 1);
    cur[0] = i;
    let rowMin = i;
    for (let j = 1; j <= m; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        v = Math.min(v, prev2[j - 2]! + 1);
      }
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > limit) return limit + 1;
    prev2 = prev;
    prev = cur;
  }
  return prev[m]!;
}
