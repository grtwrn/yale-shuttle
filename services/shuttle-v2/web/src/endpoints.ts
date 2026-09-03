// The two ends of a trip: what the From/To boxes hold, and whether the planner
// can actually use them yet.
//
// A box holds TEXT, which is what the rider typed, and separately a COORD,
// which only exists once that text has been resolved to a place (a suggestion
// picked, or an unambiguous search). The planner needs the coord; the rider
// only ever sees the text. When those two disagree the screen looks finished
// and nothing happens — report #84, "changin start location doesn't research
// coorectly": the operator typed "517 Prospect St" into From after a
// geolocation timeout, and the app planned nothing and said nothing, because
// the typed text had never become a coordinate.

/**
 * What the From box reads after the rider taps 📍. It is a sentinel, not a
 * geocoded place: the origin should keep tracking live GPS while they walk.
 * The live-origin checks used to test `!fromText`, which is only true when the
 * box is BLANK — so tapping 📍 (which fills in this text) silently froze the
 * origin at the first fix, the exact bug report #19 was about.
 */
export const CURRENT_LOCATION_TEXT = "Current location";

/** Blank or the 📍 sentinel — either way, not a place the rider typed. */
export const isCurrentLocationText = (t: string): boolean =>
  !t || t === CURRENT_LOCATION_TEXT;

/** One end of the trip as the search form holds it. */
export type Endpoint = {
  /** What is in the box. */
  text: string;
  /** Whether that text has been resolved to a coordinate the planner can use. */
  hasCoord: boolean;
};

export type EndpointField = "from" | "to";

/**
 * The end the rider has typed but not yet settled on a place for, or null when
 * both ends are either resolved or empty.
 *
 * The From box is the one this exists for: a rider who types a start and taps
 * away has changed nothing as far as the planner is concerned, and until
 * report #84 the screen said so in no way at all — no options, no message,
 * just the home screen with their address sitting in the box.
 *
 * The destination is named first when both are pending, because there is no
 * trip to plan without one.
 */
export function unresolvedEndpoint(from: Endpoint, to: Endpoint): EndpointField | null {
  const pending = (e: Endpoint) => !e.hasCoord && !isCurrentLocationText(e.text.trim());
  if (pending(to)) return "to";
  if (pending(from)) return "from";
  return null;
}

/**
 * What to tell the rider about it. The list is already on screen (or one
 * keystroke away), so the instruction is to choose from it — not an error,
 * because nothing has gone wrong yet.
 */
export function unresolvedEndpointHint(which: EndpointField): string {
  return which === "to"
    ? "Pick a destination from the list to see trips."
    : "Pick a start from the list to see trips.";
}
