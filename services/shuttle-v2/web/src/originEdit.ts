import type { LatLon } from "./geo";

/**
 * The From field's rules, pulled out of TransitMap.tsx so they can be tested.
 *
 * Report #84 ("changing start location doesn't research correctly"): typing in
 * the From field clears the locked coordinate, so the trip plan vanishes on the
 * first keystroke and only comes back once a suggestion is committed. Dismiss
 * the suggestion list without committing — Escape does exactly that — and the
 * rider is left with a start typed in, a destination locked, and the first-run
 * home screen underneath: no results and nothing saying why.
 *
 * Two rules live here:
 *  - {@link effectiveOrigin}, the coordinate the planner actually uses;
 *  - {@link unresolvedStartText}, what to offer when the rider has typed a
 *    start that never became a coordinate.
 * And {@link cancelFromEdit}, which says what an abandoned edit goes back to.
 */

/** The placeholder both locate flows write into the field. */
export const CURRENT_LOCATION_TEXT = "Current location";

/** Blank or the locate placeholder — i.e. "wherever I am", not a typed place. */
export function isCurrentLocationText(text: string): boolean {
  return !text || text === CURRENT_LOCATION_TEXT;
}

export interface FromFieldState {
  /** Coordinate locked by an explicit pick, or null while the rider types. */
  picked: LatLon | null;
  /** What the field reads right now. */
  text: string;
  /** Live GPS, when the browser has given us one. */
  gps: LatLon | null;
}

/**
 * The origin the planner should use. An explicit pick always wins; GPS only
 * stands in while the rider has typed nothing. Typed-but-unresolved text is
 * NOT the rider's location, so it yields null rather than quietly planning
 * from somewhere they did not ask for.
 */
export function effectiveOrigin(s: FromFieldState): LatLon | null {
  if (s.picked) return s.picked;
  return s.text ? null : s.gps;
}

/**
 * The start the rider typed but never committed, if that is why there are no
 * trips on screen — the caller offers it back as "Search from “…”". Null
 * whenever something else already explains the empty screen: no destination
 * yet, a lookup in flight, or an origin we do have.
 */
export function unresolvedStartText(s: {
  hasDestination: boolean;
  origin: LatLon | null;
  text: string;
  /** A geocode is in flight, or we are still waiting on a GPS fix. */
  busy: boolean;
}): string | null {
  if (!s.hasDestination || s.origin || s.busy) return null;
  const text = s.text.trim();
  if (isCurrentLocationText(text)) return null;
  return text;
}

/**
 * Escape in the From field is a cancel: it puts back the start the rider had
 * when they opened the editor. Before, it only closed the suggestion list,
 * which left the field holding text that matched no coordinate — the dead end
 * in report #84. With no previous start to restore, fall back to GPS, which is
 * what the field's placeholder has been promising all along.
 */
export function cancelFromEdit(s: {
  previousText: string;
  previousOrigin: LatLon | null;
  gps: LatLon | null;
}): { text: string; origin: LatLon | null } {
  if (s.previousText && s.previousOrigin) {
    return { text: s.previousText, origin: s.previousOrigin };
  }
  return { text: "", origin: s.gps };
}
