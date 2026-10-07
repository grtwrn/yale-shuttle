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
  /** The curated place's OSM category ("pizza", "library"), for its icon. */
  poi?: string;
  /** Set when the best match came through an alias rather than the label. */
  viaAlias?: true;
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
      ...(l.poi ? { poi: l.poi } : {}),
    }));
  }

  const hits = search(network, query, landmarks);
  if (hits.length > 0) return hits;
  // Nothing matched as typed: try the other readings of what the rider may
  // have meant, most literal first, and answer with the first that finds
  // anything. Only ever when the query found NOTHING, so no answer the
  // matcher already gives can move.
  for (const { text, minScore } of fallbackQueries(rawQuery)) {
    const q = parseQuery(text);
    if (q === null) continue;
    const found = search(network, q, landmarks).filter((h) => h.score >= minScore);
    if (found.length > 0) return found;
  }
  // Last, a misspelling past the fuzzy tier ({@link scoreTypo}), of a curated
  // place only. Streets are the map providers' job, and a curated place or a
  // stop (named for its streets) that merely sounds like the street would be
  // picked on Enter instead: so never for a query with a number or a street
  // word in it ("orange ave" is not Orange / Avon, "starr st" not the Apple
  // Store), and never a stop ("whiten" is not Whitney Avenue). A guess that
  // fits three places or more is a common word, not a name: "century" is a
  // slip of every "center".
  if (/\d/.test(rawQuery) || query.text.split(" ").some((w) => STREET_WORDS.has(w))) return [];
  const known = knownWords(network, landmarks);
  const guesses = search(network, query, landmarks, (q, c) => scoreTypo(q, c, known), false);
  return guesses.length <= MAX_TYPO_PLACES ? guesses : [];
}

/**
 * Every word the curated places, their aliases and the stops are named with.
 * {@link scoreTypo} never reads one of them as a slip of another: "green
 * hill" is a road, not Green Hall.
 */
function knownWords(network: TransitNetwork, landmarks: readonly Landmark[]): Set<string> {
  const known = new Set<string>();
  const names = [
    ...landmarks.flatMap((l) => [l.label, ...(l.aliases ?? [])]),
    ...[...network.stops.values()].map((s) => s.name),
  ];
  for (const name of names) {
    for (const w of normalizeName(name).split(" ")) known.add(w);
  }
  return known;
}

/**
 * Two: Willoughby's has two cafes, and "binekie" also reaches Woolsey Hall
 * through its "beinecke plaza" alias.
 */
const MAX_TYPO_PLACES = 2;

/** Street types and their usual abbreviations and slips, for {@link geocode}. */
const STREET_WORDS = new Set([
  "st", "str", "street", "stret", "streat", "ave", "av", "aven", "avenu", "avenue", "rd", "road",
  "dr", "drive", "ln", "lane", "ct", "court", "pl", "place", "sq", "square", "ter", "terrace",
  "way", "blvd", "boulevard", "pkwy", "parkway", "hwy", "highway", "cir", "circle",
]);

/**
 * The least a hit from a guessed reading must score: the word-prefix tier
 * (0.5), less the 1% the other reading's tie-break can take off
 * ({@link scoreMatch}). Below it are the any-order, fuzzy and substring
 * tiers, which a guess is too loose for. "2 prospect st, new haven, ct
 * 06511" guessed as "2 prospect" prefixes 225 Prospect by house number, and
 * the map picks a curated place on Enter, so the rider went to Chemistry
 * instead of the house the providers find (review of PR #362).
 */
const GUESS_MIN_SCORE = 0.49;

