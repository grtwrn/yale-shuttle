// Display formatting. Extracted from TransitMap.tsx — small, pure, and the
// place the project's "minutes are spelled `min`, never `m`" rule actually
// lives, so it is worth pinning with tests.

export type GeocodeResult = {
  display_name: string; lat: number; lon: number; type?: string; class?: string;
};

/**
 * Countdown to an event. Floors so "7 min" honestly means "at least 7 min
 * left" (Math.round would call 6:31 "7 min" and then jump to "6 min" at
 * 6:30 — felt stuck). Under 60 s, "<1 min" (the formatEtaRange idiom);
 * under 10 s, just "now". "min" (not "m") everywhere so readers don't
 * confuse it with miles.
 *
 * There used to be an MM:SS branch under 2 min ("1:49"), inherited from v1,
 * meant as a final-approach countdown that ticks each poll. It backfired:
 * the value it was fed is only minute-accurate and can legitimately hold
 * still between polls, so the second-precision display read as a frozen
 * stopwatch (report #48), and it violated the "minutes are spelled min"
 * convention besides. Sub-minute is a state ("<1 min", "now"), not a timer.
 */
/**
 * The next two buses in one breath: "in 1, 11 min".
 *
 * "in 1 min · next in 11 min" did not fit the option row beside the total
 * and the arrival time — at 390px it clipped mid-number — and the operator's
 * fix was the right one (2026-09-03): drop the second label and let the two
 * numbers share the unit. Both times are always shown now, at any ETA.
 *
 * A bus already at the stop has no number to share, so it keeps words.
 */
export function fmtBusPair(firstSec: number, secondSec?: number | null): string {
  const first = fmtMin(firstSec);
  if (secondSec == null || !Number.isFinite(secondSec)) {
    return first === "now" ? "arriving now" : `in ${first}`;
  }
  const second = fmtMin(secondSec);
  if (first === "now") return `now, then ${second}`;
  // "1 min" + "11 min" -> "1, 11 min"; "<1 min" keeps its "<".
  return `in ${first.replace(" min", "")}, ${second}`;
}

export function fmtMin(s: number): string {
  if (s < 10) return "now";
  if (s < 60) return "<1 min";
  return `${Math.floor(s / 60)} min`;
}

/**
 * A live ETA is a snapshot: `etaSec` seconds remaining as of `computedAtMs`.
 * By render time some of it has already elapsed — subtract it (clamped at 0)
 * so the number a rider watches keeps moving even when no fresh poll has
 * landed (report #48: the card sat on one value while the bus visibly
 * approached). Callers without a timestamp get the value unchanged.
 */
export function remainingSec(
  etaSec: number,
  computedAtMs?: number,
  nowMs: number = Date.now(),
): number {
  const elapsed = computedAtMs != null ? Math.max(0, (nowMs - computedAtMs) / 1000) : 0;
  return Math.max(0, etaSec - elapsed);
}

/**
 * Walking estimate — round to nearest minute. A 1:30 walk is "2 min" not
 * "1:30", since sub-minute precision on foot is meaningless and the rider just
 * wants "about N minutes of walking."
 */
export function fmtWalk(s: number): string {
  const m = Math.max(1, Math.round(s / 60));
  return `${m} min`;
}

/**
 * Wait time — floor to minutes. "1:32" of wait becomes "1 min" since the bus
 * won't arrive before that. "0 min" when under a minute so the display reads
 * honestly small.
 */
export function fmtWait(s: number): string {
  const m = Math.max(0, Math.floor(s / 60));
  return `${m} min`;
}

/** Wall-clock time `s` seconds from `from` (default: now), device timezone. */
export function fmtClock(s: number, from?: Date): string {
  const base = from?.getTime() ?? Date.now();
  const d = new Date(base + s * 1000);
  let h = d.getHours();
  const mm = d.getMinutes();
  const ampm = h >= 12 ? "p" : "a";
  h = h % 12; if (h === 0) h = 12;
  return `${h}:${String(mm).padStart(2, "0")}${ampm}`;
}

