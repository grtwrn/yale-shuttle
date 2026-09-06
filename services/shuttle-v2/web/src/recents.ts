// The places a rider has been to lately — ONE list, read by both ends of the
// trip form.
//
// It began as "recent destinations": a place picked in the To box was
// remembered so the next visit could tap it instead of typing. The operator's
// ask (2026-09-06): "can you add location suggestions when i change start
// location? like seeing my recent list would help." A place used as a
// destination is a natural start next time and vice versa, so the From box
// now reads and writes the same list rather than keeping its own. Each entry
// carries the display name AND the coordinate, so re-selecting it never goes
// back to the geocoder.
//
// The stored shape is the old SavedTrip record (`to*` fields are the place;
// `from*` are unused zeros) — kept verbatim so a rider's existing recents
// survive the upgrade. Every storage touch is guarded: with site data blocked
// `localStorage` throws on ACCESS, and an unguarded read in a state
// initialiser blank-screens the app.

export type SavedTrip = {
  id: string;
  name: string;
  fromText: string; fromLat: number; fromLon: number;
  toText: string; toLat: number; toLon: number;
};

/** A place as either box holds it once resolved. */
export type Place = { text: string; lat: number; lon: number };

export const RECENTS_KEY = "shuttle-recent-trips";
export const RECENTS_MAX = 10;

/** Two coordinates within ~10 m are the same place, whatever they were called. */
export const samePlace = (
  a: { toLat: number; toLon: number },
  b: { toLat: number; toLon: number },
): boolean =>
  Math.abs(a.toLat - b.toLat) < 1e-4 && Math.abs(a.toLon - b.toLon) < 1e-4;

const isEntry = (x: unknown): x is SavedTrip => {
  if (!x || typeof x !== "object") return false;
  const t = x as Record<string, unknown>;
  return typeof t.id === "string"
    && typeof t.toText === "string" && t.toText.trim() !== ""
    && typeof t.toLat === "number" && Number.isFinite(t.toLat)
    && typeof t.toLon === "number" && Number.isFinite(t.toLon);
};

/** Stored recents, most recent first; empty when storage is blocked or junk. */
export function loadRecents(): SavedTrip[] {
  try {
    const raw = localStorage.getItem(RECENTS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    // A malformed row (a hand-edited store, an older shape) is dropped rather
    // than rendered: a name-less row is a blank tap target and a NaN
    // coordinate plans nothing.
    return parsed.filter(isEntry).slice(0, RECENTS_MAX);
  } catch {
    return [];
  }
}

export function saveRecents(list: SavedTrip[]): void {
  try {
    localStorage.setItem(RECENTS_KEY, JSON.stringify(list));
  } catch {
    /* private mode or quota — the list still works for this visit */
  }
}

/**
 * The list after `place` has just been used.
 *
 * Most recent first, one row per coordinate (a place picked under two names
 * keeps the newer name), capped at RECENTS_MAX. Returns the SAME array when
 * the place is already on top, so a caller comparing by reference can skip a
 * write — this runs from an effect on every resolved endpoint.
 */
export function recordRecent(list: SavedTrip[], place: Place, now = Date.now()): SavedTrip[] {
  const key = { toLat: place.lat, toLon: place.lon };
  const top = list[0];
  if (top && samePlace(top, key) && top.toText === place.text) return list;
  const entry: SavedTrip = {
    id: `r${now.toString(36)}`,
    name: place.text,
    fromText: "", fromLat: 0, fromLon: 0,
    toText: place.text, toLat: place.lat, toLon: place.lon,
  };
  return [entry, ...list.filter((t) => !samePlace(t, key))].slice(0, RECENTS_MAX);
}
