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

// Trim geocoder verbosity for the suggestion dropdown: Nominatim returns
// "Indian River, Forest Heights, Fort Trumbull, Milford, South Central
// Connecticut Planning Region, Connecticut, United States" — two segments
// carry all the signal on a phone-width row.
export function suggLabel(g: GeocodeResult, siblings?: GeocodeResult[]): string {
  const parts = g.display_name.split(",").map((s) => s.trim()).filter(Boolean);
  const short = parts.slice(0, 2).join(", ");
  if (!siblings) return short;
  // Two distinct results can share their first two segments ("Chapel Street,
  // New Haven" for both ends of a long street), which renders as duplicate
  // rows the rider cannot choose between. Widen only the colliding ones.
  const collides = siblings.some((o) => o !== g && suggLabel(o) === short);
  return collides ? (parts.slice(0, 3).join(", ") || short) : short;
}

/** Row icon by result kind so stops and landmarks are scannable at a glance. */
export function suggIcon(g: GeocodeResult): string {
  if (g.type === "bus_stop") return "🚏";
  if (g.class === "yale") return "🏛️";
  return "📍";
}