export function formatEtaRange(a: { eta: number; low: number; high: number }): string {
  const lo = Math.round(a.low / 60);
  if (a.eta < 60) return "<1 min";
  return `${lo} min`;
}

/**
 * The gate every geocode answer passes through before anything renders it.
 *
 * `/api/geocode` merges two providers outside our control (Photon and
 * Nominatim), so a row can arrive with a field missing or of the wrong type —
 * and ONE such row used to take the whole app down: `suggLabel` split
 * `display_name`, `undefined.split` threw during render, and the ErrorBoundary
 * in main.tsx replaced the page with "App crashed — Cannot read properties of
 * undefined (reading 'split')" (found by the canary harness, 2026-09-03). A
 * malformed suggestion must cost the rider that suggestion, never the app.
 *
 * A row has to survive both halves of what the dropdown does with it:
 *
 * - a NAME to show. Without one the row is a blank line the rider cannot tell
 *   from any other, so it is dropped rather than rendered empty. (A name with
 *   no usable segments — "", " , ", null — counts as no name.)
 * - a COORDINATE to travel to. Picking a row sets the trip endpoint, so a row
 *   with no usable lat/lon *looks* like an answer and then plans nothing: NaN
 *   propagates into the distance filter and the planner and every option
 *   silently vanishes. Offering it is worse than never listing it.
 *
 * Failing either test drops the row and the rest of the list still shows; an
 * all-malformed answer degrades to the empty-result path ("No matches found"),
 * which is what the rider would have seen anyway.
 *
 * Numeric strings pass (Nominatim sends lat/lon as strings and the server
 * converts, but the client should not depend on that having happened);
 * `true`, `null` and `""` do not, because `Number()` turns them into 0 — a
 * coordinate in the Gulf of Guinea, which is exactly the plausible-looking
 * nonsense this guard exists to keep out. Out-of-range values go too: a
 * latitude of 500 is not a destination, and Leaflet will happily draw it.
 *
 * `type` and `class` are optional and only steer an icon and the auto-pick, so
 * a non-string one is dropped rather than the whole row.
 */
export function sanitizeGeocodeResults(raw: unknown): GeocodeResult[] {
  if (!Array.isArray(raw)) return [];
  const out: GeocodeResult[] = [];
  for (const row of raw) {
    if (!row || typeof row !== "object") continue;
    const g = row as Partial<Record<keyof GeocodeResult, unknown>>;
    if (typeof g.display_name !== "string" || suggSegments(g.display_name).length === 0) continue;
    const lat = coordOrNull(g.lat, 90);
    const lon = coordOrNull(g.lon, 180);
    if (lat === null || lon === null) continue;
    const hit: GeocodeResult = { display_name: g.display_name, lat, lon };
    if (typeof g.type === "string") hit.type = g.type;
    if (typeof g.class === "string") hit.class = g.class;
    out.push(hit);
  }
  return out;
}

const coordOrNull = (v: unknown, limit: number): number | null => {
  const n = typeof v === "number" ? v
    : typeof v === "string" && v.trim() !== "" ? Number(v)
    : NaN;
  return Number.isFinite(n) && Math.abs(n) <= limit ? n : null;
};

// Trim geocoder verbosity for the suggestion dropdown: Nominatim returns
// "Indian River, Forest Heights, Fort Trumbull, Milford, South Central
// Connecticut Planning Region, Connecticut, United States" — two segments
// carry all the signal on a phone-width row.
//
// Total by construction: every field it reads is treated as possibly absent,
// so this can never be the thing that blank-screens the app again even if a
// caller skips `sanitizeGeocodeResults`. A row with no name renders as "" —
// unreachable through the gate above, which drops it instead.
export function suggLabel(g: GeocodeResult, siblings?: GeocodeResult[]): string {
  const parts = suggSegments(g?.display_name);
  const short = parts.slice(0, 2).join(", ");
  if (!siblings) return short;
  // Two distinct results can share their first two segments ("Chapel Street,
  // New Haven" for both ends of a long street), which renders as duplicate
  // rows the rider cannot choose between. Widen only the colliding ones.
  const collides = siblings.some((o) => o !== g && suggLabel(o) === short);
  if (collides) return parts.slice(0, 3).join(", ") || short;
  // Same business, another town. External hits are built "name, street, city"
  // (parsePhoton), so the town is the third segment — precisely the one the
  // two-part label drops. That left "Trader Joe's, 46 Skiff Street" sitting
  // under the Trader Joe's the shuttle serves with nothing saying it is up in
  // Hamden (report #72). Widen only when a sibling shares the place name and
  // is somewhere else; two branches in one town are told apart by the street.
  const name = suggPlaceName(g?.display_name);
  const town = parts[2];
  const elsewhere = town != null && siblings.some((o) =>
    o !== g
    && suggPlaceName(o?.display_name) === name
    && suggSegments(o?.display_name)[2] !== town);
  return elsewhere ? parts.slice(0, 3).join(", ") : short;
}