function search(
  network: TransitNetwork,
  query: Query,
  landmarks: readonly Landmark[],
  scoreOf: (q: Query, c: Candidate) => number = scoreMatch,
  withStops = true,
): GeocodeHit[] {
  const out: GeocodeHit[] = [];
  // A street address is an alias too ("85 howe", "1000 chapel"), but only
  // when the rider is typing an address: without a number in the query, the
  // street word alone would pull every cafe on Chapel Street into a search
  // for the Chapel stops (review finding, 2026-09-02).
  // A bare number is a stop ("800" is Building 800), not an address.
  // Either reading may carry the address: "333cedar" is one token collapsed
  // and "333 cedar" spaced.
  const queryHasNumber = [query, query.spaced].some((r) =>
    r !== undefined && /\d/.test(r.text) && r.tokens.length >= 2);
  for (const l of landmarks) {
    // A landmark answers to its label AND every alias, and the best of them
    // counts: "kbt" must rank Kline Tower exactly as "kline tower" does.
    let score = scoreOf(query, candidate(l.label));
    const labelScore = score;
    for (const name of l.aliases ?? []) {
      if (score === 1) break;
      if (!queryHasNumber && /^\d+ /.test(name)) continue;
      score = Math.max(score, scoreOf(query, candidate(name)));
    }
    if (score > 0) {
      out.push({
        label: l.label, lat: l.lat, lon: l.lon, kind: "landmark", score,
        ...(l.poi ? { poi: l.poi } : {}),
        ...(labelScore < score ? { viaAlias: true as const } : {}),
      });
    }
  }
  for (const stop of withStops ? network.stops.values() : []) {
    const score = scoreOf(query, candidate(stop.name));
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

  // At equal score a stop outranks a landmark: "york" is a request for the
  // York Street stops, and a landmark that only mentions the street in an
  // alias must not take the row from them.
  // ...and a match on the label outranks one through an alias: "sterlin"
  // is Sterling Memorial Library before the three places whose alias merely
  // mentions Sterling.
  const kindRank = (h: GeocodeHit) => (h.kind === "stop" ? 0 : 1);
  const aliasRank = (h: GeocodeHit) => (h.viaAlias ? 1 : 0);
  out.sort((a, b) =>
    b.score - a.score || kindRank(a) - kindRank(b) || aliasRank(a) - aliasRank(b) ||
    a.label.localeCompare(b.label));

  // A curated landmark that IS a shuttle stop (the grocery destinations sit on
  // the stops' own coordinates) would otherwise appear twice — a rider typing
  // "trader joes" saw two identical options. When a landmark and a stop share
  // a spot, the LANDMARK survives regardless of score: its label carries more
  // information ("Trader Joe's (Milford)" vs "Trader Joe's"), and several
  // curated entries sit on their serving stops by design (SOM, Divinity).
  // "Regardless of score" is the wrong rule, though: with 148 landmarks,
  // most sit inside some stop's box, and "howe" lost the Howe / Edgewood
  // stop to Mamoun's (alias "85 howe"), which the frontend then auto-picked.
  // The list is sorted by score, so the first of a twin pair is the better
  // match; the landmark takes the row when it scores better, or scores the
  // same AND sits on the stop itself (within ~40 m: SOM, Peabody, the
  // groceries). At equal score from further away it is a different place
  // that happens to share the block — College Street Music Hall is 59 m from
  // College / Crown and must not answer "college st" in the stop's place.
  // Two STOPS on one corner ((N)/(S) platforms, "Audubon / Orange" beside
  // "Orange / Audobon") collapse to one row too — the planner picks the
  // platform, the rider only needs the corner. Two LANDMARKS never merge:
  // the verified list keeps distinct places that share a block (a cafe in
  // the British Art Center's ground floor, the Apple Store beside the Yale
  // Bookstore), and folding them would hide the label the rider typed.
  // ~40 m: a landmark placed on its serving stop, not merely on the block.
  const onTheStop = (a: GeocodeHit, b: GeocodeHit) =>
    Math.abs(a.lat - b.lat) < 3.6e-4 && Math.abs(a.lon - b.lon) < 4.8e-4;
  const near = (a: GeocodeHit, b: GeocodeHit) =>
    !(a.kind === "landmark" && b.kind === "landmark") &&
    Math.abs(a.lat - b.lat) < 6e-4 && Math.abs(a.lon - b.lon) < 8e-4;
  const deduped: GeocodeHit[] = [];
  for (const h of out) {
    const twinIdx = deduped.findIndex((k) => near(k, h));
    if (twinIdx === -1) deduped.push(h);
    else if (
      h.kind === "landmark" && deduped[twinIdx]!.kind === "stop" &&
      (h.score > deduped[twinIdx]!.score ||
        (h.score === deduped[twinIdx]!.score && onTheStop(h, deduped[twinIdx]!)))
    ) deduped[twinIdx] = h;
  }
  return deduped.slice(0, MAX_RESULTS);
}

/**
 * The readings {@link geocode} tries when a query found nothing (2026-10-03
 * search-gap audit: rider searches that returned nothing for places the app
 * has):
 *
 *  - invisible characters as word breaks, which is how they were read before
 *    they were deleted, so "union\u200bstation" (a zero-width space between the
 *    words) still finds the station;
 *  - a word typed in pieces put back together: "e l m", "union s ta",
 *    "trader j o". Runs of one- and two-letter fragments are joined; a
 *    fragment is never glued onto a whole word, because the fuzzy tier then
 *    reads "td college" as "tdcollege", two edits from every "college";
 *  - the street address inside a longer query: "corner grove 258 church st
 *    new haven ct 06510" is the place at 258 Church St. It answers only
 *    with a place named exactly "<number> <street>": "100 church" merely
 *    prefixes the stop 100 Church Street South, 730 m from 100 Church St,
 *    and a stopword street ("1 yale ave") would leave a bare number that
 *    prefixes anything starting with it (review of PR #362, round 2).
 *
 * The first is how master read the query, so any hit counts; the other two
 * are guesses and count only from {@link GUESS_MIN_SCORE} up.
 */
function fallbackQueries(raw: string): { text: string; minScore: number }[] {
  const typed = normalizeName(raw);
  const out: { text: string; minScore: number }[] = [];
  if (/\p{Cf}/u.test(raw)) out.push({ text: raw.replace(/\p{Cf}/gu, " "), minScore: 0 });
  out.push({
    text: typed.replace(/\b([a-z]{1,2}) (?=[a-z]{1,2}\b)/g, "$1"),
    minScore: GUESS_MIN_SCORE,
  });
  const address = [...typed.matchAll(/(?:^| )(\d{1,5}) ([a-z]+)(?= |$)/g)]
    .find((m) => !STOPWORDS.has(m[2]!));
  // 0.99, not 1: one reading can tie-break an exact hit down to 0.99+.
  if (address) out.push({ text: `${address[1]} ${address[2]}`, minScore: 0.99 });
  // A numbered "Hill House" address can name the known Hillhouse alias,
  // but never a bare name or another street. Like the address reading above,
  // require an exact hit: 5 Hill House must not prefix 55 Hillhouse.
  const hillhouse = /^(\d{1,5}) hill house(?: (?:ave|avenue))?(?: new haven(?: ct)?(?: \d{5})?)?$/.exec(typed);
  if (hillhouse) out.push({ text: hillhouse[1] + " hillhouse", minScore: 0.99 });
  return out.filter(({ text }, i) =>
    normalizeName(text) !== typed && out.findIndex((o) => o.text === text) === i);
}

// -- Normalisation ------------------------------------------------------------

/**
 * Both sides of every comparison go through this, so a rider's spelling and
 * the upstream name only have to agree after the noise is gone.
 */
export function normalizeName(s: string): string {
  return normalize(s, true);
}

/**
 * The spaced reading, with every dot a space and every "&" an "and": how the
 * matcher read names before stylised names were collapsed. Initials typed
 * with dots need it — "t.d. college" is "t d college", whose tokens prefix
 * "Timothy Dwight College"; collapsed to "td college" it matched nothing, as
 * the "td" alias has no "college" (review of PR #341).
 *
 * It also parts a house number from the word it was typed against:
 * "333cedar" is "333 cedar" ({@link splitGluedNumbers}).
 */
function spacedName(s: string): string {
  return normalize(s, false);
}

/**
 * A number glued to a word of three or more letters, either way round, gets
 * its space back: "272elm", "elm272", "333cedar", "lot16" found nothing
 * while "272 elm" and "333 cedar" worked (2026-10-03 search-gap audit).
 * Three letters, so a name like "M2" and an ordinal like "4th" or "21st"
 * stay whole; whole words only, so "one6three" does too. `v1compat.ts`
 * sends the external providers the same reading.
 */
export function splitGluedNumbers(s: string): string {
  return s
    .replace(/\b(\d{1,5})([a-z]{3,})\b/gi, "$1 $2")
    .replace(/\b([a-z]{3,})(\d{1,5})\b/gi, "$1 $2");
}

function normalize(s: string, collapse: boolean): string {
  let t = s
    .toLowerCase()
    // Apostrophes are deleted, not collapsed to spaces: "Joe's" must equal
    // "Joes", not "joe s" — a rider typing without the apostrophe found
    // nothing (report #45), and the operator hit the same wall with
    // "elenas" on 2026-09-02.
    .replace(/['‘’]/g, "")
    // So are invisible formatting characters (zero-width space and joiners,
    // word joiner, BOM, soft hyphen): "u\u200bnion" found nothing while
    // "union" found the station, because the space they became split the
    // word in two (2026-10-03 search-gap audit). A rider cannot see them, so
    // they cannot mean anything.
    .replace(/\p{Cf}/gu, "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  if (collapse) {
    // A dot or ampersand INSIDE a short stylised name is deleted: riders
    // type "bbq" for "bb.q Chicken", "at&t" for "AT&T", "mt bank" for
    // "M&T Bank" — and "h&k" must not become "h and k", two one-letter
    // tokens that prefix-match AKW and Kroon. Only between runs of 1–3
    // letters, so a spaced "Stop & Shop" and a long "Artist&Craftsman"
    // still read as "and" (2026-09-30 search-gap audit).
    t = t.replace(/(?<![a-z])([a-z]{1,3})[.&](?=[a-z]{1,3}(?![a-z]))/g, "$1");
  } else {
    t = splitGluedNumbers(t);
  }
  return (
    t
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
  /** The spaced reading ({@link spacedName}), when it differs. */
  spaced?: Query;
}

function parseQuery(raw: string): Query | null {
  const text = normalizeName(raw);
  if (text.length === 0) return null;
  const q = queryOf(text);
  const spaced = spacedName(raw);
  return spaced === text ? q : { ...q, spaced: queryOf(spaced) };
}

function queryOf(text: string): Query {
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
  /** The spaced reading ({@link spacedName}), when it differs. */
  spaced?: Candidate;
}

function candidate(name: string): Candidate {
  const text = normalizeName(name);
  const spaced = spacedName(name);
  const c = { text, words: text.split(" ") };
  return spaced === text ? c : { ...c, spaced: { text: spaced, words: spaced.split(" ") } };
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
/**
 * How well a free-text name answers a rider's query, on the same tiers the
 * curated list is ranked by. `v1compat.ts` uses it to drop an external result
 * whose name has no relationship to what was typed — Photon matched "elenas"
 * to a clothing shop called EbLens.
 */
export function relevanceOf(rawQuery: string, name: string): number {
  const q = parseQuery(rawQuery);
  return q === null ? 0 : scoreMatch(q, candidate(name));
}

/**
 * Both readings are scored and the better counts, so "bbq" finds "bb.q" and
 * "t.d. college" still finds Timothy Dwight. When they disagree, the other
 * reading breaks the tie (never a tier: it moves the score by under 0.01), so
 * a place both readings find wins: "p&m" is the P&M market ("p and m", "pm
 * market") before Pauli Murray ("pm" alone), and "at&t" is AT&T before
 * Temple / Grove, which only the spaced reading's lone "t" prefixes.
 */
function scoreMatch(q: Query, c: Candidate): number {
  const spaced = scoreForm(q.spaced ?? q, c.spaced ?? c);
  const collapsed = scoreForm(q, c);
  if (spaced === collapsed) return spaced;
  return 0.99 * Math.max(spaced, collapsed) + 0.01 * Math.min(spaced, collapsed);
}

function scoreForm(q: Query, c: Candidate): number {
  const forms = q.stripped.length > 0 && q.stripped !== q.text ? [q.text, q.stripped] : [q.text];
  if (forms.some((f) => c.text === f)) return 1;
  if (forms.some((f) => c.text.startsWith(f))) return 0.75;
  if (forms.some((f) => c.words.some((w) => w.startsWith(f)))) return 0.5;
  if (tokensMatch(q.tokens, c.words, (t, w) => w.startsWith(t))) return 0.4;
  if (tokensMatch(q.tokens, c.words, (t, w) => w.startsWith(t) || fuzzyWordMatch(t, w))) {
    return 0.3;
  }
  if (c.text.includes(q.text)) return 0.25;
  return 0;
}

/**
 * Every token matches some word, in any order ("museum peabody") — unless
 * the query has two or more one-letter tokens. Those are initials, and
 * initials come in the order of the words they stand for: "t d college" is
 * Timothy Dwight College and "j e edwards" Jonathan Edwards, but "ha m d"
 * is not "Dwight Hall & Memorial Chapel", whose words merely begin with
 * those letters in another order (2026-10-03 search-gap audit). A single
 * letter is usually a direction, which riders type anywhere: "bishop &
 * orange n" is Orange / Bishop (N) (review of PR #362).
 */
function tokensMatch(
  tokens: readonly string[],
  words: readonly string[],
  match: (token: string, word: string) => boolean,
): boolean {
  if (tokens.filter((t) => /^[a-z]$/.test(t)).length < 2) {
    return tokens.every((t) => words.some((w) => match(t, w)));
  }
  let from = 0;
  for (const t of tokens) {
    const at = words.findIndex((w, i) => i >= from && match(t, w));
    if (at === -1) return false;
    from = at;
  }
  return true;
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
 * The score of a hit only a misspelling past {@link fuzzyWordMatch} reaches,
 * less a hundredth per edit so the nearest spelling ranks first. Under every
 * tier of {@link scoreForm}, although it never meets them: {@link geocode}
 * asks for it only when nothing else matched.
 */
const TYPO_SCORE = 0.2;

/**
 * How a query that found nothing may still name a place (2026-10-04 search
 * log: "binekie", "willobuys", "will buys", "shwartz", "yale dovin",
 * "sterling low", "divinity schi" all found nothing, and the app has every
 * one). Each query token is an exact prefix of a word of the name, as on the
 * token-prefix tier, or:
 *
 *  - SOUNDS LIKE it: the same first letter and the same consonants
 *    ({@link soundKey}), and from seven letters within two edits in five —
 *    "binekie" is 3 edits from "beinecke" and "willobuys" 4 from
 *    "willoughbys", far past the fuzzy tier, but they are b-n-k and w-l-b-s
 *    alike, while "starr" and "store" are merely s-t-r — or the start of a
 *    longer word still being typed, within one edit (two from seven
 *    letters): "shwartz" is "schwarz(man)". Five or six letters one slip
 *    from the start of a name are as often another word ("steer", "melon",
 *    "style"), so those need another word beside them: "yale dovin" is
 *    "divin(ity)", "dovin" alone is nothing, and so is "edgar new haven"
 *    (a stopword is no context);
 *  - or, from three letters, differs from the start of a word in ONE VOWEL:
 *    "low" is "law", "schi" "scho(ol)". A vowel slip is too little to go on
 *    alone ("lew"), so only beside a word of four or more letters that
 *    matched as typed ("sterling", "divinity"), and never on a consonant
 *    ("sterling lqw") or in two letters: "anlyan to" is not "anlyan ta(c)",
 *    nor "school of py" "school of pu(blic)" ("school of p" finds it).
 *
 * A word some curated place or stop is named with (`known`) is never read
 * as a slip of another: "green hill" is not Green Hall.
 *
 * Two or three words of three or more letters are also read as one word
 * typed in pieces, into a word the first piece starts: "will buys" is
 * "willbuys", which sounds like "willoughbys". Only when the rest adds two
 * consonants or more: "adams usa" sounds like "adams" (the vowels are silent
 * and the s's one), "college sci" like "colleges". Initials ("t d colege")
 * are left alone: their order rule ({@link tokensMatch}) is not worth
 * loosening for a guess.
 */
function scoreTypo(q: Query, c: Candidate, known: ReadonlySet<string>): number {
  if (q.tokens.filter((t) => t.length === 1).length >= 2) return 0;
  // Another real word, or "yale": "new haven", "the" and "in" are no context
  // ("edgar new haven" is Edgar Street, not Edgerton Park).
  const besideAnother = q.tokens.length >= 2 || q.text.split(" ").includes("yale");
  const readings = c.spaced ? [c.words, c.spaced.words] : [c.words];
  const [first, ...rest] = q.tokens;
  const joined = q.tokens.join("");
  const split = rest.length > 0 && rest.length <= 2 && q.tokens.every((t) => t.length >= 3) &&
    soundKey(joined).length >= soundKey(first!).length + 2;
  let edits = Infinity;
  for (const words of readings) {
    edits = Math.min(edits, typoEdits(q.tokens, words, besideAnother, known));
    // A word typed in two: only into a word the first piece starts.
    const started = split ? words.filter((w) => w.startsWith(first!)) : [];
    if (started.length > 0) edits = Math.min(edits, typoEdits([joined], started, besideAnother, known));
  }
  return edits === Infinity ? 0 : TYPO_SCORE - edits / 100;
}

/** The edits {@link scoreTypo} needs to read `tokens` as `words`. */
function typoEdits(
  tokens: readonly string[],
  words: readonly string[],
  besideAnother: boolean,
  known: ReadonlySet<string>,
): number {
  let edits = 0;
  let anchored = false;
  const slips: string[] = [];
  for (const t of tokens) {
    if (words.some((w) => w.startsWith(t))) {
      if (t.length >= 4) anchored = true;
      continue;
    }
    // A word the list itself uses ("hill") is that word, not a slip of another ("hall").
    if (known.has(t)) return Infinity;
    const e = Math.min(...words.map((w) => soundsLike(t, w, besideAnother)));
    if (e === Infinity) slips.push(t);
    else edits += e;
  }
  if (slips.length > 0 && !anchored) return Infinity;
  for (const t of slips) {
    if (!words.some((w) => vowelSlip(t, w))) return Infinity;
    edits += 1;
  }
  return edits === 0 ? Infinity : edits;
}

function soundsLike(token: string, word: string, besideAnother: boolean): number {
  if (token.length < 5 || token[0] !== word[0]) return Infinity;
  const key = soundKey(token);
  if (key.length < 3) return Infinity;
  const wordKey = soundKey(word);
  if (wordKey === key && token.length >= 7) {
    const limit = Math.floor((2 * Math.max(token.length, word.length)) / 5);
    const e = damerauLevenshtein(token, word, limit);
    if (e <= limit) return e;
  }
  if (word.length > token.length && wordKey.startsWith(key) &&
      (token.length >= 7 || besideAnother)) {
    // The start of the word typed so far, give or take a letter.
    const limit = token.length >= 7 ? 2 : 1;
    let e = Infinity;
    for (let n = token.length - 1; n <= token.length + 1; n++) {
      e = Math.min(e, damerauLevenshtein(token, word.slice(0, n), limit));
    }
    if (e <= limit) return e;
  }
  return Infinity;
}

function vowelSlip(token: string, word: string): boolean {
  if (token.length < 3 || word.length < token.length || token[0] !== word[0]) return false;
  const start = word.slice(0, token.length);
  return damerauLevenshtein(token, start, 1) === 1 && soundKey(token) === soundKey(start);
}

/**
 * A word as it sounds, roughly: its first letter, then its consonants with
 * the common English spellings of one sound made one ("ck", "c" before e/i/y,
 * "ph", "sch", "tz", "z") and a silent "gh" dropped, doubles collapsed.
 * "beinecke" and "binekie" are both "bnk"; "willoughbys" and "willobuys"
 * "wlbs".
 */
export function soundKey(word: string): string {
  const s = word
    .replace(/sch/g, "sh")
    .replace(/ck/g, "k")
    .replace(/ph/g, "f")
    .replace(/gh/g, "")
    .replace(/tz/g, "z")
    .replace(/c(?=[eiy])/g, "s")
    .replace(/[cq]/g, "k")
    .replace(/z/g, "s")
    .replace(/x/g, "ks");
  if (s.length === 0) return "";
  return (s[0] + s.slice(1).replace(/[aeiouy]/g, "")).replace(/(.)\1+/g, "$1");
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