/**
 * What kind of place each row is, at a glance. Keyed on `type`, which carries
 * OpenStreetMap's own value for an external result and the same vocabulary
 * for a curated one (`poi` in src/server/landmarks.ts), so one table serves
 * both. A rider scanning for Elena's finds 🍦 faster than the third identical
 * building glyph in a list (operator, 2026-09-03).
 *
 * Every `poi` the server ships must be a key here — `geocode.test.ts` fails
 * otherwise, because a value with no entry falls silently back to the generic
 * glyph this table exists to replace.
 */
export const PLACE_ICONS: Record<string, string> = {
  ice_cream: "🍦", pizza: "🍕", restaurant: "🍽️", cafe: "☕", fast_food: "🍔",
  bakery: "🥐", bar: "🍺", pub: "🍺", biergarten: "🍺", nightclub: "🍺",
  supermarket: "🛒", convenience: "🛒", greengrocer: "🛒", department_store: "🛒",
  pharmacy: "💊", chemist: "💊", books: "📖", shop: "🛍️", clothes: "🛍️",
  library: "📚", museum: "🏛️", gallery: "🏛️", civic: "🏛️", townhall: "🏛️",
  hospital: "🏥", clinic: "🏥", doctors: "🏥", college: "🎓", university: "🎓",
  school: "🎓", park: "🌳", garden: "🌳", theatre: "🎭", cinema: "🎬",
  hotel: "🛏️", station: "🚉", gym: "🏋️", ice_rink: "⛸️",
  worship: "⛪", place_of_worship: "⛪", synagogue: "🕍",
  neighbourhood: "🏙️", bank: "🏦", fuel: "⛽", parking: "🅿️",
};
// `display` is whatever the provider sent, so it is typed as `unknown` and
// checked: this is the exact line the app died on when it was a bare
// `display.split(",")` and Photon (or a stub) omitted the field.
const suggSegments = (display: unknown): string[] =>
  typeof display === "string" ? display.split(",").map((s) => s.trim()).filter(Boolean) : [];

/**
 * The place name two suggestions collide on: the first segment without the
 * parenthetical the curated list uses to qualify a branch ("Trader Joe's
 * (Milford)"), lowercased so casing between providers doesn't split a match.
 */
const suggPlaceName = (display: unknown): string =>
  (suggSegments(display)[0] ?? "").replace(/\s*\([^)]*\)$/, "").trim().toLowerCase();

/** Row icon by result kind so stops and landmarks are scannable at a glance. */
export function suggIcon(g: GeocodeResult): string {
  if (g?.type === "bus_stop") return "🚏";
  // `type` is an upstream string, so read the table by own-property only:
  // PLACE_ICONS["__proto__"] is an object, and React throws on an object
  // child — a blank screen behind the ErrorBoundary.
  const icon = typeof g?.type === "string" && Object.prototype.hasOwnProperty.call(PLACE_ICONS, g.type)
    ? PLACE_ICONS[g.type]
    : undefined;
  if (typeof icon === "string") return icon;
  // A curated place with no category, then anything else (an address, a
  // street, an OSM value we have no icon for).
  if (g?.class === "yale") return "🏛️";
  return "📍";
}
